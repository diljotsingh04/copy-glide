// Real-time sync over a WebSocket to the user's "room" on the server.
// Handles encryption, reconnects with backoff, keep-alive pings and an offline send queue.
import { decryptClip, encryptClip, newId } from './crypto';
import {
  CLOSE_DEVICE_REMOVED,
  MAX_CLIP_CHARS,
  type ClientMessage,
  type ClipEnvelope,
  type ServerMessage,
} from './protocol';

/** stopped = sync turned off (no connection, no network or CPU use). */
export type SyncStatus = 'stopped' | 'connecting' | 'online' | 'offline';

export interface DecryptedClip {
  id: string;
  deviceId: string;
  createdAt: number;
  kind: 'text';
  text: string;
}

export interface SyncClientOptions {
  serverUrl: string;
  token: string;
  encKey: Uint8Array;
  /** replay=true: history catch-up (don't auto-copy). replay=false: a live clip just arrived. */
  onClips: (clips: DecryptedClip[], replay: boolean) => void;
  onDeleted?: (ids: string[]) => void;
  onCleared?: () => void;
  onStatus?: (status: SyncStatus) => void;
  /** Called when this device was removed from the account. */
  onRevoked?: () => void;
  /** WebSocket implementation for runtimes without a global one (e.g. the `ws` package in Node/Electron main). */
  WebSocketImpl?: typeof WebSocket;
}

const PING_MS = 30_000;
const OPEN = 1; // WebSocket.OPEN as a literal, so it works with any implementation

export class SyncClient {
  private ws?: WebSocket;
  private attempts = 0;
  private stopped = true;
  private since = 0;
  private queue: ClientMessage[] = [];
  private pingTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(private opts: SyncClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000);
    } catch {
      /* not open yet */
    }
    this.opts.onStatus?.('stopped');
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Encrypts and sends a text clip. Returns the clip id. Queued if offline. */
  sendText(text: string): string | null {
    if (!text || text.length > MAX_CLIP_CHARS) return null;
    const id = newId();
    const { nonce, ct } = encryptClip(this.opts.encKey, id, { kind: 'text', text });
    this.send({ t: 'push', clip: { id, nonce, ct } });
    return id;
  }

  deleteClip(id: string): void {
    this.send({ t: 'delete', id });
  }

  clearAll(): void {
    this.send({ t: 'clear' });
  }

  /** Force an immediate reconnect, e.g. when the app returns to the foreground. */
  reconnectNow(): void {
    if (this.stopped || this.ws?.readyState === OPEN) return;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.connect();
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  private connect() {
    this.opts.onStatus?.('connecting');
    const url =
      this.opts.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws') +
      '/api/sync?token=' +
      encodeURIComponent(this.opts.token);
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.opts.onStatus?.('online');
      ws.send(JSON.stringify({ t: 'sync', since: this.since } satisfies ClientMessage));
      for (const msg of this.queue.splice(0)) ws.send(JSON.stringify(msg));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === OPEN) ws.send('{"t":"ping"}');
      }, PING_MS);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMessage | { t: 'pong' };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.opts.onStatus?.('offline');
      if (ev.code === CLOSE_DEVICE_REMOVED) {
        this.stopped = true;
        this.opts.onRevoked?.();
        return;
      }
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempts++) + Math.random() * 500;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      /* onclose handles reconnect */
    };
  }

  private handle(msg: ServerMessage | { t: 'pong' }) {
    switch (msg.t) {
      case 'clips': {
        const out: DecryptedClip[] = [];
        for (const env of msg.clips) {
          this.since = Math.max(this.since, env.createdAt);
          const clip = this.decrypt(env);
          if (clip) out.push(clip);
        }
        if (out.length) this.opts.onClips(out, msg.replay);
        break;
      }
      case 'deleted':
        this.opts.onDeleted?.(msg.ids);
        break;
      case 'cleared':
        this.opts.onCleared?.();
        break;
      case 'error':
        console.warn('[copyglide] server error:', msg.message);
        break;
    }
  }

  private decrypt(env: ClipEnvelope): DecryptedClip | null {
    try {
      const payload = decryptClip(this.opts.encKey, env);
      return { id: env.id, deviceId: env.deviceId, createdAt: env.createdAt, kind: payload.kind, text: payload.text };
    } catch {
      console.warn('[copyglide] could not decrypt clip', env.id);
      return null;
    }
  }
}
