# CopyGlide

Copy on one device, paste on all of them. One account, every platform, end-to-end encrypted.

## Monorepo layout

```
packages/shared   TypeScript: protocol, E2E crypto, REST client, real-time SyncClient (used by every app)
apps/server       Cloudflare Worker (Hono) + Durable Object per user (WebSocket sync room) + D1 database
apps/web          React app — runs in the browser AND is the UI inside the desktop app
apps/desktop      Electron shell: clipboard watcher, tray icon, start at login (Windows / macOS / Linux)
apps/mobile       (next) React Native / Expo app for Android + iOS
```

## How sync works

1. The password never leaves the device. `scrypt(password, email)` derives two keys:
   - `authKey` → sent to the server to log in (server stores only a salted hash of it)
   - `encKey` → encrypts every clip with XChaCha20-Poly1305; never sent anywhere
2. Every device opens a WebSocket to `/api/sync`; the server routes it to that user's `UserRoom` Durable Object.
3. A copy on any device is encrypted and pushed to the room, stored (last 500 clips), and broadcast to all the user's devices.
4. A device that was offline sends `sync { since }` on reconnect and gets what it missed.

## Start / stop and resource use

- **Start/Stop button** in the app header, a "Sync enabled" switch under *Devices & settings*, and **Start/Stop syncing** in the desktop tray menu. The tray icon turns grey when stopped.
- **Stopped** → no connection, no timers, no clipboard watching. Anything copied while stopped is never sent. On restart the device catches up on clips it missed.
- **Desktop** runs sync in the Electron main process. Closing the window destroys the UI process (frees its memory); the app keeps syncing from the tray. GPU acceleration is off.
- **Clipboard watching** only runs while sync is on *and* "Send what I copy" is on. It checks every 0.5 s while you're active, every 2 s after 1 min idle, and pauses while the screen is locked. The connection closes during sleep and reconnects on wake.
- **Server keep-alive** pings are answered without waking the Durable Object (hibernation), so idle connections cost almost nothing.
- **Browser tab** disconnects after 5 min in the background and reconnects when you return.
- **Desktop session** is stored encrypted with the OS keychain (`safeStorage`), not in plain files.

## Run locally

Requires Node 20+.

```bash
npm install
```

```bash
cp apps/server/.dev.vars.example apps/server/.dev.vars
```

```bash
npm run db:migrate
```

Then, in three terminals:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

```bash
npm run dev:desktop
```

- Server: http://127.0.0.1:8787
- Web app: http://localhost:5173
- Desktop app: opens a window and a tray icon, loading the web app from the dev server

Local test account used during development: `demo@clipsync.test` / `demo-password-123` (local database only).

## Build everything (one command)

```bash
npm run build:all -- --server-url=https://your-server.example.com
```

Or double-click `build.cmd` (Windows) / run `./build.sh` (macOS, Linux). Everything lands in `release/v<version>/`:

```
release/v0.1.0/
  windows/   CopyGlide Setup 0.1.0.exe        (built on Windows)
  macos/     CopyGlide-0.1.0.dmg              (built on macOS)
  linux/     .AppImage + .deb                (built on Linux)
  android/   (once apps/mobile exists)
  ios/       (once apps/mobile exists, macOS only)
  web/       static site, ready to upload
  server/    Worker bundle, migrations, deploy notes
  logs/      build.log (everything), one log per step, summary.txt
  SHA256SUMS.txt  build-info.json  README.txt
```

- Targets that can't be built on the current computer are **skipped with the reason** (and a `README.txt` in that folder); the build continues.
- Options: `--only=web,windows`, `--skip=server`, `--verbose` (stream all output), `--no-typecheck`, `--out=dir`, `--help`.
- Exit code is `1` if any step failed; the failing step's last output lines are printed and its full log is in `logs/`.
- Without `--server-url`, the apps point at the local dev server (`http://127.0.0.1:8787`) and the script warns you.
- The Windows installer is unsigned for now, so Windows SmartScreen shows a warning until code signing is added.

## Deploy the server (Cloudflare free plan)

```bash
cd apps/server
npx wrangler login
npx wrangler d1 create copyglide          # put the returned database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put JWT_SECRET
npm run deploy
```

## Brand

- **Name:** CopyGlide (`copyglide.com` and `copyglide.app` were unregistered when checked on 2026-11-22; register them before launch, and run a proper trademark search).
- **Logo:** a frosted "copy" card with a bright "paste" card gliding in on speed trails. Master files are in `brand/` (`logo-icon.svg`, `tray.svg`).
- **Icons:** `npm run icons` regenerates every size from `brand/`: the desktop app and installer icon (`apps/desktop/build/icon.png`), tray icons (coloured, paused-grey and macOS template), and web favicons, touch icon and PWA icons.
- **UI:** Inter typeface, lucide icons, light and dark themes (Auto/Light/Dark in Settings). On desktop the app header doubles as the window title bar.
