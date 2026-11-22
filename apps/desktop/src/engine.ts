// The desktop sync engine. Runs in the Electron main process so it keeps working with the window closed
// (and the window's renderer process fully destroyed, freeing its memory).
//
// Resource rules:
//   - Sync stopped or signed out  -> no WebSocket, no timers, no clipboard polling.
//   - "Send what I copy" off       -> no clipboard polling (incoming clips still arrive).
//   - Screen locked / sleeping     -> clipboard polling paused; WebSocket closed during sleep.
//   - User idle > 1 min            -> clipboard checked every 2 s instead of every 0.5 s.
import { clipboard, powerMonitor } from 'electron';
import WebSocket from 'ws';
import {
  HISTORY_LIMIT,
  MAX_CLIP_CHARS,
  SyncClient,
  hexToBytes,
  type DecryptedClip,
  type Session,
  type SyncStatus,
} from '@clipsync/shared';
import type { Settings, Store } from './store';

export interface EngineState extends Settings {
  signedIn: boolean;
  status: SyncStatus;
  clips: DecryptedClip[];
}

export type EngineEvent =
  | { type: 'state' }
  | { type: 'received'; clip: DecryptedClip }
  | { type: 'signedOut' };

const ACTIVE_POLL_MS = 500;
const IDLE_POLL_MS = 2000;
const IDLE_AFTER_S = 60;

export class SyncEngine {
  private client: SyncClient | null = null;
  private clips: DecryptedClip[] = [];
  private status: SyncStatus = 'stopped';
  private lastText = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private locked = false;
  private asleep = false;
  private listeners = new Set<(e: EngineEvent) => void>();

  constructor(
    private session: Session | null,
    private settings: Settings,
    private store: Store,
  ) {}

  init(): void {
    powerMonitor.on('lock-screen', () => {
      this.locked = true;
      this.apply();
    });
    powerMonitor.on('unlock-screen', () => {
      this.locked = false;
      this.apply();
    });
    powerMonitor.on('suspend', () => {
      this.asleep = true;
      this.apply();
    });
    powerMonitor.on('resume', () => {
      this.asleep = false;
      this.apply();
    });
    this.apply();
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): EngineState {
    return { ...this.settings, signedIn: !!this.session, status: this.status, clips: this.clips };
  }

  getSession(): Session | null {
    return this.session;
  }

  setSession(session: Session | null): void {
    this.client?.stop();
    this.client = null;
    this.clips = [];
    this.session = session;
    this.store.saveSession(session);
    this.apply();
    this.emitState();
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.store.saveSettings(this.settings);
    this.apply();
    this.emitState();
  }

  sendText(text: string): void {
    if (this.isSyncing()) this.client?.sendText(text);
  }

  deleteClip(id: string): void {
    this.client?.deleteClip(id);
  }

  clearAll(): void {
    this.client?.clearAll();
  }

  /** Write to the system clipboard without it being sent straight back. */
  writeClipboard(text: string): void {
    this.lastText = text;
    clipboard.writeText(text);
  }

  // ---------- internals ----------

  private isSyncing(): boolean {
    return !!this.session && this.settings.syncEnabled;
  }

  /** Bring connection + clipboard watcher in line with the current settings and power state. */
  private apply(): void {
    const connect = this.isSyncing() && !this.asleep;
    if (connect) {
      this.ensureClient().start();
    } else if (this.client?.running) {
      this.client.stop();
    } else if (!this.client) {
      this.status = 'stopped';
    }

    const watch = connect && this.settings.autoSend && !this.locked;
    if (watch) this.startWatcher();
    else this.stopWatcher();
  }

  private ensureClient(): SyncClient {
    if (this.client) return this.client;
    const session = this.session!;
    this.client = new SyncClient({
      serverUrl: session.serverUrl,
      token: session.token,
      encKey: hexToBytes(session.encKeyHex),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onStatus: (status) => {
        this.status = status;
        this.emitState();
      },
      onRevoked: () => {
        this.setSession(null);
        this.emit({ type: 'signedOut' });
      },
      onDeleted: (ids) => {
        this.clips = this.clips.filter((c) => !ids.includes(c.id));
        this.emitState();
      },
      onCleared: () => {
        this.clips = [];
        this.emitState();
      },
      onClips: (incoming, replay) => {
        const byId = new Map(this.clips.map((c) => [c.id, c]));
        for (const c of incoming) byId.set(c.id, c);
        this.clips = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_LIMIT);
        this.emitState();
        if (replay) return;
        const newest = incoming[incoming.length - 1];
        if (newest.deviceId === session.deviceId) return;
        if (this.settings.autoCopy) this.writeClipboard(newest.text);
        this.emit({ type: 'received', clip: newest });
      },
    });
    return this.client;
  }

  private startWatcher(): void {
    if (this.pollTimer) return;
    this.lastText = clipboard.readText(); // whatever was copied while stopped is not sent
    this.scheduleTick();
  }

  private stopWatcher(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private scheduleTick(): void {
    const idle = powerMonitor.getSystemIdleTime() > IDLE_AFTER_S;
    this.pollTimer = setTimeout(() => this.tick(), idle ? IDLE_POLL_MS : ACTIVE_POLL_MS);
  }

  private tick(): void {
    const text = clipboard.readText();
    if (text && text !== this.lastText) {
      this.lastText = text;
      if (text.trim() && text.length <= MAX_CLIP_CHARS && this.clips[0]?.text !== text) {
        this.client?.sendText(text);
      }
    }
    this.scheduleTick();
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Coalesce bursts of changes into one state update. */
  private emitState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.emit({ type: 'state' });
    }, 50);
  }
}
