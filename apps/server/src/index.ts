import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { DeviceInfo, Platform } from '@copyglide/shared/src/protocol';
import { UserRoom } from './room';

export { UserRoom };

type Env = {
  DB: D1Database;
  ROOM: DurableObjectNamespace<UserRoom>;
  JWT_SECRET: string;
};
type Vars = { userId: string; deviceId: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('/api/*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'] }));

app.get('/', (c) => c.json({ ok: true, service: 'copyglide' }));

// ---------- helpers ----------

const PLATFORMS: Platform[] = ['windows', 'macos', 'linux', 'android', 'ios', 'web'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_KEY_RE = /^[0-9a-f]{64}$/;
const TOKEN_TTL_S = 60 * 60 * 24 * 365;

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashAuthKey(salt: string, authKey: string): Promise<string> {
  // authKey is already a 256-bit key stretched with scrypt on the client, so one salted SHA-256 is enough here.
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${authKey}`)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface AuthBody {
  email?: unknown;
  authKey?: unknown;
  deviceName?: unknown;
  platform?: unknown;
}

function parseAuthBody(body: AuthBody) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const authKey = typeof body.authKey === 'string' ? body.authKey : '';
  const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 64) : '';
  const platform = PLATFORMS.includes(body.platform as Platform) ? (body.platform as Platform) : 'web';
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Enter a valid email address' } as const;
  if (!AUTH_KEY_RE.test(authKey)) return { error: 'Invalid credentials' } as const;
  return { email, authKey, deviceName: deviceName || 'Unnamed device', platform } as const;
}

async function createDeviceAndToken(env: Env, userId: string, name: string, platform: Platform) {
  const deviceId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO devices (id, user_id, name, platform, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(deviceId, userId, name, platform, now, now)
    .run();
  const iat = Math.floor(now / 1000);
  const token = await sign({ sub: userId, did: deviceId, iat, exp: iat + TOKEN_TTL_S }, env.JWT_SECRET, 'HS256');
  return { token, userId, deviceId };
}

// ---------- auth ----------

app.post('/api/register', async (c) => {
  const parsed = parseAuthBody(await c.req.json<AuthBody>().catch(() => ({})));
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(parsed.email).first();
  if (existing) return c.json({ error: 'An account with this email already exists. Log in instead.' }, 409);

  const userId = crypto.randomUUID();
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await c.env.DB.prepare('INSERT INTO users (id, email, auth_hash, auth_salt, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, parsed.email, await hashAuthKey(salt, parsed.authKey), salt, Date.now())
    .run();

  return c.json(await createDeviceAndToken(c.env, userId, parsed.deviceName, parsed.platform));
});

app.post('/api/login', async (c) => {
  const parsed = parseAuthBody(await c.req.json<AuthBody>().catch(() => ({})));
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const user = await c.env.DB.prepare('SELECT id, auth_hash, auth_salt FROM users WHERE email = ?')
    .bind(parsed.email)
    .first<{ id: string; auth_hash: string; auth_salt: string }>();
  const ok = user && safeEqual(await hashAuthKey(user.auth_salt, parsed.authKey), user.auth_hash);
  if (!user || !ok) return c.json({ error: 'Wrong email or password' }, 401);

  return c.json(await createDeviceAndToken(c.env, user.id, parsed.deviceName, parsed.platform));
});

// ---------- authenticated routes ----------

const requireAuth = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token');
  if (!token) return c.json({ error: 'Not signed in' }, 401);
  let payload: { sub?: unknown; did?: unknown };
  try {
    payload = (await verify(token, c.env.JWT_SECRET, 'HS256')) as typeof payload;
  } catch {
    return c.json({ error: 'Session expired. Please log in again.' }, 401);
  }
  const userId = String(payload.sub);
  const deviceId = String(payload.did);
  const res = await c.env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND user_id = ?')
    .bind(Date.now(), deviceId, userId)
    .run();
  if (!res.meta.changes) return c.json({ error: 'This device was removed. Please log in again.' }, 401);
  c.set('userId', userId);
  c.set('deviceId', deviceId);
  await next();
});

app.use('/api/devices', requireAuth);
app.use('/api/devices/*', requireAuth);
app.use('/api/sync', requireAuth);

app.get('/api/devices', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, platform, created_at AS createdAt, last_seen AS lastSeen
     FROM devices WHERE user_id = ? ORDER BY last_seen DESC`,
  )
    .bind(c.get('userId'))
    .all<DeviceInfo>();
  return c.json({ devices: results, currentDeviceId: c.get('deviceId') });
});

app.delete('/api/devices/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').bind(id, userId).run();
  if (!res.meta.changes) return c.json({ error: 'Device not found' }, 404);
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(userId));
  await room.fetch(`https://room/kick?device=${encodeURIComponent(id)}`);
  return c.json({ ok: true });
});

app.get('/api/sync', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected a WebSocket upgrade' }, 426);
  }
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(c.get('userId')));
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Device-Id', c.get('deviceId'));
  return room.fetch('https://room/ws', { headers });
});

export default app;
