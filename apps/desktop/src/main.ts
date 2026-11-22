// CopyGlide desktop: a lightweight tray app.
// The sync engine lives here in the main process. The window (renderer) is created only when the
// user opens it and is destroyed when closed, so a background CopyGlide uses as little memory as possible.
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import os from 'os';
import path from 'path';
import type { Session } from '@copyglide/shared';
import { SyncEngine } from './engine';
import { createStore, type Settings } from './store';

const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');
const DEV_URL = process.env.COPYGLIDE_DEV_URL || 'http://localhost:5173';
const isMac = process.platform === 'darwin';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// A simple UI doesn't need the GPU; skipping it saves memory and a busy GPU process.
app.disableHardwareAcceleration();
app.setName('CopyGlide');
app.setAppUserModelId('app.copyglide.desktop');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: SyncEngine;

// ---------- icons (generated from /brand by `npm run icons`) ----------

const asset = (name: string) => path.join(__dirname, '..', 'assets', name);
const icons = {
  app: nativeImage.createFromPath(asset('icon.png')),
  trayOn: nativeImage.createFromPath(asset(isMac ? 'trayTemplate.png' : 'tray-on.png')),
  trayOff: nativeImage.createFromPath(asset(isMac ? 'trayTemplate.png' : 'tray-off.png')),
};
if (isMac) {
  icons.trayOn.setTemplateImage(true);
  icons.trayOff.setTemplateImage(true);
}

// ---------- window chrome colours (match the UI's header) ----------

const CHROME = {
  light: { color: '#F6F6F9', symbolColor: '#2A2C3D' },
  dark: { color: '#0B0C14', symbolColor: '#D6D8EA' },
};
let darkUi = nativeTheme.shouldUseDarkColors;

function applyChrome(): void {
  if (!win || win.isDestroyed()) return;
  const c = darkUi ? CHROME.dark : CHROME.light;
  win.setBackgroundColor(c.color);
  if (!isMac) win.setTitleBarOverlay({ ...c, height: 52 });
}

// ---------- window ----------

function openWindow(): void {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  app.dock?.show();
  const c = darkUi ? CHROME.dark : CHROME.light;
  win = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 380,
    minHeight: 520,
    icon: icons.app,
    title: 'CopyGlide',
    show: false,
    backgroundColor: c.color,
    // The app's header doubles as the title bar; native window controls sit on top of it.
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: { ...c, height: 52 } }),
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
  if (!s.syncEnabled) return 'Sync paused';
  return s.status === 'online' ? 'Synced' : s.status === 'connecting' ? 'Connecting…' : 'Offline — retrying';
}

function updateTray(): void {
  if (!tray) return;
  const s = engine.getState();
  const on = s.signedIn && s.syncEnabled;
  tray.setImage(on ? icons.trayOn : icons.trayOff);
  tray.setToolTip(`CopyGlide — ${statusLabel()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel(), enabled: false },
      { type: 'separator' },
      { label: 'Open CopyGlide', click: openWindow },
      {
        label: s.syncEnabled ? 'Pause syncing' : 'Resume syncing',
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
      { label: 'Quit CopyGlide', click: () => app.quit() },
    ]),
  );
}

// ---------- IPC (the only API the UI gets) ----------

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion(), hostname: os.hostname() }));
  ipcMain.handle('app:openExternal', (_e, url: unknown) => {
    if (typeof url === 'string' && /^(https?:|mailto:|tel:)/i.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle('window:setTheme', (_e, dark: unknown) => {
    darkUi = !!dark;
    applyChrome();
  });
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
