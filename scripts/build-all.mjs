#!/usr/bin/env node
// One command to build every CopyGlide target into a single release folder:
//
//   release/v<version>/
//     windows/   Windows installer (.exe)                  — built on Windows
//     macos/     macOS disk image (.dmg)                   — built on macOS
//     linux/     Linux packages (.AppImage, .deb)          — built on Linux
//     android/   Android app                               — once apps/mobile exists
//     ios/       iOS app                                   — once apps/mobile exists (macOS only)
//     web/       Static web app, ready to host
//     server/    Cloudflare Worker bundle + migrations + deploy notes
//     logs/      build.log (everything) + one log per step + summary.txt
//     SHA256SUMS.txt, build-info.json, README.txt
//
// Usage:
//   node scripts/build-all.mjs [--server-url=https://api.example.com] [--only=web,windows] [--skip=server]
//                              [--out=release] [--verbose] [--no-typecheck] [--help]
//
// Targets that can't be built on this computer are skipped with the reason logged; the build continues.
// Exit code is 1 if any step failed.
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const WEB = path.join(ROOT, 'apps', 'web');
const SERVER = path.join(ROOT, 'apps', 'server');
const MOBILE = path.join(ROOT, 'apps', 'mobile');
const ALL_TARGETS = ['web', 'server', 'windows', 'macos', 'linux', 'android', 'ios'];
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

// ---------- arguments ----------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);

if (args.help || args.h) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const only = list(args.only);
const skip = list(args.skip);
for (const t of [...only, ...skip]) {
  if (!ALL_TARGETS.includes(t)) {
    console.error(`Unknown target "${t}". Valid targets: ${ALL_TARGETS.join(', ')}`);
    process.exit(2);
  }
}
const wanted = (t) => (only.length ? only.includes(t) : true) && !skip.includes(t);
const verbose = !!args.verbose;
const serverUrl = typeof args['server-url'] === 'string' ? args['server-url'].replace(/\/+$/, '') : DEFAULT_SERVER_URL;

const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version;
const OUT = path.resolve(ROOT, typeof args.out === 'string' ? args.out : 'release', `v${version}`);
const LOGS = path.join(OUT, 'logs');
const host = process.platform; // win32 | darwin | linux

// ---------- logging ----------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const cyan = (s) => c(36, s);
const stamp = () => new Date().toISOString();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(LOGS, { recursive: true });
const mainLog = fs.createWriteStream(path.join(LOGS, 'build.log'));

function log(msg = '', { console: toConsole = true } = {}) {
  // eslint-disable-next-line no-control-regex
  const plain = String(msg).replace(/\x1b\[[0-9;]*m/g, '');
  mainLog.write(`[${stamp()}] ${plain}\n`);
  if (toConsole) console.log(msg);
}

// ---------- running commands ----------

let stepNo = 0;
const results = [];

function exec(ctx, command, { cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const header = `$ ${command}\n  cwd: ${path.relative(ROOT, cwd) || '.'}${Object.keys(env).length ? `\n  env: ${JSON.stringify(env)}` : ''}\n`;
    ctx.stepLog.write(`\n[${stamp()}] ${header}`);
    log(dim(`  $ ${command}`) + dim(cwd !== ROOT ? `   (in ${path.relative(ROOT, cwd)})` : ''));

    const child = spawn(command, { cwd, env: { ...process.env, ...env, FORCE_COLOR: '0' }, shell: true });
    const tail = [];
    const onData = (buf) => {
      const text = buf.toString();
      ctx.stepLog.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        mainLog.write(`[${stamp()}] [${ctx.id}] ${line}\n`);
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (verbose) console.log(dim(`    ${line}`));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      ctx.stepLog.write(`\n[${stamp()}] exit code ${code}\n`);
      if (code === 0) return resolve();
      const err = new Error(`"${command}" exited with code ${code}`);
      err.tail = tail;
      reject(err);
    });
  });
}

async function step(id, name, fn) {
  stepNo++;
  const logFile = `${String(stepNo).padStart(2, '0')}-${id}.log`;
  const stepLog = fs.createWriteStream(path.join(LOGS, logFile));
  stepLog.write(`# ${name}\n# started ${stamp()}\n`);
  log('');
  log(bold(cyan(`▶ [${stepNo}] ${name}`)));
  const t0 = Date.now();
  const ctx = { id, stepLog };
  let r;
  try {
    r = (await fn(ctx)) ?? {};
    r.status ??= 'ok';
  } catch (err) {
    r = { status: 'failed', note: err.message };
    if (err.tail?.length && !verbose) {
      log(red('  Last output lines:'));
      for (const l of err.tail.slice(-25)) log(dim(`    ${l}`));
    }
    stepLog.write(`\n[${stamp()}] FAILED: ${err.stack ?? err.message}\n`);
  }
  const seconds = (Date.now() - t0) / 1000;
  await new Promise((res) => stepLog.end(`\n# finished ${stamp()} — ${r.status} in ${seconds.toFixed(1)}s\n`, res));
  const result = { id, name, status: r.status, seconds: Number(seconds.toFixed(1)), note: r.note ?? '', artifacts: r.artifacts ?? [], log: `logs/${logFile}` };
  results.push(result);
  const badge =
    r.status === 'ok' ? green('✔ done') : r.status === 'skipped' ? yellow('⏭ skipped') : r.status === 'warning' ? yellow('⚠ warning') : red('✖ failed');
  log(`  ${badge} ${dim(`(${seconds.toFixed(1)}s)`)}${r.note ? ` — ${r.note}` : ''}`);
  if (r.status === 'failed') log(dim(`  Full log: ${path.relative(ROOT, path.join(LOGS, logFile))}`));
  return result;
}

const skipped = (note) => ({ status: 'skipped', note });

// ---------- helpers ----------

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesIn(p) : [p];
  });
}

function writeNote(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.txt'), text.trim() + '\n');
}

const sizeOf = (p) => {
  const b = fs.statSync(p).size;
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
};

function gitInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return { commit, dirty };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

/** Runs electron-builder into a scratch folder, then copies only the installers into release/<platform>. */
async function packageDesktop(ctx, { flags, outName }) {
  const require = createRequire(path.join(DESKTOP, 'package.json'));
  const electronVersion = require('electron/package.json').version;
  const work = path.join(DESKTOP, 'release', outName);
  fs.rmSync(work, { recursive: true, force: true });
  await exec(
    ctx,
    `npx electron-builder ${flags} --publish never -c.directories.output="${work}" -c.electronVersion=${electronVersion}`,
    { cwd: DESKTOP, env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } },
  );
  const dest = path.join(OUT, outName);
  fs.mkdirSync(dest, { recursive: true });
  const artifacts = [];
  for (const e of fs.readdirSync(work, { withFileTypes: true })) {
    if (!e.isFile() || /^builder-(debug|effective-config)/.test(e.name)) continue;
    if (!/\.(exe|msi|dmg|zip|AppImage|deb|rpm|tar\.gz|blockmap|yml)$/.test(e.name)) continue;
    fs.copyFileSync(path.join(work, e.name), path.join(dest, e.name));
    artifacts.push(`${outName}/${e.name}`);
    log(`  → ${outName}/${e.name} ${dim(sizeOf(path.join(dest, e.name)))}`);
  }
  if (!artifacts.some((a) => !/\.(yml|blockmap)$/.test(a))) throw new Error('electron-builder finished but produced no installer');
  return { artifacts };
}

// ---------- the build ----------

const startedAt = Date.now();
const git = gitInfo();

log(bold(`CopyGlide release build v${version}`));
log(`  Output folder : ${OUT}`);
log(`  Host          : ${host} ${os.arch()} · Node ${process.version}`);
log(`  Git commit    : ${git.commit}${git.dirty ? ' (uncommitted changes)' : ''}`);
log(`  Server URL    : ${serverUrl}`);
log(`  Targets       : ${ALL_TARGETS.filter(wanted).join(', ') || '(none)'}`);
if (serverUrl === DEFAULT_SERVER_URL) {
  log(yellow('  ⚠ Using the local dev server URL. For a real release pass --server-url=https://your-server'));
}

// 1. Preflight
await step('preflight', 'Check tools and install dependencies', async (ctx) => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node 20+ is required (found ${process.version})`);
  await exec(ctx, 'npm --version');
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    log('  node_modules missing — installing dependencies (first run takes a few minutes)');
    await exec(ctx, fs.existsSync(path.join(ROOT, 'package-lock.json')) ? 'npm ci' : 'npm install');
  } else {
    log(dim('  Dependencies already installed'));
  }
});
const preflightOk = results.at(-1).status === 'ok';

// 2. Typecheck
if (!args['no-typecheck']) {
  await step('typecheck', 'Typecheck all packages', async (ctx) => {
    if (!preflightOk) return skipped('preflight failed');
    await exec(ctx, 'npm run typecheck');
  });
}

// 3. Web build (used by both the web target and the desktop apps)
const needWebBuild = ['web', 'windows', 'macos', 'linux'].some(wanted);
let webBuilt = false;
if (needWebBuild) {
  await step('web-build', 'Build the web UI', async (ctx) => {
    if (!preflightOk) return skipped('preflight failed');
    await exec(ctx, 'npm run build -w @copyglide/web', { env: { VITE_SERVER_URL: serverUrl } });
    webBuilt = true;
  });
}

// 4. Web target
if (wanted('web')) {
  await step('web', 'Package web app → web/', async () => {
    if (!webBuilt) return skipped('web build failed');
    const dest = path.join(OUT, 'web');
    copyDir(path.join(WEB, 'dist'), dest);
    writeNote(
      path.join(OUT, 'web'),
      `Static web app. Upload this folder to any static host (Cloudflare Pages, Netlify, GitHub Pages, S3).
Server URL baked in: ${serverUrl}`,
    );
    log(`  → web/ ${dim(`${filesIn(dest).length} files`)}`);
    return { artifacts: ['web/'] };
  });
}

// 5. Server target
if (wanted('server')) {
  await step('server', 'Bundle Cloudflare Worker → server/', async (ctx) => {
    if (!preflightOk) return skipped('preflight failed');
    const dest = path.join(OUT, 'server');
    await exec(ctx, `npx wrangler deploy --dry-run --outdir "${path.join(dest, 'worker')}"`, { cwd: SERVER });
    copyDir(path.join(SERVER, 'migrations'), path.join(dest, 'migrations'));
    fs.copyFileSync(path.join(SERVER, 'wrangler.jsonc'), path.join(dest, 'wrangler.jsonc'));
    writeNote(
      dest,
      `Cloudflare Worker for CopyGlide.

worker/        The bundled Worker code (what Cloudflare will run) — for inspection/archiving.
migrations/    D1 database schema.
wrangler.jsonc Config used for this build.

Deploy from the repository (recommended):
  cd apps/server
  npx wrangler login
  npx wrangler d1 create copyglide        # put the database_id into wrangler.jsonc (first time only)
  npm run db:migrate:remote
  npx wrangler secret put JWT_SECRET     # first time only
  npm run deploy`,
    );
    log(`  → server/ ${dim(`${filesIn(dest).length} files`)}`);
    return { artifacts: ['server/'] };
  });
}

// 6. Desktop main process + renderer
const desktopTargets = ['windows', 'macos', 'linux'].filter(wanted);
let desktopReady = false;
if (desktopTargets.length) {
  await step('desktop-prep', 'Prepare desktop app (bundle main process + UI)', async (ctx) => {
    if (!webBuilt) return skipped('web build failed');
    await exec(ctx, 'node scripts/copy-renderer.cjs', { cwd: DESKTOP });
    await exec(ctx, 'node build.mjs', { cwd: DESKTOP });
    desktopReady = true;
  });
}

// 7–9. Desktop installers
const desktopPlan = {
  windows: { host: 'win32', label: 'Windows', flags: '--win nsis --x64', why: 'needs a Windows computer (or Windows CI runner)' },
  macos: { host: 'darwin', label: 'macOS', flags: '--mac dmg', why: 'needs a Mac (Apple only allows building .dmg on macOS)' },
  linux: { host: 'linux', label: 'Linux', flags: '--linux AppImage deb --x64', why: 'needs a Linux computer (or Linux CI runner)' },
};
for (const target of desktopTargets) {
  const plan = desktopPlan[target];
  await step(target, `Build ${plan.label} installer → ${target}/`, async (ctx) => {
    if (host !== plan.host) {
      writeNote(path.join(OUT, target), `Not built: ${plan.label} installers ${plan.why}.\nRun this same script on that system: node scripts/build-all.mjs --only=${target}`);
      return skipped(plan.why);
    }
    if (!desktopReady) return skipped('desktop preparation failed');
    return packageDesktop(ctx, { flags: plan.flags, outName: target });
  });
}

// 10–11. Mobile
for (const target of ['android', 'ios'].filter(wanted)) {
  await step(target, `Build ${target === 'ios' ? 'iOS' : 'Android'} app → ${target}/`, async () => {
    if (!fs.existsSync(MOBILE)) {
      writeNote(path.join(OUT, target), 'Not built yet: the mobile app (apps/mobile) has not been created. It is the next milestone.');
      return skipped('mobile app (apps/mobile) not created yet');
    }
    if (target === 'ios' && host !== 'darwin') {
      writeNote(path.join(OUT, target), 'Not built: iOS apps can only be built on a Mac with Xcode (or with Expo EAS cloud builds).');
      return skipped('iOS builds need macOS + Xcode');
    }
    return skipped('mobile build step not wired up yet');
  });
}

// 12. Checksums + build info
await step('finalize', 'Write checksums and build info', async () => {
  const files = filesIn(OUT)
    .filter((f) => !f.startsWith(LOGS) && !f.startsWith(path.join(OUT, 'web')) && !f.startsWith(path.join(OUT, 'server')) && !f.endsWith('README.txt'))
    .sort();
  const sums = files.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.relative(OUT, f).replace(/\\/g, '/')}`);
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), sums.join('\n') + (sums.length ? '\n' : ''));

  fs.writeFileSync(
    path.join(OUT, 'README.txt'),
    `CopyGlide v${version} — built ${new Date().toISOString()} from commit ${git.commit}${git.dirty ? ' (with uncommitted changes)' : ''}

windows/   Windows installer (.exe)
macos/     macOS disk image (.dmg)
linux/     Linux packages (.AppImage, .deb)
android/   Android app
ios/       iOS app
web/       Static web app
server/    Cloudflare Worker bundle and deploy notes
logs/      Build logs (build.log has everything; one file per step; summary.txt)

A folder with only README.txt explains why that target wasn't built on this computer.
SHA256SUMS.txt lets users verify downloads.
Server URL built into the apps: ${serverUrl}
`,
  );
  return { artifacts: ['SHA256SUMS.txt', 'build-info.json', 'README.txt'] };
});

// ---------- summary ----------

const totalSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
const failed = results.filter((r) => r.status === 'failed');
const info = {
  name: 'CopyGlide',
  version,
  builtAt: new Date().toISOString(),
  durationSeconds: totalSeconds,
  git,
  host: { platform: host, arch: os.arch(), node: process.version, hostname: os.hostname() },
  serverUrl,
  steps: results,
};
fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

const pad = (s, n) => String(s).padEnd(n);
const lines = [
  '',
  `Build summary — CopyGlide v${version} (${totalSeconds}s)`,
  '-'.repeat(78),
  `${pad('Step', 15)}${pad('Status', 10)}${pad('Time', 8)}Details`,
  ...results.map((r) => `${pad(r.id, 15)}${pad(r.status, 10)}${pad(r.seconds + 's', 8)}${r.note || r.artifacts.join(', ')}`),
  '-'.repeat(78),
  failed.length ? `${failed.length} step(s) FAILED — see the logs listed above.` : 'Build finished with no failures.',
  `Output: ${OUT}`,
  '',
];
fs.writeFileSync(path.join(LOGS, 'summary.txt'), lines.join('\n'));
for (const l of lines) {
  const colored = l.includes('FAILED') ? red(l) : l.startsWith('Build finished') ? green(l) : l.startsWith('Build summary') ? bold(l) : l;
  log(colored);
}

await new Promise((res) => mainLog.end(res));
process.exit(failed.length ? 1 : 0);
