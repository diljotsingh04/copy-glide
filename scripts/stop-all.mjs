#!/usr/bin/env node
// Stops everything CopyGlide runs locally:
//   - sync server (wrangler + its workerd runtime, port 8787)
//   - web dev server (vite, port 5173)
//   - desktop app started with `npm run dev:desktop` (electron from this repo)
//   - installed CopyGlide tray app
//
// Usage:  npm run stop                (everything)
//         npm run stop -- --keep-app  (leave the installed CopyGlide app running)
//
// It stops the *parent* processes (wrangler, vite), not just their children — wrangler
// restarts workerd if only workerd is killed. It then re-checks and reports honestly.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = { 8787: 'sync server', 5173: 'web dev server' };
const keepApp = process.argv.includes('--keep-app');
const isWin = process.platform === 'win32';

const run = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  } catch {
    return '';
  }
};
const ps = (script) => run(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`);
const unique = (xs) => [...new Set(xs.filter((x) => x && x !== '0'))];

// ---------- discovery ----------

/** PIDs listening on a TCP port (IPv4 and IPv6). */
function portPids(port) {
  if (isWin) {
    return unique(
      run('netstat -ano')
        .split(/\r?\n/)
        .filter((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l))
        .map((l) => l.trim().split(/\s+/).pop()),
    );
  }
  return unique(run(`lsof -ti tcp:${port} -sTCP:LISTEN`).split(/\s+/));
}

/** Processes started from this repo (wrangler, vite, workerd, esbuild, dev electron). */
function repoProcesses() {
  if (isWin) {
    const root = ROOT.replace(/'/g, "''");
    const out = ps(
      `Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*${root}*' -or $_.ExecutablePath -like '${root}*') -and $_.CommandLine -notlike '*stop-all*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.Name }`,
    );
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [pid, name] = l.split('|');
        return { pid, name: name.trim() };
      });
  }
  return run(`pgrep -af "${ROOT}/node_modules"`)
    .split('\n')
    .filter((l) => l && !l.includes('stop-all'))
    .map((l) => {
      const [pid, ...cmd] = l.split(' ');
      return { pid, name: cmd.join(' ').match(/(wrangler|vite|workerd|electron|esbuild)/)?.[1] ?? 'node' };
    });
}

function appPids() {
  if (isWin) return unique(ps(`Get-Process CopyGlide -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`).split(/\s+/));
  return unique(run('pgrep -x CopyGlide').split(/\s+/));
}

function kill(pids) {
  for (const pid of pids) {
    if (isWin) run(`taskkill /PID ${pid} /T /F`);
    else run(`kill -9 ${pid}`);
  }
}

const label = (name) => {
  const n = name.toLowerCase();
  if (n.includes('workerd')) return 'local Cloudflare runtime (workerd)';
  if (n.includes('electron')) return 'dev desktop app (electron)';
  if (n.includes('esbuild')) return 'bundler (esbuild)';
  return 'dev servers (node: wrangler / vite)';
};

// ---------- stop ----------

const before = repoProcesses();
const groups = {};
for (const p of before) (groups[label(p.name)] ??= []).push(p.pid);

kill(unique(before.map((p) => p.pid)));
for (const port of Object.keys(PORTS)) kill(portPids(port)); // anything else still holding our ports
const app = keepApp ? [] : appPids();
kill(app);

// Give Windows a moment to release processes and ports, then verify.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let leftovers = [];
for (let attempt = 0; attempt < 5; attempt++) {
  sleep(400);
  const procs = repoProcesses().map((p) => p.pid);
  const ports = Object.keys(PORTS).flatMap(portPids);
  const apps = keepApp ? [] : appPids();
  leftovers = unique([...procs, ...ports, ...apps]);
  if (!leftovers.length) break;
  kill(leftovers);
}

// ---------- report ----------

console.log('CopyGlide — stopping local processes\n');
const names = Object.keys(groups);
if (!names.length && !app.length) console.log('· nothing from this project was running');
for (const name of names) console.log(`✔ stopped  ${name}${groups[name].length > 1 ? ` (${groups[name].length} processes)` : ''}`);
if (!keepApp) console.log(app.length ? '✔ stopped  installed CopyGlide app' : '· installed CopyGlide app was not running');

console.log('');
for (const [port, what] of Object.entries(PORTS)) {
  console.log(`${portPids(port).length ? '✖ still in use' : '✔ free'}  port ${port} (${what})`);
}

if (leftovers.length) {
  console.log(`\n✖ Could not stop process(es): ${leftovers.join(', ')}. Try running the terminal as administrator.`);
  process.exit(1);
}
console.log('\nEverything is stopped.');
if (isWin && app.length) {
  console.log('Tip: if a CopyGlide icon still shows by the clock, hover over it — Windows clears leftover icons on hover.');
}
