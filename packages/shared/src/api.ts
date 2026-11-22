// REST client for account and device management.
import { bytesToHex, deriveAccountKeys, normalizeEmail } from './crypto';
import type { DeviceInfo, Platform } from './protocol';

/** Everything a device needs to stay signed in. Store it securely on the device. */
export interface Session {
  serverUrl: string;
  token: string;
  userId: string;
  deviceId: string;
  email: string;
  encKeyHex: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  serverUrl: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(serverUrl.replace(/\/+$/, '') + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface AuthInput {
  serverUrl: string;
  email: string;
  password: string;
  deviceName: string;
  platform: Platform;
}

async function authenticate(mode: 'register' | 'login', input: AuthInput): Promise<Session> {
  const email = normalizeEmail(input.email);
  const keys = await deriveAccountKeys(email, input.password);
  const res = await request<{ token: string; userId: string; deviceId: string }>(input.serverUrl, `/api/${mode}`, {
    method: 'POST',
    body: { email, authKey: keys.authKey, deviceName: input.deviceName, platform: input.platform },
  });
  return { serverUrl: input.serverUrl, email, ...res, encKeyHex: bytesToHex(keys.encKey) };
}

export const signUp = (input: AuthInput) => authenticate('register', input);
export const logIn = (input: AuthInput) => authenticate('login', input);

export async function listDevices(s: Session): Promise<DeviceInfo[]> {
  const res = await request<{ devices: DeviceInfo[] }>(s.serverUrl, '/api/devices', { token: s.token });
  return res.devices;
}

export async function removeDevice(s: Session, deviceId: string): Promise<void> {
  await request(s.serverUrl, `/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', token: s.token });
}
