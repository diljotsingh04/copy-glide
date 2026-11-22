# CopyGlide — Architecture

Technical overview for developers working on CopyGlide.

## 1. Repository layout

CopyGlide is a **monorepo** managed with **npm workspaces**: one root `package.json`, one `node_modules`, one lockfile.

```
copy-to-clipboard/
├─ packages/
│  └─ shared/        @copyglide/shared   ← code every app uses
├─ apps/
│  ├─ server/        @copyglide/server   ← backend (Cloudflare Worker)
│  ├─ web/           @copyglide/web      ← React UI (browser + desktop window)
│  └─ desktop/       @copyglide/desktop  ← Electron app (Windows/macOS/Linux)
├─ brand/            logo SVGs + icon generator
├─ scripts/          build-all.mjs (one-command release build)
├─ release/          build output (git-ignored)
└─ build.cmd / build.sh
```

Apps import shared code with `import … from '@copyglide/shared'`. npm links workspace folders, so a change in `packages/shared` is picked up by every app immediately, with no publishing step.

## 2. Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript everywhere |
| Shared logic | `packages/shared`: protocol types, encryption, REST client, real-time `SyncClient` |
| Backend runtime | Cloudflare Workers |
| API framework | Hono |
| Real-time sync | WebSockets → Cloudflare Durable Objects (Hibernation API) |
| Database (accounts) | Cloudflare D1 (SQLite) |
| Database (clips) | SQLite built into each Durable Object |
| Web UI | React 18 + Vite 5, plain CSS, Inter (`@fontsource-variable/inter`), `lucide-react` icons |
| Desktop | Electron 33; main process bundled with esbuild; installers by electron-builder |
| Encryption | `@noble/hashes` + `@noble/ciphers` (audited, pure JS) |
| Auth tokens | JWT (HS256) via `hono/jwt` |
| Icons | `@resvg/resvg-js` renders `brand/*.svg` to PNG |

## 3. Databases

There are two storage places, each used for what it's good at.

### A) Cloudflare D1 — accounts and devices

Schema: `apps/server/migrations/0001_init.sql`.

**`users`**

| Column | Purpose |
|---|---|
| `id` | UUID |
| `email` | unique, lowercased |
| `auth_hash` | SHA-256 of `salt:authKey` (never the password) |
| `auth_salt` | random per user |
| `plan` | `free` now; for paid tiers later |
| `created_at` | timestamp (ms) |

**`devices`**

| Column | Purpose |
|---|---|
| `id` | UUID, also stored inside that device's JWT |
| `user_id` | owning account (`ON DELETE CASCADE`) |
| `name` | e.g. "Pixel 9" |
| `platform` | windows / macos / linux / android / ios / web |
| `created_at`, `last_seen` | when added / last used |

### B) Durable Object SQLite — clipboard history

Each account has its own Durable Object (`UserRoom`, `apps/server/src/room.ts`), addressed by user id, with a private SQLite database:

| `clips` column | Purpose |
|---|---|
| `id` | UUID made by the client |
| `device_id` | sending device |
| `created_at` | server-assigned, strictly increasing (used for catch-up sync) |
| `nonce` | 24 random bytes, base64 |
| `ct` | ciphertext, base64 — the server cannot read it |

The newest **500** clips per user are kept; older ones are deleted on insert.

**Why the split:** D1 suits lookups like "find user by email". Clips live next to the WebSocket room that broadcasts them: fast, and naturally separated per user.

### Local storage on each device

| Where | What |
|---|---|
| Desktop | `%APPDATA%\CopyGlide\session.bin` — session encrypted by the OS (`safeStorage`: DPAPI / Keychain / libsecret); `settings.json` |
| Browser | `localStorage` keys `copyglide.*`: session, theme, sync on/off |

## 4. Security and encryption

```
password ──scrypt(N=2^15, r=8, p=1, salt="clipsync:v1:"+email)──▶ master key (32 bytes)
                 ├─HKDF-SHA256 "clipsync-auth-v1"─▶ authKey ─▶ sent to server (stored as SHA-256(salt:authKey))
                 └─HKDF-SHA256 "clipsync-enc-v1" ─▶ encKey  ─▶ never leaves the device
clip ──XChaCha20-Poly1305(encKey, random 24-byte nonce, AAD = clip id)──▶ ciphertext ─▶ server
```

- The password never leaves the device; the server cannot decrypt clips.
- Trade-off: a forgotten password means old clips can't be recovered.
- The `clipsync` labels are protocol constants from the original codename. **Don't change them**: existing logins would derive different keys.
- JWTs are valid for 1 year and bound to one device. Every authenticated request checks the device still exists, so removing a device revokes it immediately (open sockets are closed with code `4001`).
- The desktop renderer is sandboxed (`contextIsolation`, no Node); it only sees the validated bridge in `apps/desktop/preload.cjs`.

## 5. Sync protocol

REST:

| Method | Path | Notes |
|---|---|---|
| POST | `/api/register` | `{email, authKey, deviceName, platform}` → `{token, userId, deviceId}` |
| POST | `/api/login` | same body and response |
| GET | `/api/devices` | Bearer token |
| DELETE | `/api/devices/:id` | revokes the device |
| GET | `/api/sync?token=…` | WebSocket upgrade, routed to the user's `UserRoom` |

WebSocket messages (`packages/shared/src/protocol.ts`):

| Direction | Message | Meaning |
|---|---|---|
| client → server | `{t:'sync', since}` | send clips newer than `since` |
| client → server | `{t:'push', clip:{id, nonce, ct}}` | store + broadcast a clip |
| client → server | `{t:'delete', id}` / `{t:'clear'}` | delete one / all |
| client → server | `{"t":"ping"}` | keep-alive; answered without waking the object |
| server → client | `{t:'clips', clips, replay}` | `replay:true` = catch-up, `false` = live |
| server → client | `{t:'deleted', ids}` / `{t:'cleared'}` | propagate deletes |

The client reconnects with exponential backoff (max 30 s) and queues messages while offline.

## 6. Desktop internals

- `apps/desktop/src/engine.ts` — sync + clipboard watching in the main process.
- `apps/desktop/src/store.ts` — session/settings persistence.
- `apps/desktop/src/main.ts` — window, tray, IPC.
- The window shows the same React app as the browser; `apps/web/src/backend.ts` switches between the browser running sync itself and mirroring the desktop engine.
- Clipboard polling: 0.5 s while active, 2 s after 1 min idle, paused while locked/asleep, off when sync is paused or "Send what I copy" is off.
- Closing the window destroys the renderer to free memory; the tray keeps syncing.

## 7. Commands

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces |
| `npm run db:migrate` | Create the local D1 tables |
| `npm run dev:server` | Backend at `http://127.0.0.1:8787` (local Cloudflare runtime, no account needed) |
| `npm run dev:web` | UI at `http://localhost:5173` |
| `npm run dev:desktop` | Electron, loading the dev UI |
| `npm run typecheck` | TypeScript checks for all packages |
| `npm run build:all` | Release build → `release/v<version>/` |
| `npm run icons` | Regenerate icons from `brand/` |

### Inspecting the local database

Local data lives in `apps/server/.wrangler/state/` (git-ignored). Delete that folder to reset everything, then run `npm run db:migrate` again.

```bash
cd apps/server
npx wrangler d1 execute copyglide --local --command "SELECT email, plan, datetime(created_at/1000,'unixepoch') AS created FROM users"
npx wrangler d1 execute copyglide --local --command "SELECT name, platform, datetime(last_seen/1000,'unixepoch') AS last_seen FROM devices"
```

Clip history is stored per user in `apps/server/.wrangler/state/v3/do/copyglide-server-UserRoom/<id>.sqlite` (table `clips`). The `ct` column is ciphertext only. The plaintext is visible only in the apps after sign-in. A `clipsync-server-UserRoom` folder there is left over from before the rename and can be deleted.

## 8. Before production

1. Deploy: `wrangler d1 create copyglide` → put the id in `wrangler.jsonc` → `npm run db:migrate:remote` → `wrangler secret put JWT_SECRET` → `npm run deploy`.
2. Build with the real server: `npm run build:all -- --server-url=https://…`.
3. Add rate limiting on `/api/login` and `/api/register`.
4. Not built yet: password reset (only as "reset and lose old clips"), email verification, plan/payment enforcement.
5. Limits: 200,000 characters per text clip; images/files will need R2; WebSocket messages max 1 MB.
6. Signing: Windows installer is unsigned (SmartScreen warning); macOS needs the Apple Developer account for signing + notarization.
7. Next app: `apps/mobile` (Expo) reusing `@copyglide/shared`.
8. Move the end-to-end sync tests into the repo (e.g. Vitest) so they run on every change.
9. Review the `npm audit` warnings (mostly in build/dev tooling).
