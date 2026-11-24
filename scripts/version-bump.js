#!/usr/bin/env node
'use strict';

// Bump the extension version and prepend a CHANGELOG.md section generated from
// conventional commits, so the version and the changelog can never drift apart
// by hand. Wired into `npm run release` (bump -> then package the VSIX).
//
// Commits are collected since the last release reference, resolved in order:
//   1. the newest v* tag
//   2. the last commit that changed the "version" field in package.json
//   3. the entire history
//
// Bump level follows the conventional-commits -> semver mapping:
//   breaking (`feat!:` or a `BREAKING CHANGE:` footer) -> major
//   feat / feature                                    -> minor
//   fix / perf / revert                               -> patch
//   anything else (chore, docs, ci, test, ...)         -> not releasable
//
// Commits that carry no releasable type leave the version untouched and exit 0,
// so running the release step repeatedly is safe. Use --bump to force a level.
//
// Usage: node scripts/version-bump.js [--bump <major|minor|patch>] [--dry-run]

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const CHANGELOG_TITLE = '# Change Log';
const UNRELEASED_HEADING = /^##\s+\[?unreleased\]?\s*$/i;
const HEADING = /^##\s+/;
const BREAKING_HEADING = '⚠ BREAKING CHANGES';

// Ordered: the first section with a matching commit decides the bump level, so
// `feat` (minor) must be tested before `fix` (patch).
const SECTIONS = [
    { types: ['feat', 'feature'], heading: 'Features', level: 'minor' },
    { types: ['fix'], heading: 'Bug Fixes', level: 'patch' },
    { types: ['perf'], heading: 'Performance Improvements', level: 'patch' },
    { types: ['revert'], heading: 'Reverts', level: 'patch' }
];

// Conventional-commit trailers and issue keywords are bookkeeping, never changelog prose.
const TRAILER_RE = /^(co-authored-by|signed-off-by|reviewed-by|reviewed|helped-by|acked-by|tested-by|reported-by|suggested-by|closes|fixes|refs|resolves|mentions)\s*:/i;
const BREAKING_RE = /^BREAKING[ -]CHANGE:/m;
const CONVENTIONAL_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*([\s\S]*)$/;

function fail(message) {
    console.error(`version-bump: ${message}`);
    process.exit(1);
}

function git(args) {
    return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function parseArgs(argv) {
    const options = { bump: null, dryRun: false };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--bump') {
            options.bump = argv[++i];
        } else if (arg.startsWith('--bump=')) {
            options.bump = arg.slice('--bump='.length);
        } else {
            fail(`unknown argument: ${arg}`);
        }
    }

    if (options.bump && !['major', 'minor', 'patch'].includes(options.bump)) {
        fail(`--bump must be one of major, minor, patch (got "${options.bump}")`);
    }
    return options;
}

function resolveBaseRef() {
    const tags = git(['tag', '--list', 'v*', '--sort=-v:refname']).trim();
    if (tags) {
        const ref = tags.split(/\r?\n/)[0];
        return { ref, source: `tag ${ref}` };
    }

    // No tags yet: the last commit that touched the "version" field is where the
    // previous release landed. -G matches the diff line, so unrelated manifest
    // edits (e.g. the "main" path) do not count as a release.
    const commit = git(['log', '-1', '--format=%h', '-G', '"version"', '--', 'package.json']).trim();
    if (commit) {
        return { ref: commit, source: `package.json version commit ${commit}` };
    }

    return null;
}

function cleanBody(body) {
    return body
        .split(/\r?\n/)
        .filter((line) => !/^#/.test(line.trim()))
        .filter((line) => !TRAILER_RE.test(line.trim()))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function collectCommits(baseRef) {
    const range = baseRef ? `${baseRef}..HEAD` : 'HEAD';
    const raw = git(['log', range, '--no-merges', '--format=%H%x1f%h%x1f%s%x1f%b%x1e']);

    return raw
        .split('\x1e')
        .map((record) => record.replace(/^\s*\n/, ''))
        .filter((record) => record.trim().length > 0)
        .map((record) => {
            const [hash, shortHash, subject, body] = record.split('\x1f');
            const match = CONVENTIONAL_RE.exec(subject);
            const details = match ? cleanBody(body) : '';

            return {
                hash,
                shortHash,
                subject,
                description: match ? match[4].trim() : subject,
                scope: match ? match[2] || '' : '',
                type: match ? match[1].toLowerCase() : '',
                breaking: Boolean(match && match[3]) || BREAKING_RE.test(body),
                details
            };
        });
}

function inferLevel(commits) {
    if (commits.some((commit) => commit.breaking)) {
        return 'major';
    }
    for (const section of SECTIONS) {
        if (commits.some((commit) => section.types.includes(commit.type))) {
            return section.level;
        }
    }
    return null;
}

function bumpVersion(current, level) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(current);
    if (!match) {
        fail(`cannot parse version "${current}" in package.json`);
    }

    let [, major, minor, patch] = match.map(Number);
    if (level === 'major') {
        major += 1;
        minor = 0;
        patch = 0;
    } else if (level === 'minor') {
        minor += 1;
        patch = 0;
    } else {
        patch += 1;
    }
    return `${major}.${minor}.${patch}`;
}

function today() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function renderCommit(commit) {
    const label = commit.scope ? `**${commit.scope}:** ${commit.description}` : commit.description;
    const lines = [`- ${label} (${commit.shortHash})`];
    if (commit.details) {
        for (const line of commit.details.split('\n')) {
            lines.push(line.length > 0 ? `  ${line}` : '');
        }
    }
    return lines;
}

function renderSection(version, date, commits) {
    const lines = [`## ${version} - ${date}`, ''];

    const breaking = commits.filter((commit) => commit.breaking);
    if (breaking.length > 0) {
        lines.push(`### ${BREAKING_HEADING}`, '');
        for (const commit of breaking) {
            lines.push(...renderCommit(commit), '');
        }
    }

    for (const section of SECTIONS) {
        const matches = commits.filter((commit) => !commit.breaking && section.types.includes(commit.type));
        if (matches.length === 0) {
            continue;
        }
        lines.push(`### ${section.heading}`, '');
        for (const commit of matches) {
            lines.push(...renderCommit(commit), '');
        }
    }

    if (lines.every((line) => !line.startsWith('- '))) {
        lines.push('_No user-facing changes._', '');
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines.join('\n');
}

function insertSection(changelog, section) {
    const lines = changelog.split(/\r?\n/);

    let insertAt = 0;
    const titleIndex = lines.findIndex((line) => line.trim() === CHANGELOG_TITLE);
    if (titleIndex !== -1) {
        insertAt = titleIndex + 1;
        while (insertAt < lines.length && lines[insertAt].trim() === '') {
            insertAt++;
        }
    }

    // Keep an "Unreleased" section pinned above the newest released version.
    const unreleasedIndex = lines.findIndex((line, index) => index >= insertAt && UNRELEASED_HEADING.test(line.trim()));
    if (unreleasedIndex !== -1) {
        insertAt = unreleasedIndex + 1;
        while (insertAt < lines.length && lines[insertAt].trim() === '') {
            insertAt++;
        }
    } else {
        while (insertAt < lines.length && !HEADING.test(lines[insertAt])) {
            insertAt++;
        }
    }

    const block = [...section.split('\n'), ''];
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '') {
        block.unshift('');
    }
    lines.splice(insertAt, 0, ...block);

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const currentVersion = pkg.version;

    const base = resolveBaseRef();
    const commits = collectCommits(base ? base.ref : null);
    const level = options.bump || inferLevel(commits);

    console.log('=== Release scope ===');
    console.log(`base:        ${base ? `${base.source} (${base.ref})` : 'entire history (no tags, no prior version commit)'}`);
    console.log(`commits:     ${commits.length}`);

    if (!level) {
        console.log('');
        console.log('No releasable commits (only chore/docs/ci/test-style changes) — version left at ' + currentVersion + '.');
        console.log('Force a release with: node scripts/version-bump.js --bump patch');
        return;
    }

    const nextVersion = bumpVersion(currentVersion, level);
    console.log(`bump:        ${currentVersion} -> ${nextVersion} (${level}${options.bump ? ', forced' : ', from commits'})`);

    const section = renderSection(nextVersion, today(), commits);

    if (options.dryRun) {
        console.log('');
        console.log('=== CHANGELOG.md section (dry run, not written) ===');
        console.log(section);
        return;
    }

    if (git(['status', '--porcelain', '--', 'package.json']).trim()) {
        console.log('');
        console.log('Warning: package.json has uncommitted changes — they are preserved, but the');
        console.log('version bump will be mixed into the same file. Review the diff before committing.');
    }

    pkg.version = nextVersion;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    fs.writeFileSync(CHANGELOG_PATH, insertSection(fs.readFileSync(CHANGELOG_PATH, 'utf8'), section));

    console.log('');
    console.log(`Updated package.json -> ${nextVersion}`);
    console.log(`Updated CHANGELOG.md -> ${nextVersion} section`);
    console.log('');
    console.log('=== Next steps ===');
    console.log(`  git add package.json CHANGELOG.md`);
    console.log(`  git commit -m "chore(release): v${nextVersion}"`);
    console.log(`  git tag -a v${nextVersion} -m "v${nextVersion}"`);
}

main();
