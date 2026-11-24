#!/usr/bin/env node
'use strict';

// Two artifacts come out of this script:
//
//   full (default)   keeps `enabledApiProposals` and stamps the manifest with
//                    `+<build>` metadata, so a local install renders reasoning
//                    natively. Built by "npm run package".
//   marketplace      strips `enabledApiProposals` (the gallery rejects any
//                    package that declares proposed APIs) and leaves the
//                    release version untouched. Built by
//                    "npm run package:marketplace".

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const PACKAGE_JSON_FILE = path.join(ROOT, 'package.json');
const BUILD_NUMBER_FILE = path.join(BUILD_DIR, '.build-number');
const BUILD_INFO_FILE = path.join(BUILD_DIR, 'out', 'buildInfo.json');
const DEV_BUILD_MARKER = path.join(BUILD_DIR, '.dev-build');

// @vscode/vsce 4.x declares engines.node >= 22. Older runtimes fail inside vsce
// itself, so the requirement is reported before any build state is touched.
const MIN_NODE_MAJOR = 22;
const PACKAGING_TIMEOUT_MS = 5 * 60 * 1000;

// The manifest version is stamped with semver build metadata for the packaged
// copy only, so the Extensions page shows "0.1.0+N" while the committed
// package.json keeps the release-owned version. The marketplace variant
// instead removes `enabledApiProposals`, which the gallery rejects. Restoring
// the manifest is best-effort on any exit path, including a failed or
// interrupted vsce run.
let restoreManifest = null;

function restoreManifestFile() {
    if (!restoreManifest) {
        return;
    }
    const restore = restoreManifest;
    restoreManifest = null;
    try {
        restore();
    } catch (error) {
        console.error(`build-vsix: failed to restore package.json: ${error instanceof Error ? error.message : error}`);
    }
}

// A stamp written by a run that never produced a VSIX would make the next dev
// session report a build that does not exist, so the stamp is only kept when
// packaging succeeds.
let packaged = false;
process.on('exit', () => {
    if (!packaged) {
        fs.rmSync(BUILD_INFO_FILE, { force: true });
    }
    restoreManifestFile();
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
        restoreManifestFile();
        process.exit(1);
    });
}

function fail(message) {
    console.error(`build-vsix: ${message}`);
    process.exit(1);
}

function checkResult(result) {
    if (result.error) {
        fail(result.error.message);
    }
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function run(command, args) {
    checkResult(cp.spawnSync(command, args, {
        cwd: ROOT,
        stdio: 'inherit'
    }));
}

function assertSupportedNode() {
    const major = Number.parseInt(process.versions.node.split('.')[0], 10);
    if (major < MIN_NODE_MAJOR) {
        fail(`Node ${process.versions.node} cannot run @vscode/vsce, which requires Node >= ${MIN_NODE_MAJOR}. Put a newer Node first on PATH and re-run.`);
    }
}

function resolveVsceCli() {
    try {
        const manifestPath = require.resolve('@vscode/vsce/package.json', { paths: [ROOT] });
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.vsce;
        if (!bin) {
            return null;
        }
        const cli = path.join(path.dirname(manifestPath), bin);
        return fs.existsSync(cli) ? cli : null;
    } catch {
        return null;
    }
}

// Packaging used to go through npx, so every build needed a registry lookup;
// when that fetch stalled on a half-broken network the script sat on this step
// with no output. The pinned dev dependency removes the network from a build,
// and the timeout keeps a stuck child from looking like a hang.
function packageVsix(vsixPath) {
    const vsceCli = resolveVsceCli();
    if (!vsceCli) {
        fail('@vscode/vsce is not installed. Run "npm install" and re-run.');
    }
    const result = cp.spawnSync(process.execPath, [
        vsceCli,
        'package',
        '--out', vsixPath,
        '--allow-missing-repository'
    ], {
        cwd: ROOT,
        stdio: 'inherit',
        timeout: PACKAGING_TIMEOUT_MS
    });
    if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
            const budget = PACKAGING_TIMEOUT_MS >= 60000
                ? `${PACKAGING_TIMEOUT_MS / 60000} minutes`
                : `${PACKAGING_TIMEOUT_MS / 1000} seconds`;
            fail(`vsce did not finish within ${budget} and was terminated.`);
        }
        fail(result.error.message);
    }
    if (result.signal) {
        fail(`vsce was terminated by ${result.signal} before it finished.`);
    }
    checkResult(result);
}

function gitCommit() {
    const result = cp.spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        return undefined;
    }
    const commit = (result.stdout || '').trim();
    return commit.length > 0 ? commit : undefined;
}

function highestPackagedBuildNumber() {
    let highest = 0;
    for (const name of fs.readdirSync(BUILD_DIR)) {
        const match = /\+(?:build)?(\d+)(?:-[a-z]+)?\.vsix$/i.exec(name);
        if (match) {
            highest = Math.max(highest, Number.parseInt(match[1], 10));
        }
    }
    return highest;
}

function previousBuildNumber() {
    try {
        const parsed = Number.parseInt(fs.readFileSync(BUILD_NUMBER_FILE, 'utf8').trim(), 10);
        if (Number.isInteger(parsed) && parsed >= 0) {
            return parsed;
        }
    } catch {
        // Counter missing or unreadable; recover the high-water mark from packaged artifacts.
    }
    return highestPackagedBuildNumber();
}

function nextBuildNumber(bump) {
    const previous = previousBuildNumber();
    return bump ? previous + 1 : previous;
}

function commitBuildNumber(buildNumber) {
    fs.writeFileSync(BUILD_NUMBER_FILE, `${buildNumber}\n`, 'utf8');
}

function writeBuildInfo(pkg, buildNumber) {
    const info = {
        name: pkg.name,
        version: pkg.version,
        buildNumber,
        commit: gitCommit() ?? null,
        builtAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(BUILD_INFO_FILE), { recursive: true });
    fs.writeFileSync(BUILD_INFO_FILE, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

// Only the "version" value is rewritten so the rest of the manifest stays
// byte-identical to what the repository tracks.
function stampManifestVersion(pkg, buildNumber) {
    const stamped = packageJsonSource.replace(
        /("version"\s*:\s*")([^"]*)(")/,
        (_match, prefix, _version, suffix) => `${prefix}${pkg.version}+${buildNumber}${suffix}`
    );
    if (stamped === packageJsonSource) {
        fail('package.json has no "version" field to stamp.');
    }
    writePackagedManifest(stamped);
}

// The gallery rejects any manifest that declares proposed APIs. Re-serializing
// is safe here because the manifest is machine-written with two-space
// indentation, so the packaged copy differs only by the removed field — and it
// cannot produce invalid JSON the way hand-rolled text surgery can.
function stripEnabledApiProposals(source) {
    let manifest;
    try {
        manifest = JSON.parse(source);
    } catch (error) {
        fail(`package.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
    }

    if (!('enabledApiProposals' in manifest)) {
        return source;
    }

    delete manifest.enabledApiProposals;
    console.log('Removed enabledApiProposals from the packaged manifest.');
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

function writePackagedManifest(packaged) {
    fs.writeFileSync(PACKAGE_JSON_FILE, packaged, 'utf8');
    restoreManifest = () => fs.writeFileSync(PACKAGE_JSON_FILE, packageJsonSource, 'utf8');
}

const bumpBuildNumber = !process.argv.slice(2).includes('--no-bump');
const marketplaceBuild = process.argv.slice(2).includes('--marketplace');

assertSupportedNode();

fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.rmSync(BUILD_INFO_FILE, { force: true });

const packageJsonSource = fs.readFileSync(PACKAGE_JSON_FILE, 'utf8');
const pkg = JSON.parse(packageJsonSource);
const buildNumber = nextBuildNumber(bumpBuildNumber);
const variantSuffix = marketplaceBuild ? '-marketplace' : '';
const vsixPath = path.join(BUILD_DIR, `${pkg.name}-${pkg.version}+${buildNumber}${variantSuffix}.vsix`);

console.log(`=== Build #${buildNumber}: ${pkg.name} ${pkg.version} (${marketplaceBuild ? 'marketplace' : 'full'}) ===`);

console.log('=== Compiling TypeScript ===');
run(process.execPath, [TSC, '-p', '.']);

console.log('=== Stamping build info ===');
writeBuildInfo(pkg, buildNumber);

if (marketplaceBuild) {
    console.log('=== Stripping enabledApiProposals for the Marketplace ===');
    writePackagedManifest(stripEnabledApiProposals(packageJsonSource));
} else {
    console.log(`=== Stamping manifest version ${pkg.version}+${buildNumber} ===`);
    stampManifestVersion(pkg, buildNumber);
}

console.log('=== Packaging VSIX ===');
packageVsix(vsixPath);

const { size } = fs.statSync(vsixPath);
restoreManifestFile();
commitBuildNumber(buildNumber);
packaged = true;
fs.rmSync(DEV_BUILD_MARKER, { force: true });

console.log('=== Done ===');
console.log(`Build #${buildNumber}: ${vsixPath} (${(size / (1024 * 1024)).toFixed(2)} MB)`);