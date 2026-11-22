// One interface for the UI, two implementations:
//   - WebBackend:    the browser runs the SyncClient itself.
//   - NativeBackend: the desktop app's main process runs sync; the UI only mirrors its state.
import {
  HISTORY_LIMIT,
  SyncClient,
  hexToBytes,
  type DecryptedClip,
  type Session,
  type SyncStatus,
} from '@clipsync/shared';
import { native, type NativeSettings } from './native';
import { loadBool, saveBool } from './session';

export interface BackendState extends NativeSettings {
  status: SyncStatus;
  clips: DecryptedClip[];
  /** True while the state hasn't loaded yet (desktop). */
  loading: boolean;
}

export interface Backend {
  getState(): BackendState;
  subscribe(cb: () => void): () => void;
  onReceived(cb: (clip: DecryptedClip) => void): () => void;
  onSignedOut(cb: () => void): () => void;
  sendText(text: string): void;
  deleteClip(id: string): void;
  clearAll(): void;
  update(patch: Partial<NativeSettings>): void;
  dispose(): void;
}

abstract class BaseBackend {
  protected state!: BackendState;
  private listeners = new Set<() => void>();
  protected receivedListeners = new Set<(clip: DecryptedClip) => void>();
  protected signedOutListeners = new Set<() => void>();

  getState = (): BackendState => this.state;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  onReceived(cb: (clip: DecryptedClip) => void) {
    this.receivedListeners.add(cb);
    return () => {
      this.receivedListeners.delete(cb);
    };
  }

  onSignedOut(cb: () => void) {
    this.signedOutListeners.add(cb);
    return () => {
      this.signedOutListeners.delete(cb);
    };
  }

  protected set(patch: Partial<BackendState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

function merge(prev: DecryptedClip[], incoming: DecryptedClip[]): DecryptedClip[] {
  const byId = new Map(prev.map((c) => [c.id, c]));
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_LIMIT);
}

/** Disconnect a browser tab that has been in the background this long; reconnect when it's visible again. */
const HIDDEN_DISCONNECT_MS = 5 * 60_000;

class WebBackend extends BaseBackend implements Backend {
  private client: SyncClient;
  private hiddenTimer: number | undefined;
  private hiddenIdle = false;

  constructor(session: Session) {
    super();
    this.state = {
      status: 'stopped',
      syncEnabled: loadBool('clipsync.syncEnabled', true),
      autoSend: false,
      autoCopy: false,
      clips: [],
      loading: false,
    };
    this.client = new SyncClient({
      serverUrl: session.serverUrl,
      token: session.token,
      encKey: hexToBytes(session.encKeyHex),
      onStatus: (status) => this.set({ status }),
      onRevoked: () => this.signedOutListeners.forEach((l) => l()),
      onDeleted: (ids) => this.set({ clips: this.state.clips.filter((c) => !ids.includes(c.id)) }),
      onCleared: () => this.set({ clips: [] }),
      onClips: (incoming, replay) => {
        this.set({ clips: merge(this.state.clips, incoming) });
        if (replay) return;
        const newest = incoming[incoming.length - 1];
        if (newest.deviceId !== session.deviceId) this.receivedListeners.forEach((l) => l(newest));
      },
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('online', this.onFocus);
    this.apply();
  }

  sendText(text: string) {
    if (this.state.syncEnabled) this.client.sendText(text);
  }
  deleteClip(id: string) {
    this.client.deleteClip(id);
  }
  clearAll() {
    this.client.clearAll();
  }
  update(patch: Partial<NativeSettings>) {
    this.set(patch);
    if (patch.syncEnabled !== undefined) saveBool('clipsync.syncEnabled', patch.syncEnabled);
    this.apply();
  }
  dispose() {
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('online', this.onFocus);
    window.clearTimeout(this.hiddenTimer);
    this.client.stop();
  }

  private apply() {
    if (this.state.syncEnabled && !this.hiddenIdle) this.client.start();
    else if (this.client.running) this.client.stop();
  }

  private onVisibility = () => {
    window.clearTimeout(this.hiddenTimer);
    if (document.hidden) {
      this.hiddenTimer = window.setTimeout(() => {
        this.hiddenIdle = true;
        this.apply();
      }, HIDDEN_DISCONNECT_MS);
    } else {
      this.hiddenIdle = false;
      this.apply();
      this.client.reconnectNow();
    }
  };

  private onFocus = () => this.client.reconnectNow();
}

class NativeBackend extends BaseBackend implements Backend {
  private unsubscribe: () => void;

  constructor() {
    super();
    const api = native!;
    this.state = { status: 'connecting', syncEnabled: true, autoSend: true, autoCopy: true, clips: [], loading: true };
    this.unsubscribe = api.onEvent((e) => {
      if (e.type === 'state') this.set({ ...e.state, loading: false });
      else if (e.type === 'received') this.receivedListeners.forEach((l) => l(e.clip));
      else if (e.type === 'signedOut') this.signedOutListeners.forEach((l) => l());
    });
    void api.getState().then((s) => this.set({ ...s, loading: false }));
  }

  sendText(text: string) {
    void native!.sendText(text);
  }
  deleteClip(id: string) {
    void native!.deleteClip(id);
  }
  clearAll() {
    void native!.clearAll();
  }
  update(patch: Partial<NativeSettings>) {
    this.set(patch); // optimistic
    void native!.updateSettings(patch);
  }
  dispose() {
    this.unsubscribe();
  }
}

export function createBackend(session: Session): Backend {
  return native ? new NativeBackend() : new WebBackend(session);
}
