// Persists the session (encrypted with the OS keychain via safeStorage) and settings in the user data folder.
import { safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import type { Session } from '@clipsync/shared';

export interface Settings {
  /** Master switch. Off = no connection, no clipboard polling. */
  syncEnabled: boolean;
  /** Send what the user copies on this computer. */
  autoSend: boolean;
  /** Put clips from other devices on this computer's clipboard. */
  autoCopy: boolean;
}

export const DEFAULT_SETTINGS: Settings = { syncEnabled: true, autoSend: true, autoCopy: true };

export interface Store {
  loadSession(): Session | null;
  saveSession(s: Session | null): void;
  loadSettings(): Settings;
  saveSettings(s: Settings): void;
}

export function createStore(dir: string): Store {
  const sessionFile = path.join(dir, 'session.bin');
  const settingsFile = path.join(dir, 'settings.json');
  const canEncrypt = () => safeStorage.isEncryptionAvailable();

  return {
    loadSession() {
      try {
        const raw = fs.readFileSync(sessionFile);
        const json = canEncrypt() ? safeStorage.decryptString(raw) : raw.toString('utf8');
        return JSON.parse(json) as Session;
      } catch {
        return null;
      }
    },
    saveSession(s) {
      try {
        if (!s) return fs.rmSync(sessionFile, { force: true });
        fs.mkdirSync(dir, { recursive: true });
        const json = JSON.stringify(s);
        fs.writeFileSync(sessionFile, canEncrypt() ? safeStorage.encryptString(json) : json);
      } catch (err) {
        console.error('[clipsync] could not save session', err);
      }
    },
    loadSettings() {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },
    saveSettings(s) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
      } catch (err) {
        console.error('[clipsync] could not save settings', err);
      }
    },
  };
}
