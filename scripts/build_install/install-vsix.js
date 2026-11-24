#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');

function fail(message) {
    console.error(`install-vsix: ${message}`);
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

function shellQuote(value) {
    if (process.platform === 'win32') {
        return `"${value}"`;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runShell(command) {
    checkResult(cp.spawnSync(command, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true
    }));
}

function newestVsix(preferMarketplace) {
    if (!fs.existsSync(BUILD_DIR)) {
        return null;
    }

    const files = fs.readdirSync(BUILD_DIR)
        .filter((name) => name.endsWith('.vsix'))
        .filter((name) => /-marketplace\.vsix$/i.test(name) === preferMarketplace)
        .map((name) => {
            const filePath = path.join(BUILD_DIR, name);
            return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return files.length > 0 ? files[0].filePath : null;
}

const args = process.argv.slice(2);
// The marketplace variant ships without the proposed API, so reasoning would
// fall back to plain text; local installs default to the full build.
const preferMarketplace = args.includes('--marketplace');
const arg = args.find((value) => !value.startsWith('--'));
const vsixPath = arg
    ? (path.isAbsolute(arg) ? arg : path.join(ROOT, arg))
    : newestVsix(preferMarketplace);

if (!vsixPath) {
    fail(preferMarketplace
        ? 'No *-marketplace.vsix found in ./build. Run "npm run package:marketplace" first.'
        : 'No full .vsix found in ./build. Run "npm run package" first.');
}

if (!fs.existsSync(vsixPath)) {
    fail(`File not found: ${vsixPath}`);
}

if (!arg) {
    console.log(`Using latest VSIX: ${vsixPath}`);
}

if (!/\+(?:build)?\d+(?:-[a-z]+)?\.vsix$/i.test(path.basename(vsixPath))) {
    console.warn('install-vsix: WARNING: this VSIX has no build number; it was not produced by "npm run package".');
}

console.log(`=== Installing extension: ${vsixPath} ===`);
runShell(`code --install-extension ${shellQuote(vsixPath)} --force`);
console.log('=== Done ===');
