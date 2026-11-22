// Bridge exposed by the Electron preload script. Undefined when running in a normal browser.
import type { DecryptedClip, Platform, Session, SyncStatus } from '@copyglide/shared';

export interface NativeSettings {
  syncEnabled: boolean;
  autoSend: boolean;
  autoCopy: boolean;
}

export interface NativeState extends NativeSettings {
  signedIn: boolean;
  status: SyncStatus;
  clips: DecryptedClip[];
}

export type NativeEvent =
  | { type: 'state'; state: NativeState }
  | { type: 'received'; clip: DecryptedClip }
  | { type: 'signedOut' };

export interface CopyglideNative {
  platform: string; // node's process.platform
  getInfo(): Promise<{ platform: string; version: string; hostname: string }>;
  writeText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setTheme(dark: boolean): Promise<void>;
  getSession(): Promise<Session | null>;
  setSession(session: Session | null): Promise<void>;
  getState(): Promise<NativeState>;
  updateSettings(patch: Partial<NativeSettings>): Promise<void>;
  sendText(text: string): Promise<void>;
  deleteClip(id: string): Promise<void>;
  clearAll(): Promise<void>;
  onEvent(cb: (e: NativeEvent) => void): () => void;
}

declare global {
  interface Window {
    copyglideNative?: CopyglideNative;
  }
}

export const native: CopyglideNative | undefined = typeof window !== 'undefined' ? window.copyglideNative : undefined;

export function currentPlatform(): Platform {
  if (!native) return 'web';
  if (native.platform === 'win32') return 'windows';
  if (native.platform === 'darwin') return 'macos';
  return 'linux';
}

export async function defaultDeviceName(): Promise<string> {
  if (native) {
    try {
      return (await native.getInfo()).hostname;
    } catch {
      /* fall through */
    }
  }
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export async function copyToClipboard(text: string): Promise<void> {
  if (native) return native.writeText(text);
  await navigator.clipboard.writeText(text);
}

export function openLink(url: string): void {
  if (native) void native.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export const isMac = native ? native.platform === 'darwin' : /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
