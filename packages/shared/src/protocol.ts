// Wire protocol shared by every client and the server.

/** An encrypted clip as stored and relayed by the server. The server never sees plaintext. */
export interface ClipEnvelope {
  id: string;
  deviceId: string;
  createdAt: number;
  nonce: string; // base64
  ct: string; // base64 ciphertext of a ClipPayload
}

/** What is inside the ciphertext. More kinds (image, file) will be added later. */
export interface ClipPayload {
  kind: 'text';
  text: string;
}

export type ClientMessage =
  | { t: 'sync'; since: number }
  | { t: 'push'; clip: { id: string; nonce: string; ct: string } }
  | { t: 'delete'; id: string }
  | { t: 'clear' };

export type ServerMessage =
  /** replay=true for history sent in answer to `sync`; false for live clips. */
  | { t: 'clips'; clips: ClipEnvelope[]; replay: boolean }
  | { t: 'deleted'; ids: string[] }
  | { t: 'cleared' }
  | { t: 'error'; message: string };

export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web';

export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
  createdAt: number;
  lastSeen: number;
}

export const MAX_CLIP_CHARS = 200_000;
export const HISTORY_LIMIT = 500;
/** Close code the server uses when a device was removed from the account. */
export const CLOSE_DEVICE_REMOVED = 4001;
