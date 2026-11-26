#!/usr/bin/env node
'use strict';

// Mutate package.json so a debug build can run SIDE-BY-SIDE with an installed
// release of this extension without id collisions (distinct vendor, name,
// publisher, command ids, and configuration namespace) and carries the
// manifest-declared "🐞 " badges (provider displayName + command titles) that
// cannot be set at runtime.
//
// Runtime-only dev cues — the Output channel label — are driven by
// src/runtimeMode.ts `isDevelopmentMode()` (the VS Code dev-host signal,
// VSCODE_DEBUG / ExtensionMode.Development), NOT by this script. So those
// badges appear on every F5 without any manifest mutation.
//
// Wired into the F5 debug flow (see .vscode/launch.json + tasks.json):
//   - preLaunchTask  runs `mark`   → ids isolated for side-by-side debug
//   - postDebugTask  runs `unmark` → manifest returns to canonical state
// The committed manifest stays clean; the mutations only exist during a debug
// session that opts into side-by-side isolation via `mark`.
//
// Usage: node scripts/dev-marker.js <mark|unmark>

const fs = require('fs');
const path = require('path');

const DEBUG_MARKER_PROPERTY = 'x-dev-marker-debug';
const DEV_SUFFIX = '-dev';
const BASE_NAMESPACE = 'freellmapi';
const DEV_NAMESPACE = `${BASE_NAMESPACE}${DEV_SUFFIX}`;
const DEV_BADGE = '🐞 ';

const mode = process.argv[2];
if (mode !== 'mark' && mode !== 'unmark') {
    console.error('Usage: node scripts/dev-marker.js <mark|unmark>');
    process.exit(1);
}

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function toDev(value) {
    return typeof value === 'string' && !value.endsWith(DEV_SUFFIX) ? `${value}${DEV_SUFFIX}` : value;
}

function toBase(value) {
    return typeof value === 'string' && value.endsWith(DEV_SUFFIX)
        ? value.slice(0, -DEV_SUFFIX.length)
        : value;
}

// The bare id and `<namespace>.<name>` both switch. The dot boundary is what
// stops an already switched id from switching twice: the dev form has `-`
// there, not `.`.
function switchNamespace(value) {
    if (typeof value !== 'string') {
        return value;
    }

    const [from, to] = mode === 'mark'
        ? [BASE_NAMESPACE, DEV_NAMESPACE]
        : [DEV_NAMESPACE, BASE_NAMESPACE];

    if (value === from) {
        return to;
    }
    return value.startsWith(`${from}.`) ? `${to}${value.slice(from.length)}` : value;
}

function withBadge(value, enabled) {
    if (typeof value !== 'string') {
        return value;
    }
    // Strip any existing prefix first so repeated calls are idempotent.
    const stripped = value.replace(/^🐞 /, '');
    return enabled ? `${DEV_BADGE}${stripped}` : stripped;
}

let changed = false;

const providers = pkg.contributes && pkg.contributes.languageModelChatProviders;
if (!Array.isArray(providers) || providers.length === 0) {
    console.error('dev-marker: no languageModelChatProviders in package.json — nothing to do.');
    process.exit(0);
}

for (const provider of providers) {
    const nextVendor = mode === 'mark' ? toDev(provider.vendor) : toBase(provider.vendor);
    if (nextVendor !== provider.vendor) {
        provider.vendor = nextVendor;
        changed = true;
    }

    const nextDisplayName = withBadge(provider.displayName, mode === 'mark');
    if (nextDisplayName !== provider.displayName) {
        provider.displayName = nextDisplayName;
        changed = true;
    }
}

for (const field of ['name', 'publisher']) {
    if (typeof pkg[field] !== 'string') {
        continue;
    }
    const next = mode === 'mark' ? toDev(pkg[field]) : toBase(pkg[field]);
    if (next !== pkg[field]) {
        pkg[field] = next;
        changed = true;
    }
}

if (Array.isArray(pkg.activationEvents)) {
    pkg.activationEvents = pkg.activationEvents.map((eventName) => {
        if (typeof eventName !== 'string') {
            return eventName;
        }
        for (const prefix of ['onCommand:', 'onLanguageModelChatProvider:']) {
            if (!eventName.startsWith(prefix)) {
                continue;
            }
            const id = eventName.slice(prefix.length);
            const nextId = switchNamespace(id);
            if (nextId !== id) {
                changed = true;
            }
            return `${prefix}${nextId}`;
        }
        return eventName;
    });
}

const commands = pkg.contributes && pkg.contributes.commands;
if (Array.isArray(commands)) {
    for (const command of commands) {
        if (!command || typeof command.command !== 'string') {
            continue;
        }
        const nextCommand = switchNamespace(command.command);
        if (nextCommand !== command.command) {
            command.command = nextCommand;
            changed = true;
        }

        const nextTitle = withBadge(command.title, mode === 'mark');
        if (nextTitle !== command.title) {
            command.title = nextTitle;
            changed = true;
        }
    }
}

const properties = pkg.contributes && pkg.contributes.configuration && pkg.contributes.configuration.properties;
if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const nextProperties = {};
    for (const [key, value] of Object.entries(properties)) {
        const nextKey = switchNamespace(key);
        nextProperties[nextKey] = value;
        if (nextKey !== key) {
            changed = true;
        }
    }
    pkg.contributes.configuration.properties = nextProperties;
}

// The ids only line up while every section is rewritten together, so a
// mismatch is a hard error rather than a warning the debug host quietly logs.
const declaredCommands = new Set(
    (Array.isArray(commands) ? commands : [])
        .map((command) => command && command.command)
        .filter((value) => typeof value === 'string')
);
// Read the rewritten sections back: `properties` above still references the
// pre-switch object once `pkg.contributes.configuration.properties` is replaced.
const rewrittenProperties = (pkg.contributes && pkg.contributes.configuration
    && pkg.contributes.configuration.properties) || {};
const declaredProperties = new Set(Object.keys(rewrittenProperties));
const declaredVendors = new Set(providers.map((provider) => provider.vendor));
const expectedNamespace = mode === 'mark' ? DEV_NAMESPACE : BASE_NAMESPACE;
const expectedVendor = mode === 'mark' ? `${BASE_NAMESPACE}${DEV_SUFFIX}` : BASE_NAMESPACE;
const problems = [];

for (const commandId of declaredCommands) {
    if (!commandId.startsWith(`${expectedNamespace}.`)) {
        problems.push(`command "${commandId}" is not under "${expectedNamespace}."`);
    }
}
for (const key of declaredProperties) {
    if (!key.startsWith(`${expectedNamespace}.`)) {
        problems.push(`setting "${key}" is not under "${expectedNamespace}."`);
    }
}
if (declaredVendors.size !== 1) {
    problems.push(`expected exactly one vendor id, found ${declaredVendors.size}`);
}
if (!declaredVendors.has(expectedVendor)) {
    problems.push(`vendor "${expectedVendor}" is not declared`);
}

if (problems.length > 0) {
    console.error(`dev-marker: ${mode} would leave an inconsistent manifest:`);
    for (const problem of problems) {
        console.error(`  - ${problem}`);
    }
    process.exit(1);
}

const markerWasSet = pkg[DEBUG_MARKER_PROPERTY] === true;
if (mode === 'mark') {
    pkg[DEBUG_MARKER_PROPERTY] = true;
} else {
    delete pkg[DEBUG_MARKER_PROPERTY];
}
const markerChanged = markerWasSet !== (mode === 'mark');

if (changed || markerChanged) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`dev-marker: ${mode} applied.`);
} else {
    console.log(`dev-marker: already ${mode === 'mark' ? 'marked' : 'unmarked'} — no change.`);
}
