import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent } from 'react';
import {
  ArrowUp,
  Check,
  ClipboardPaste,
  Clock,
  Copy,
  ExternalLink,
  KeyRound,
  LogOut,
  Monitor,
  MonitorSmartphone,
  Moon,
  Pause,
  Play,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  SunMoon,
  Trash2,
  X,
} from 'lucide-react';
import { listDevices, MAX_CLIP_CHARS, removeDevice, type DecryptedClip, type DeviceInfo, type Session } from '@copyglide/shared';
import { createBackend, type Backend, type BackendState } from './backend';
import { dayLabel, describeClip, timeAgo } from './clipKind';
import { copyToClipboard, modKey, native, openLink } from './native';
import { useTheme, type ThemePref } from './theme';
import { useConfirm } from './ui/Confirm';
import { Kbd, Segmented, Switch } from './ui/controls';
import { KIND_ICON, platformInfo } from './ui/icons';
import { Logo, Wordmark } from './ui/Logo';
import { useToast } from './ui/Toast';

type Tab = 'history' | 'devices' | 'settings';

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
  const [tab, setTab] = useState<Tab>('history');
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const toast = useToast();
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const deviceName = useCallback(
    (id: string) => (id === session.deviceId ? 'This device' : (devicesRef.current.find((d) => d.id === id)?.name ?? 'Another device')),
    [session.deviceId],
  );
  const devicePlatform = useCallback((id: string) => devicesRef.current.find((d) => d.id === id)?.platform ?? 'web', []);

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
    const offReceived = backend.onReceived((clip) => {
      if (!devicesRef.current.some((d) => d.id === clip.deviceId)) void refreshDevices();
      const from = deviceName(clip.deviceId);
      toast(native && backend.getState().autoCopy ? `Copied from ${from}` : `New from ${from}`, 'info');
    });
    return () => {
      offSignedOut();
      offReceived();
    };
  }, [backend, onLogout, refreshDevices, deviceName, toast]);

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          <Logo size={24} />
          <Wordmark />
        </div>
        <div className="titlebar-spacer" />
        <StatusPill state={state} />
        <Switch
          checked={state.syncEnabled}
          onChange={(v) => {
            backend.update({ syncEnabled: v });
            toast(v ? 'Sync resumed' : 'Sync paused', v ? 'success' : 'info');
          }}
          label={state.syncEnabled ? 'Stop syncing on this device' : 'Start syncing on this device'}
        />
      </header>

      <div className={`paused-banner ${state.syncEnabled ? '' : 'show'}`} aria-hidden={state.syncEnabled}>
        <div className="paused-inner">
          <Pause size={15} />
          <span>Sync is paused on this device. Nothing is sent or received.</span>
          <button className="btn primary sm" onClick={() => backend.update({ syncEnabled: true })} tabIndex={state.syncEnabled ? -1 : 0}>
            <Play size={13} /> Resume
          </button>
        </div>
      </div>

      <nav className="nav">
        <Segmented<Tab>
          value={tab}
          onChange={(t) => {
            setTab(t);
            if (t === 'devices') void refreshDevices();
          }}
          options={[
            { value: 'history', label: 'History', icon: <Clock size={15} />, badge: state.clips.length },
            { value: 'devices', label: 'Devices', icon: <MonitorSmartphone size={15} /> },
            { value: 'settings', label: 'Settings', icon: <SettingsIcon size={15} /> },
          ]}
        />
      </nav>

      <main className="content" key={tab}>
        {tab === 'history' && (
          <HistoryView backend={backend} state={state} session={session} deviceName={deviceName} devicePlatform={devicePlatform} />
        )}
        {tab === 'devices' && <DevicesView devices={devices} session={session} onChanged={refreshDevices} />}
        {tab === 'settings' && <SettingsView backend={backend} state={state} session={session} onLogout={onLogout} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Header status
// ---------------------------------------------------------------------------------------------

function StatusPill({ state }: { state: BackendState }) {
  const s = !state.syncEnabled ? 'paused' : state.status;
  const label = s === 'paused' ? 'Paused' : s === 'online' ? 'Synced' : s === 'connecting' ? 'Connecting' : s === 'stopped' ? 'Paused' : 'Offline';
  return (
    <span className={`status-pill ${s}`} title={s === 'offline' ? 'Offline — retrying automatically' : label}>
      <span className="status-dot" />
      <span className="status-label">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

function HistoryView({
  backend,
  state,
  session,
  deviceName,
  devicePlatform,
}: {
  backend: Backend;
  state: BackendState;
  session: Session;
  deviceName: (id: string) => string;
  devicePlatform: (id: string) => string;
}) {
  const { clips, syncEnabled } = state;
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(-1);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [, tick] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const mountedAt = useRef(Date.now());
  const seen = useRef(new Set<string>());

  // Highlight clips that arrive while the view is open (not the initial history load).
  useEffect(() => {
    const settled = Date.now() - mountedAt.current > 1200;
    const added: string[] = [];
    for (const c of clips) {
      if (!seen.current.has(c.id)) {
        seen.current.add(c.id);
        if (settled) added.push(c.id);
      }
    }
    if (!added.length) return;
    setFresh((f) => new Set([...f, ...added]));
    const t = window.setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), 1800);
    return () => window.clearTimeout(t);
  }, [clips]);

  // Refresh "2m ago" labels while visible.
  useEffect(() => {
    const t = window.setInterval(() => !document.hidden && tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? clips.filter((c) => c.text.toLowerCase().includes(q)) : clips;
  }, [clips, query]);

  const copy = useCallback(
    async (clip: DecryptedClip) => {
      try {
        await copyToClipboard(clip.text);
        setCopiedId(clip.id);
        navigator.vibrate?.(8);
        window.setTimeout(() => setCopiedId((id) => (id === clip.id ? null : id)), 1400);
      } catch {
        toast('Could not copy', 'error');
      }
    },
    [toast],
  );

  const remove = useCallback(
    (clip: DecryptedClip) => {
      setRemoving((r) => new Set(r).add(clip.id));
      window.setTimeout(() => backend.deleteClip(clip.id), 220);
    },
    [backend],
  );

  function send() {
    const text = draft;
    if (!text.trim()) return;
    if (text.length > MAX_CLIP_CHARS) return toast('That clip is too large', 'error');
    backend.sendText(text);
    setDraft('');
    resizeDraft(true);
  }

  async function pasteAndSend() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return toast('Your clipboard is empty', 'info');
      backend.sendText(text);
      toast('Sent to your devices');
    } catch {
      toast('Clipboard access was blocked — paste into the box instead', 'error');
    }
  }

  function resizeDraft(reset = false) {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (!reset) el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }

  // Keyboard: Ctrl/⌘+K or / to search, ↑↓ to move, Enter to copy, Delete to remove, Esc to clear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === 'Escape') {
        if (query) setQuery('');
        setSelected(-1);
        (document.activeElement as HTMLElement)?.blur();
        return;
      }
      if (typing && target !== searchRef.current) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => {
          const n = filtered.length;
          if (!n) return -1;
          const next = e.key === 'ArrowDown' ? Math.min(n - 1, i + 1) : Math.max(0, i - 1);
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return next;
        });
      } else if (e.key === 'Enter' && selected >= 0 && filtered[selected]) {
        e.preventDefault();
        void copy(filtered[selected]);
      } else if ((e.key === 'Delete' || (e.key === 'Backspace' && !typing)) && selected >= 0 && filtered[selected] && syncEnabled) {
        e.preventDefault();
        remove(filtered[selected]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, selected, query, copy, remove, syncEnabled]);

  useEffect(() => setSelected(-1), [query]);

  const groups = useMemo(() => {
    const out: { label: string; items: { clip: DecryptedClip; index: number }[] }[] = [];
    filtered.forEach((clip, index) => {
      const label = dayLabel(clip.createdAt);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1)!.items.push({ clip, index });
    });
    return out;
  }, [filtered]);

  const loading = state.loading || (state.status === 'connecting' && clips.length === 0 && syncEnabled);

  return (
    <>
      <div className={`composer ${draft ? 'has-text' : ''}`}>
        <textarea
          ref={draftRef}
          rows={1}
          placeholder={native ? 'Copy anything — or type to send…' : 'Type or paste to send to your devices…'}
          value={draft}
          disabled={!syncEnabled}
          onChange={(e) => {
            setDraft(e.target.value);
            resizeDraft();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          {!native && !draft && (
            <button className="icon-btn" onClick={pasteAndSend} disabled={!syncEnabled} title="Send what's on your clipboard">
              <ClipboardPaste size={17} />
            </button>
          )}
          <button className="send-btn" onClick={send} disabled={!syncEnabled || !draft.trim()} title={`Send (${modKey} Enter)`}>
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        </div>
      </div>

      <div className="search">
        <Search size={16} className="search-icon" />
        <input ref={searchRef} placeholder="Search history" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query ? (
          <button className="icon-btn sm" onClick={() => setQuery('')} aria-label="Clear search">
            <X size={14} />
          </button>
        ) : (
          <span className="search-kbd">
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        )}
      </div>

      {loading ? (
        <ul className="clip-list">
          {[0, 1, 2].map((i) => (
            <li key={i} className="clip skeleton" style={{ animationDelay: `${i * 80}ms` }}>
              <span className="sk sk-icon" />
              <span className="sk-lines">
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </span>
            </li>
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        <EmptyState hasClips={clips.length > 0} query={query} email={session.email} />
      ) : (
        <ul className="clip-list" ref={listRef}>
          {groups.map((g) => (
            <GroupedItems key={g.label} label={g.label}>
              {g.items.map(({ clip, index }) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  from={deviceName(clip.deviceId)}
                  platform={clip.deviceId === session.deviceId ? (native ? (native.platform === 'darwin' ? 'macos' : native.platform === 'win32' ? 'windows' : 'linux') : 'web') : devicePlatform(clip.deviceId)}
                  selected={index === selected}
                  copied={copiedId === clip.id}
                  fresh={fresh.has(clip.id)}
                  removing={removing.has(clip.id)}
                  canDelete={syncEnabled}
                  query={query}
                  onCopy={() => copy(clip)}
                  onDelete={() => remove(clip)}
                  onHover={() => setSelected(index)}
                />
              ))}
            </GroupedItems>
          ))}
        </ul>
      )}

      {clips.length > 0 && !query && (
        <p className="list-foot">
          {clips.length} {clips.length === 1 ? 'clip' : 'clips'} · end-to-end encrypted
          {syncEnabled && (
            <>
              {' · '}
              <button
                className="link-btn"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Clear all history?',
                    body: 'This deletes every clip on all your devices. It can’t be undone.',
                    confirmLabel: 'Clear history',
                    danger: true,
                  });
                  if (ok) {
                    backend.clearAll();
                    toast('History cleared');
                  }
                }}
              >
                Clear all
              </button>
            </>
          )}
        </p>
      )}
    </>
  );
}

function GroupedItems({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <li className="group-label" role="presentation">
        {label}
      </li>
      {children}
    </>
  );
}

function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

const SWIPE_ACTION = 88;

function ClipCard({
  clip,
  from,
  platform,
  selected,
  copied,
  fresh,
  removing,
  canDelete,
  query,
  onCopy,
  onDelete,
  onHover,
}: {
  clip: DecryptedClip;
  from: string;
  platform: string;
  selected: boolean;
  copied: boolean;
  fresh: boolean;
  removing: boolean;
  canDelete: boolean;
  query: string;
  onCopy: () => void;
  onDelete: () => void;
  onHover: () => void;
}) {
  const info = useMemo(() => describeClip(clip.text), [clip.text]);
  const KindIcon = KIND_ICON[info.kind];
  const PlatformIcon = platformInfo(platform).icon;
  const preview = clip.text.length > 900 ? clip.text.slice(0, 900) + '…' : clip.text;

  // Swipe gesture (touch & pen): right = copy, left = delete.
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; active: boolean; locked: boolean } | null>(null);
  const suppressClick = useRef(false);

  function onPointerDown(e: RPointerEvent) {
    if (e.pointerType === 'mouse') return;
    drag.current = { x: e.clientX, y: e.clientY, active: false, locked: false };
  }
  function onPointerMove(e: RPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.active && !d.locked) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) d.locked = true; // vertical scroll
      else if (Math.abs(mx) > 10) {
        d.active = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
    }
    if (d.active) {
      const limited = !canDelete && mx < 0 ? mx / 4 : mx;
      setDx(Math.max(-160, Math.min(160, limited)));
    }
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    suppressClick.current = true;
    if (dx > SWIPE_ACTION) onCopy();
    else if (dx < -SWIPE_ACTION && canDelete) {
      setDx(-400);
      onDelete();
      return;
    }
    setDx(0);
  }

  const cls = ['clip', selected && 'selected', copied && 'copied', fresh && 'fresh', removing && 'removing', dx !== 0 && 'dragging']
    .filter(Boolean)
    .join(' ');

  return (
    <li className={cls} onMouseEnter={onHover}>
      <div className={`swipe-under ${dx > 0 ? 'copy' : 'delete'} ${Math.abs(dx) > SWIPE_ACTION ? 'armed' : ''}`} aria-hidden>
        {dx > 0 ? <Copy size={18} /> : <Trash2 size={18} />}
      </div>
      <div
        className="clip-card"
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onCopy();
        }}
        role="button"
        tabIndex={-1}
        title="Click to copy"
      >
        <span className={`kind-tile kind-${info.kind}`} style={info.color ? { ['--swatch' as string]: info.color } : undefined}>
          {info.kind === 'color' ? <span className="swatch" /> : <KindIcon size={16} strokeWidth={2} />}
        </span>

        <div className="clip-main">
          {info.kind === 'link' ? (
            <div className="clip-link">
              <span className="clip-host">{info.host}</span>
              <span className="clip-url">{highlight(clip.text, query)}</span>
            </div>
          ) : (
            <div className={`clip-text ${info.kind === 'code' ? 'mono' : ''} ${info.kind === 'number' ? 'big-number' : ''}`}>
              {highlight(preview, query)}
            </div>
          )}
          <div className="clip-meta">
            <PlatformIcon size={12} />
            <span>{from}</span>
            <span className="dot-sep" />
            <span>{timeAgo(clip.createdAt)}</span>
            <span className="dot-sep" />
            <span>{info.label}</span>
          </div>
        </div>

        <div className="clip-actions" onClick={(e) => e.stopPropagation()}>
          {info.href && info.kind === 'link' && (
            <button className="icon-btn" onClick={() => openLink(info.href!)} title="Open link">
              <ExternalLink size={15} />
            </button>
          )}
          <button className={`icon-btn copy-btn ${copied ? 'done' : ''}`} onClick={onCopy} title="Copy">
            <span className="swap">
              <Copy size={15} className="a" />
              <Check size={15} className="b" strokeWidth={2.6} />
            </span>
          </button>
          {canDelete && (
            <button className="icon-btn danger" onClick={onDelete} title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>

        {copied && <span className="copied-chip">Copied</span>}
      </div>
    </li>
  );
}

function EmptyState({ hasClips, query, email }: { hasClips: boolean; query: string; email: string }) {
  if (hasClips) {
    return (
      <div className="empty">
        <Search size={22} className="empty-icon" />
        <p className="empty-title">No matches for “{query}”</p>
        <p className="empty-sub">Try a different word.</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <div className="empty-illo" aria-hidden>
        <span className="ei-card back" />
        <span className="ei-trail t1" />
        <span className="ei-trail t2" />
        <span className="ei-card front" />
      </div>
      <p className="empty-title">Your clipboard, everywhere</p>
      <p className="empty-sub">
        {native ? 'Copy anything on this computer and it appears on your other devices.' : 'Type or paste above to send it to your devices.'}
      </p>
      <p className="empty-hint">
        Add a device: install CopyGlide and sign in as <strong>{email}</strong>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

function DevicesView({ devices, session, onChanged }: { devices: DeviceInfo[]; session: Session; onChanged: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const sorted = [...devices].sort((a, b) => (a.id === session.deviceId ? -1 : b.id === session.deviceId ? 1 : b.lastSeen - a.lastSeen));

  return (
    <>
      <section className="card-group">
        <h3 className="group-title">
          Your devices <span className="count">{devices.length}</span>
        </h3>
        <ul className="device-list">
          {sorted.map((d) => {
            const p = platformInfo(d.platform);
            const Icon = p.icon;
            const me = d.id === session.deviceId;
            const active = me || Date.now() - d.lastSeen < 2 * 60_000;
            return (
              <li key={d.id} className="device">
                <span className={`device-tile p-${d.platform}`}>
                  <Icon size={18} />
                  {active && <span className="online-dot" />}
                </span>
                <span className="device-info">
                  <span className="device-name">
                    {d.name}
                    {me && <span className="badge">This device</span>}
                  </span>
                  <span className="device-sub">
                    {p.label} · {active ? 'Active now' : `Last seen ${timeAgo(d.lastSeen).toLowerCase()}`}
                  </span>
                </span>
                {!me && (
                  <button
                    className="btn ghost sm"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Remove “${d.name}”?`,
                        body: 'It will be signed out and stop syncing. You can sign in on it again anytime.',
                        confirmLabel: 'Remove device',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await removeDevice(session, d.id);
                        toast('Device removed');
                      } catch {
                        toast('Could not remove device', 'error');
                      }
                      onChanged();
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="add-device">
        <span className="add-icon">
          <MonitorSmartphone size={20} />
        </span>
        <div>
          <p className="add-title">Add another device</p>
          <p className="add-sub">
            Install CopyGlide on your phone or computer and sign in as <strong>{session.email}</strong>. It joins automatically.
          </p>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function SettingsView({ backend, state, session, onLogout }: { backend: Backend; state: BackendState; session: Session; onLogout: () => void }) {
  const [theme, setTheme] = useTheme();
  const confirm = useConfirm();

  return (
    <>
      <section className="card-group">
        <h3 className="group-title">Sync</h3>
        <div className="settings-card">
          <SettingRow title="Sync on this device" sub="Pause to stop all syncing here. Uses no network or battery while paused.">
            <Switch checked={state.syncEnabled} onChange={(v) => backend.update({ syncEnabled: v })} label="Sync on this device" />
          </SettingRow>
          {native && (
            <>
              <SettingRow title="Send what I copy" sub="Off means the clipboard isn’t watched at all.">
                <Switch
                  checked={state.autoSend}
                  disabled={!state.syncEnabled}
                  onChange={(v) => backend.update({ autoSend: v })}
                  label="Send what I copy"
                />
              </SettingRow>
              <SettingRow title="Paste-ready on arrival" sub="Put clips from other devices straight onto this clipboard.">
                <Switch
                  checked={state.autoCopy}
                  disabled={!state.syncEnabled}
                  onChange={(v) => backend.update({ autoCopy: v })}
                  label="Paste-ready on arrival"
                />
              </SettingRow>
            </>
          )}
        </div>
      </section>

      <section className="card-group">
        <h3 className="group-title">Appearance</h3>
        <div className="settings-card">
          <SettingRow title="Theme">
            <Segmented<ThemePref>
              className="compact"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'system', label: 'Auto', icon: <SunMoon size={14} /> },
                { value: 'light', label: 'Light', icon: <Sun size={14} /> },
                { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
              ]}
            />
          </SettingRow>
        </div>
      </section>

      <section className="card-group">
        <h3 className="group-title">Keyboard</h3>
        <div className="settings-card shortcuts">
          <Shortcut keys={[modKey, 'K']} label="Search" />
          <Shortcut keys={['↑', '↓']} label="Move through history" />
          <Shortcut keys={['Enter']} label="Copy selected clip" />
          <Shortcut keys={['Del']} label="Delete selected clip" />
          <Shortcut keys={[modKey, 'Enter']} label="Send typed text" />
        </div>
      </section>

      <section className="card-group">
        <h3 className="group-title">Account</h3>
        <div className="settings-card">
          <SettingRow icon={<ShieldCheck size={16} />} title="End-to-end encrypted" sub="Clips are encrypted with your password before they leave this device." />
          <SettingRow icon={<KeyRound size={16} />} title={session.email} sub="Signed in">
            <button
              className="btn ghost sm"
              onClick={async () => {
                const ok = await confirm({ title: 'Log out of this device?', body: 'Sync stops here until you sign in again.', confirmLabel: 'Log out' });
                if (ok) onLogout();
              }}
            >
              <LogOut size={14} /> Log out
            </button>
          </SettingRow>
        </div>
      </section>

      <p className="version">
        <Monitor size={12} /> CopyGlide {__APP_VERSION__}
      </p>
    </>
  );
}

function SettingRow({ title, sub, icon, children }: { title: string; sub?: string; icon?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="setting-row">
      {icon && <span className="setting-icon">{icon}</span>}
      <div className="setting-text">
        <span className="setting-title">{title}</span>
        {sub && <span className="setting-sub">{sub}</span>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="shortcut">
      <span>{label}</span>
      <span className="keys">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}
