#!/usr/bin/env node
'use strict';

// Runs the extension-development host in its own VS Code instance.
//
// The Copilot agent host that feeds the chat model picker runs once per VS Code
// instance and publishes the BYOK models of a single connected window (the first
// one to report any), so a debug window opened inside the normal instance can
// never offer the dev provider while a normal window is connected. The only way
// to give the dev identity its own picker is its own instance, which means its
// own --user-data-dir: a separate profile with its own settings, SecretStorage,
// chat history, and agent host. An `extensionHost` launch configuration cannot
// do this, because its `args` are window payload rather than main-process argv.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// Outside the workspace on purpose: a VS Code profile is thousands of files
// that change constantly, and keeping it here would feed the file watcher,
// search, and lint of the window that launched it.
const HOST_DIR = path.join(
    process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || os.homedir(),
    'freellmapi-dev-host'
);
const USER_DATA_DIR = path.join(HOST_DIR, 'user-data');
const PROFILE_MARKER = 'freellmapi-dev-host';
const INSPECT_PORT = 9229;
const RELEASE_ID = 'uniquetrij.freellmapi-chat-provider';
const DEV_ID = 'uniquetrij-dev.freellmapi-chat-provider-dev';
// A VS Code task inherits the IPC hooks of the window that started it. Left in
// place they route a `code` invocation back into that instance, which drops
// --user-data-dir and reopens the dev window in the normal profile.
const SCRUBBED_ENV = ['VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'VSCODE_GIT_IPC_HANDLE', 'VSCODE_PID'];

function log(message) {
    console.log(`isolated-host: ${message}`);
}

function fail(message) {
    console.error(`isolated-host: ${message}`);
    process.exit(1);
}

function childEnv() {
    const env = { ...process.env };
    for (const name of SCRUBBED_ENV) {
        delete env[name];
    }
    return env;
}

function windowsCodeExe() {
    const candidates = [process.env.VSCODE_EXE];
    try {
        const where = execFileSync('where.exe', ['code.cmd'], { encoding: 'utf8', windowsHide: true });
        const shim = where.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (shim) {
            // <install>\bin\code.cmd -> <install>\Code.exe
            candidates.push(path.join(path.dirname(path.dirname(shim)), 'Code.exe'));
        }
    } catch {
        // No CLI on PATH; the fixed locations below still apply.
    }
    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'));
    }
    const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (!found) {
        fail('could not find Code.exe. Set VSCODE_EXE to its full path.');
    }
    return found;
}

function codeCommand() {
    return process.platform === 'win32' ? windowsCodeExe() : 'code';
}

function prepare() {
    const node = process.execPath;
    try {
        log('marking the debug identity');
        execFileSync(node, [path.join(ROOT, 'scripts', 'dev-marker.js'), 'mark'], { cwd: ROOT, stdio: 'inherit' });
        execFileSync(node, [path.join(ROOT, 'scripts', 'build_install', 'mark-dev-build.js')], { cwd: ROOT, stdio: 'inherit' });
        log('compiling');
        execFileSync(node, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', './'], { cwd: ROOT, stdio: 'inherit' });
    } catch (error) {
        fail(`preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function parseArgs(argv) {
    const options = { inspect: null, prepare: true, extensions: false };
    for (const arg of argv) {
        if (arg === '--inspect-brk') {
            options.inspect = 'brk';
        } else if (arg === '--inspect') {
            options.inspect = options.inspect || 'plain';
        } else if (arg === '--no-prepare') {
            options.prepare = false;
        } else if (arg === '--with-extensions') {
            options.extensions = true;
        } else {
            fail(`unknown option ${arg}`);
        }
    }
    return options;
}

function instancePids() {
    if (process.platform === 'win32') {
        const script = [
            `$needle = '${PROFILE_MARKER}';`,
            "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" |",
            "Where-Object { $_.CommandLine -and $_.CommandLine -like \"*$needle*\" -and $_.CommandLine -notlike '*--type=*' } |",
            'ForEach-Object { $_.ProcessId }',
        ].join(' ');
        try {
            const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8',
                windowsHide: true,
            });
            return output.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter(Number.isInteger);
        } catch {
            return [];
        }
    }
    try {
        const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
        return output.split('\n')
            .filter((line) => line.includes(PROFILE_MARKER) && !line.includes('--type='))
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter(Number.isInteger);
    } catch {
        return [];
    }
}

function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const attempt = () => {
            const socket = net.connect({ port, host: '127.0.0.1' });
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    resolve(false);
                } else {
                    setTimeout(attempt, 250);
                }
            });
        };
        attempt();
    });
}

async function start(argv) {
    const options = parseArgs(argv);
    const running = instancePids();
    if (running.length > 0) {
        log(`already running (pid ${running.join(', ')}); stop it first to pick up a new build`);
        return;
    }
    if (options.prepare) {
        prepare();
    }
    if (!fs.existsSync(path.join(ROOT, 'build', 'out', 'extension.js'))) {
        fail('build/out/extension.js is missing. Run "npm run compile" first.');
    }

    const args = [
        ROOT,
        `--user-data-dir=${USER_DATA_DIR}`,
        `--extensionDevelopmentPath=${ROOT}`,
        '--enable-proposed-api', RELEASE_ID,
        '--enable-proposed-api', DEV_ID,
    ];
    if (!options.extensions) {
        // Keeps the installed release copy out of this instance, so the window
        // offers the dev provider alone instead of two providers holding the
        // same models. It is a preference, not a requirement: every contributed
        // id is namespaced, so both copies can load without colliding.
        // `--with-extensions` loads both. A blanket --disable-extensions would
        // also drop Copilot Chat, and the chat panel is the whole point: a
        // --user-data-dir profile has no marketplace extensions of its own, so
        // everything in the chat comes from the shared extensions directory.
        args.push('--disable-extension', RELEASE_ID);
    }
    if (options.inspect === 'brk') {
        args.push(`--inspect-brk-extensions=${INSPECT_PORT}`);
    } else if (options.inspect === 'plain') {
        args.push(`--inspect-extensions=${INSPECT_PORT}`);
    }

    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    log(`user data: ${USER_DATA_DIR}`);
    const child = spawn(codeCommand(), args, { env: childEnv(), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();

    if (options.inspect) {
        const ready = await waitForPort(INSPECT_PORT, 30000);
        if (!ready) {
            fail(`the extension host never opened port ${INSPECT_PORT}; check the instance's logs`);
        }
        log(`extension host inspector listening on 127.0.0.1:${INSPECT_PORT}`);
    }

    const pids = instancePids();
    log(pids.length > 0 ? `started (pid ${pids.join(', ')})` : 'start requested');
}

function stop() {
    const pids = instancePids();
    if (pids.length === 0) {
        log('not running');
    }
    for (const pid of pids) {
        try {
            if (process.platform === 'win32') {
                execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            } else {
                process.kill(pid, 'SIGTERM');
            }
            log(`stopped pid ${pid}`);
        } catch (error) {
            log(`could not stop pid ${pid}: ${error instanceof Error ? error.message : error}`);
        }
    }
    // The dev identity only exists for the life of the host, so the manifest goes
    // back to the release identity as soon as the host is gone.
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'dev-marker.js'), 'unmark'], { cwd: ROOT, stdio: 'inherit' });
}

function status() {
    const pids = instancePids();
    log(pids.length > 0 ? `running (pid ${pids.join(', ')})` : 'not running');
    log(`user data: ${USER_DATA_DIR}`);
}

function newestAgentHostLog() {
    const logsDir = path.join(USER_DATA_DIR, 'logs');
    if (!fs.existsSync(logsDir)) {
        return null;
    }
    const found = [];
    for (const session of fs.readdirSync(logsDir)) {
        const candidate = path.join(logsDir, session, 'agenthost.log');
        if (fs.existsSync(candidate)) {
            found.push({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
        }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found.length > 0 ? found[0].candidate : null;
}

function logs() {
    const file = newestAgentHostLog();
    if (!file) {
        fail('no agenthost.log yet. Start the isolated host and send one chat request first.');
    }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    console.log(file);
    console.log(lines.slice(-20).join('\n'));
}

const command = process.argv[2];
const rest = process.argv.slice(3);

if (command === 'start') {
    start(rest).catch((error) => fail(error instanceof Error ? error.message : String(error)));
} else if (command === 'stop') {
    stop();
} else if (command === 'status') {
    status();
} else if (command === 'logs') {
    logs();
} else {
    console.log('usage: isolated-host.js <start [--inspect|--inspect-brk] [--no-prepare] [--with-extensions] | stop | status | logs>');
    process.exit(command ? 1 : 0);
}
