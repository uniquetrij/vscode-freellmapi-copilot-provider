#!/usr/bin/env node
'use strict';

// Publishes the gallery-safe variant to the Visual Studio Marketplace.
//
// The Marketplace refuses any package that declares `enabledApiProposals`, so
// this script never uploads the local/dev VSIX. It bumps the version from
// conventional commits, builds the marketplace variant (which strips proposed
// APIs), re-reads `extension/package.json` out of the produced archive to prove
// the upload is clean, and only then hands the file to `vsce publish`.
//
// Usage: node scripts/build_install/publish-vsix.js [--dry-run] [--no-bump] [--oidc] [--pat <token>]
//
// Authentication, in order of preference:
//   --oidc   trusted publishing; only works inside GitHub Actions (.github/workflows/publish.yml)
//   --pat    a Marketplace Personal Access Token, or the VSCE_PAT environment variable
// A dry run needs no credentials.

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');
const PACKAGE_JSON_FILE = path.join(ROOT, 'package.json');
const BUILD_VSIX_SCRIPT = path.join(__dirname, 'build-vsix.js');
const VERSION_BUMP_SCRIPT = path.join(ROOT, 'scripts', 'version-bump.js');

const PUBLISH_TIMEOUT_MS = 10 * 60 * 1000;

function fail(message) {
    console.error(`publish-vsix: ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const options = { dryRun: false, bump: true, oidc: false, pat: null };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--no-bump') {
            options.bump = false;
        } else if (arg === '--oidc') {
            options.oidc = true;
        } else if (arg === '--pat') {
            options.pat = argv[++i];
        } else if (arg.startsWith('--pat=')) {
            options.pat = arg.slice('--pat='.length);
        } else {
            fail(`unknown argument: ${arg}`);
        }
    }

    if (options.oidc && options.pat) {
        fail('--oidc and --pat are mutually exclusive.');
    }

    return options;
}

function readVersion() {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_FILE, 'utf8')).version;
}

function runNode(script, args) {
    const result = cp.spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
    if (result.error) {
        fail(result.error.message);
    }
    return result.status ?? 1;
}

function newestMarketplaceVsix() {
    if (!fs.existsSync(BUILD_DIR)) {
        return null;
    }

    const files = fs.readdirSync(BUILD_DIR)
        .filter((name) => /-marketplace\.vsix$/i.test(name))
        .map((name) => {
            const filePath = path.join(BUILD_DIR, name);
            return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return files.length > 0 ? files[0].filePath : null;
}

// A VSIX is a plain zip; reading a single entry keeps the release check
// dependency free and inspects the exact bytes that would be uploaded.
function readZipEntry(zipPath, entryName) {
    const buffer = fs.readFileSync(zipPath);

    let eocd = buffer.length - 22;
    while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) {
        eocd -= 1;
    }
    if (eocd < 0) {
        return null;
    }

    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);

    for (let i = 0; i < entryCount; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            return null;
        }
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

        if (name === entryName) {
            const localNameLength = buffer.readUInt16LE(localOffset + 26);
            const localExtraLength = buffer.readUInt16LE(localOffset + 28);
            const start = localOffset + 30 + localNameLength + localExtraLength;
            const data = buffer.subarray(start, start + compressedSize);
            return method === 0 ? data : zlib.inflateRawSync(data);
        }

        offset += 46 + nameLength + extraLength + commentLength;
    }

    return null;
}

function assertGallerySafe(vsixPath) {
    const entry = readZipEntry(vsixPath, 'extension/package.json');
    if (!entry) {
        fail(`could not read extension/package.json from ${path.basename(vsixPath)}`);
    }

    let manifest;
    try {
        manifest = JSON.parse(entry.toString('utf8'));
    } catch (error) {
        fail(`extension/package.json in ${path.basename(vsixPath)} is not valid JSON: ${error instanceof Error ? error.message : error}`);
    }

    const proposals = manifest.enabledApiProposals;
    if (Array.isArray(proposals) && proposals.length > 0) {
        fail(`${path.basename(vsixPath)} still declares proposed APIs (${proposals.join(', ')}); the gallery would reject it.`);
    }

    console.log(`Verified ${path.basename(vsixPath)}: ${manifest.publisher}.${manifest.name}@${manifest.version}, no proposed APIs.`);
    return manifest;
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

function publish(vsixPath, { oidc, pat }) {
    const vsceCli = resolveVsceCli();
    if (!vsceCli) {
        fail('@vscode/vsce is not installed. Run "npm install" and re-run.');
    }

    const args = [vsceCli, 'publish', '--packagePath', vsixPath];
    if (oidc) {
        args.push('--oidc');
    }

    const result = cp.spawnSync(process.execPath, args, {
        cwd: ROOT,
        stdio: 'inherit',
        timeout: PUBLISH_TIMEOUT_MS,
        env: oidc ? process.env : { ...process.env, VSCE_PAT: pat }
    });

    if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
            fail(`vsce publish did not finish within ${PUBLISH_TIMEOUT_MS / 60000} minutes.`);
        }
        fail(result.error.message);
    }
    if (result.signal) {
        fail(`vsce publish was terminated by ${result.signal} before it finished.`);
    }
    if ((result.status ?? 1) !== 0) {
        fail(`vsce publish failed with exit code ${result.status}.`);
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const pat = options.pat || process.env.VSCE_PAT || null;

    if (!options.dryRun && !options.oidc && !pat) {
        fail([
            'no Marketplace credentials. Pass --oidc (GitHub Actions), or --pat <token> / VSCE_PAT.',
            '  Trusted publishing needs the policy registered under the publisher\'s "Trusted Publishing"',
            '  tab and only works inside GitHub Actions (.github/workflows/publish.yml).',
            '  A Personal Access Token needs the Marketplace "Manage" scope.'
        ].join('\n'));
    }

    if (options.oidc && !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
        console.warn('publish-vsix: warning: --oidc outside GitHub Actions usually fails; no OIDC token endpoint is set.');
    }

    const previousVersion = readVersion();

    if (options.bump) {
        console.log('=== Bumping the version from conventional commits ===');
        if (runNode(VERSION_BUMP_SCRIPT, []) !== 0) {
            fail('version bump failed.');
        }
        if (readVersion() === previousVersion) {
            fail([
                `version is still ${previousVersion}; nothing was published.`,
                '  Commits since the last release carried no releasable type (feat/fix/perf/revert).',
                '  Force a level with "node scripts/version-bump.js --bump patch", or publish the current',
                '  version unchanged with "npm run publish:marketplace -- --no-bump".'
            ].join('\n'));
        }
    } else {
        console.log(`=== Publishing the current version ${previousVersion} unchanged ===`);
    }

    const version = readVersion();

    console.log('=== Building the marketplace variant ===');
    if (runNode(BUILD_VSIX_SCRIPT, ['--marketplace', '--no-bump']) !== 0) {
        fail('marketplace packaging failed.');
    }

    const vsixPath = newestMarketplaceVsix();
    if (!vsixPath) {
        fail('no *-marketplace.vsix was produced in ./build.');
    }

    const manifest = assertGallerySafe(vsixPath);
    if (manifest.version !== version) {
        fail(`${path.basename(vsixPath)} reports ${manifest.version} but package.json says ${version}.`);
    }

    if (options.dryRun) {
        console.log('');
        console.log('=== Dry run ===');
        console.log(`Would upload ${vsixPath} as ${manifest.publisher}.${manifest.name}@${manifest.version}.`);
        console.log('Nothing was published. Re-run without --dry-run to upload.');
        return;
    }

    console.log('=== Publishing to the Marketplace ===');
    publish(vsixPath, options);

    console.log('');
    console.log(`Published ${manifest.publisher}.${manifest.name}@${manifest.version}.`);
    console.log('');
    if (!options.oidc) {
        console.log('=== Next steps ===');
        console.log('  git add package.json CHANGELOG.md');
        console.log(`  git commit -m "chore(release): v${manifest.version}"`);
        console.log(`  git tag -a v${manifest.version} -m "v${manifest.version}"`);
        console.log('  git push --follow-tags');
        console.log('  Attach the full VSIX from "npm run package" to the matching GitHub Release');
        console.log('  so reasoning still renders for people who sideload it.');
    }
}

main();
