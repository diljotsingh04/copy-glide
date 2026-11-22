// ClipSync desktop: a lightweight tray app.
// The sync engine lives here in the main process. The window (renderer) is created only when the
// user opens it and is destroyed when closed, so a background ClipSync uses as little memory as possible.
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, type NativeImage } from 'electron';
import os from 'os';
import path from 'path';
import type { Session } from '@clipsync/shared';
import { SyncEngine } from './engine';
import { createStore, type Settings } from './store';

const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');
const DEV_URL = process.env.CLIPSYNC_DEV_URL || 'http://localhost:5173';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// A simple UI doesn't need the GPU; skipping it saves memory and a busy GPU process.
app.disableHardwareAcceleration();
app.setAppUserModelId('app.clipsync.desktop');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: SyncEngine;

// ---------- icons (drawn in code; real artwork can replace these later) ----------

function makeIcon(size: number, active: boolean): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const bg = active ? [91, 91, 240] : [140, 142, 158];
  const dark = active ? [52, 48, 170] : [90, 92, 106];
  const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
    x >= x0 * size && x < x1 * size && y >= y0 * size && y < y1 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      if (dx * dx + dy * dy > r * r) continue;
      let c = bg;
      if (inRect(x, y, 0.27, 0.22, 0.73, 0.84)) c = [255, 255, 255];
      if (inRect(x, y, 0.36, 0.44, 0.64, 0.5) || inRect(x, y, 0.36, 0.58, 0.58, 0.64)) c = bg;
      if (inRect(x, y, 0.38, 0.14, 0.62, 0.28)) c = dark;
      const i = (y * size + x) * 4;
      buf[i] = c[2];
      buf[i + 1] = c[1];
      buf[i + 2] = c[0];
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

const icons = {
  app: makeIcon(64, true),
  trayOn: makeIcon(32, true).resize({ width: 16, height: 16 }),
  trayOff: makeIcon(32, false).resize({ width: 16, height: 16 }),
};

// ---------- window ----------

function openWindow(): void {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  app.dock?.show();
  win = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    icon: icons.app,
    title: 'ClipSync',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  if (isDev) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window really closes it (frees the renderer). Sync keeps running here in the tray.
  win.on('closed', () => {
    win = null;
    app.dock?.hide();
  });
}

function sendToWindow(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- tray ----------

function statusLabel(): string {
  const s = engine.getState();
  if (!s.signedIn) return 'Not signed in';
  if (!s.syncEnabled) return 'Sync stopped';
  return s.status === 'online' ? 'Synced' : s.status === 'connecting' ? 'Connecting…' : 'Offline — retrying';
}

function updateTray(): void {
  if (!tray) return;
  const s = engine.getState();
  const on = s.signedIn && s.syncEnabled;
  tray.setImage(on ? icons.trayOn : icons.trayOff);
  tray.setToolTip(`ClipSync — ${statusLabel()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel(), enabled: false },
      { type: 'separator' },
      { label: 'Open ClipSync', click: openWindow },
      {
        label: s.syncEnabled ? 'Stop syncing' : 'Start syncing',
        enabled: s.signedIn,
        click: () => engine.updateSettings({ syncEnabled: !s.syncEnabled }),
      },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      { label: 'Quit ClipSync', click: () => app.quit() },
    ]),
  );
}

// ---------- IPC (the only API the UI gets) ----------

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion(), hostname: os.hostname() }));
  ipcMain.handle('clipboard:write', (_e, text: unknown) => {
    if (typeof text === 'string') engine.writeClipboard(text);
  });
  ipcMain.handle('engine:getSession', () => engine.getSession());
  ipcMain.handle('engine:setSession', (_e, s: Session | null) => engine.setSession(s));
  ipcMain.handle('engine:getState', () => engine.getState());
  ipcMain.handle('engine:updateSettings', (_e, patch: Partial<Settings>) => {
    const allowed: (keyof Settings)[] = ['syncEnabled', 'autoSend', 'autoCopy'];
    const clean: Partial<Settings> = {};
    for (const k of allowed) if (typeof patch?.[k] === 'boolean') clean[k] = patch[k];
    engine.updateSettings(clean);
  });
  ipcMain.handle('engine:sendText', (_e, text: unknown) => {
    if (typeof text === 'string') engine.sendText(text);
  });
  ipcMain.handle('engine:deleteClip', (_e, id: unknown) => {
    if (typeof id === 'string') engine.deleteClip(id);
  });
  ipcMain.handle('engine:clearAll', () => engine.clearAll());
}

// ---------- lifecycle ----------

app.on('second-instance', openWindow);

app.whenReady().then(() => {
  const store = createStore(app.getPath('userData'));
  engine = new SyncEngine(store.loadSession(), store.loadSettings(), store);
  engine.on((e) => {
    if (e.type === 'state') {
      updateTray();
      sendToWindow('engine:event', { type: 'state', state: engine.getState() });
    } else {
      sendToWindow('engine:event', e);
    }
  });
  registerIpc();
  engine.init();

  tray = new Tray(icons.trayOff);
  tray.on('click', openWindow);
  updateTray();

  // First run (not signed in) always shows the window; later launches can start quietly in the tray.
  if (!startHidden || !engine.getSession()) openWindow();
  else app.dock?.hide();

  app.on('activate', openWindow);
});

app.on('window-all-closed', () => {
  /* keep running in the tray */
});
