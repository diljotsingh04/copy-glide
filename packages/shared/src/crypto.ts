// End-to-end encryption.
//
// The user's password never leaves the device. From it we derive:
//   - authKey: sent to the server instead of the password (server stores only a salted hash of it)
//   - encKey:  encrypts every clip; never sent anywhere
// So the server can authenticate the user but cannot read their clipboard.
import { scryptAsync } from '@noble/hashes/scrypt';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { fromBase64, toBase64 } from './base64';
import type { ClipEnvelope, ClipPayload } from './protocol';

export { bytesToHex, hexToBytes };

export interface AccountKeys {
  authKey: string; // hex, sent to the server
  encKey: Uint8Array; // stays on the device
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function deriveAccountKeys(email: string, password: string): Promise<AccountKeys> {
  // Key-derivation labels are protocol constants (kept from the original codename); changing them breaks existing logins.
  const salt = utf8ToBytes('clipsync:v1:' + normalizeEmail(email));
  const master = await scryptAsync(utf8ToBytes(password), salt, { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
  const authKey = bytesToHex(hkdf(sha256, master, undefined, 'clipsync-auth-v1', 32));
  const encKey = hkdf(sha256, master, undefined, 'clipsync-enc-v1', 32);
  return { authKey, encKey };
}

export function encryptClip(encKey: Uint8Array, id: string, payload: ClipPayload): { nonce: string; ct: string } {
  const nonce = randomBytes(24);
  // The clip id is bound as associated data so ciphertexts can't be swapped between clips.
  const cipher = xchacha20poly1305(encKey, nonce, utf8ToBytes(id));
  const ct = cipher.encrypt(utf8ToBytes(JSON.stringify(payload)));
  return { nonce: toBase64(nonce), ct: toBase64(ct) };
}

export function decryptClip(encKey: Uint8Array, clip: Pick<ClipEnvelope, 'id' | 'nonce' | 'ct'>): ClipPayload {
  const cipher = xchacha20poly1305(encKey, fromBase64(clip.nonce), utf8ToBytes(clip.id));
  const plain = cipher.decrypt(fromBase64(clip.ct));
  return JSON.parse(new TextDecoder().decode(plain)) as ClipPayload;
}

export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return bytesToHex(randomBytes(16));
}
