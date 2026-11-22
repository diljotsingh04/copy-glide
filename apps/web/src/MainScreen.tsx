import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { listDevices, MAX_CLIP_CHARS, removeDevice, type DecryptedClip, type DeviceInfo, type Session } from '@clipsync/shared';
import { createBackend, type Backend } from './backend';
import { copyToClipboard, native } from './native';

const PLATFORM_ICON: Record<string, string> = {
  windows: '🪟',
  macos: '🍎',
  linux: '🐧',
  android: '🤖',
  ios: '📱',
  web: '🌐',
};

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

interface Props {
  session: Session;
  onLogout: () => void;
}

/** Creates the sync backend for this session and tears it down on logout/unmount. */
export function MainScreen(props: Props) {
  const [backend, setBackend] = useState<Backend | null>(null);
  useEffect(() => {
    const b = createBackend(props.session);
    setBackend(b);
    return () => b.dispose();
  }, [props.session]);
  return backend ? <Main {...props} backend={backend} /> : null;
}

function Main({ session, onLogout, backend }: Props & { backend: Backend }) {
  const state = useSyncExternalStore(backend.subscribe, backend.getState);
  const { clips, status, syncEnabled, autoSend, autoCopy } = state;
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [tab, setTab] = useState<'history' | 'devices'>('history');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState('');
  const [, tick] = useState(0);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? '' : t)), 2500);
  }, []);

  const deviceName = useCallback(
    (id: string) =>
      id === session.deviceId ? 'This device' : (devicesRef.current.find((d) => d.id === id)?.name ?? 'Another device'),
    [session.deviceId],
  );

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listDevices(session));
    } catch (err) {
      if ((err as { status?: number }).status === 401) onLogout();
    }
  }, [session, onLogout]);

  useEffect(() => {
    void refreshDevices();
    const offSignedOut = backend.onSignedOut(onLogout);
    const offReceived = backend.onReceived((clip: DecryptedClip) => {
      if (!devicesRef.current.some((d) => d.id === clip.deviceId)) void refreshDevices();
      const from = deviceName(clip.deviceId);
      showToast(native && backend.getState().autoCopy ? `Copied from ${from}` : `New clip from ${from}`);
    });
    // Re-render "2m ago" labels only while the window is visible.
    const timer = window.setInterval(() => {
      if (!document.hidden) tick((n) => n + 1);
    }, 30_000);
    return () => {
      offSignedOut();
      offReceived();
      window.clearInterval(timer);
    };
  }, [backend, onLogout, refreshDevices, deviceName, showToast]);

  function sendDraft() {
    if (!draft.trim()) return;
    if (draft.length > MAX_CLIP_CHARS) return showToast('That clip is too large');
    backend.sendText(draft);
    setDraft('');
  }

  async function pasteAndSend() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return showToast('Your clipboard is empty');
      backend.sendText(text);
      showToast('Sent to your devices');
    } catch {
      showToast('Clipboard access was blocked. Paste into the box instead.');
    }
  }

  async function copy(clip: DecryptedClip) {
    try {
      await copyToClipboard(clip.text);
      showToast('Copied');
    } catch {
      showToast('Could not copy');
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? clips.filter((c) => c.text.toLowerCase().includes(q)) : clips;
  }, [clips, query]);

  const statusText = !syncEnabled
    ? 'Stopped'
    : status === 'online'
      ? 'Synced'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Offline';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand small">
          <span className="logo" aria-hidden>
            ⧉
          </span>
          <strong>ClipSync</strong>
        </div>
        <div className="topbar-right">
          <span className={`status ${syncEnabled ? status : 'stopped'}`}>
            <span className="dot" /> {statusText}
          </span>
          <button
            className={`power ${syncEnabled ? 'on' : 'off'}`}
            onClick={() => backend.update({ syncEnabled: !syncEnabled })}
            title={syncEnabled ? 'Stop syncing on this device' : 'Start syncing on this device'}
          >
            {syncEnabled ? '⏸ Stop' : '▶ Start'}
          </button>
        </div>
      </header>

      {!syncEnabled && (
        <div className="banner">
          <span>
            Sync is stopped on this device. Nothing is sent or received
            {native ? ' and the clipboard isn’t being watched.' : '.'}
          </span>
          <button className="primary sm" onClick={() => backend.update({ syncEnabled: true })}>
            Start sync
          </button>
        </div>
      )}

      <nav className="tabs">
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History <span className="count">{clips.length}</span>
        </button>
        <button
          className={tab === 'devices' ? 'active' : ''}
          onClick={() => {
            setTab('devices');
            void refreshDevices();
          }}
        >
          Devices &amp; settings
        </button>
      </nav>

      {tab === 'history' ? (
        <main className="content">
          <div className="composer">
            <textarea
              placeholder={
                native ? 'Copy anything — it syncs automatically. Or type here…' : 'Type or paste text to send to your devices…'
              }
              value={draft}
              rows={2}
              disabled={!syncEnabled}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendDraft();
              }}
            />
            <div className="row">
              {!native && (
                <button className="ghost" onClick={pasteAndSend} disabled={!syncEnabled}>
                  Paste from clipboard
                </button>
              )}
              <button className="primary" onClick={sendDraft} disabled={!syncEnabled || !draft.trim()}>
                Send
              </button>
            </div>
          </div>

          <input className="search" placeholder="Search history…" value={query} onChange={(e) => setQuery(e.target.value)} />

          {filtered.length === 0 ? (
            <div className="empty">
              {clips.length === 0 ? (
                <>
                  <p>No clips yet.</p>
                  <p className="muted">
                    {native ? 'Copy something on this computer' : 'Send something'}, or log in on another device with the same
                    account.
                  </p>
                </>
              ) : (
                <p className="muted">Nothing matches “{query}”.</p>
              )}
            </div>
          ) : (
            <ul className="clips">
              {filtered.map((clip) => (
                <li key={clip.id} className="clip">
                  <button className="clip-body" onClick={() => copy(clip)} title="Click to copy">
                    <pre>{clip.text.length > 600 ? clip.text.slice(0, 600) + '…' : clip.text}</pre>
                  </button>
                  <div className="clip-meta">
                    <span>
                      {deviceName(clip.deviceId)} · {timeAgo(clip.createdAt)}
                    </span>
                    <span className="actions">
                      <button className="ghost sm" onClick={() => copy(clip)}>
                        Copy
                      </button>
                      <button
                        className="ghost sm"
                        onClick={() => backend.deleteClip(clip.id)}
                        disabled={!syncEnabled}
                        aria-label="Delete clip"
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {clips.length > 0 && syncEnabled && (
            <button
              className="link danger"
              onClick={() => {
                if (confirm('Delete the whole clipboard history on all your devices?')) backend.clearAll();
              }}
            >
              Clear all history
            </button>
          )}
        </main>
      ) : (
        <main className="content">
          <h3 className="section-title">Your devices</h3>
          <ul className="devices">
            {devices.map((d) => (
              <li key={d.id} className="device">
                <span className="device-icon">{PLATFORM_ICON[d.platform] ?? '💻'}</span>
                <span className="device-info">
                  <strong>
                    {d.name} {d.id === session.deviceId && <span className="badge">This device</span>}
                  </strong>
                  <span className="muted">
                    {d.platform} · active {timeAgo(d.lastSeen)}
                  </span>
                </span>
                {d.id !== session.deviceId && (
                  <button
                    className="ghost sm"
                    onClick={async () => {
                      if (!confirm(`Remove “${d.name}”? It will be signed out.`)) return;
                      await removeDevice(session, d.id).catch(() => showToast('Could not remove device'));
                      void refreshDevices();
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3 className="section-title">This device</h3>
          <section className="settings">
            <label className="toggle">
              <input type="checkbox" checked={syncEnabled} onChange={(e) => backend.update({ syncEnabled: e.target.checked })} />
              <span>
                Sync enabled
                <small className="muted">Turn off to stop all syncing on this device. Uses no network or CPU while off.</small>
              </span>
            </label>
            {native && (
              <>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={autoSend}
                    disabled={!syncEnabled}
                    onChange={(e) => backend.update({ autoSend: e.target.checked })}
                  />
                  <span>
                    Send what I copy on this computer
                    <small className="muted">When off, the clipboard isn’t watched at all.</small>
                  </span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={autoCopy}
                    disabled={!syncEnabled}
                    onChange={(e) => backend.update({ autoCopy: e.target.checked })}
                  />
                  <span>
                    Put clips from other devices on this computer’s clipboard
                    <small className="muted">When off, they only appear in History.</small>
                  </span>
                </label>
              </>
            )}
            <p className="muted">Signed in as {session.email}</p>
            <button className="ghost" onClick={onLogout}>
              Log out of this device
            </button>
          </section>
        </main>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
