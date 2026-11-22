import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@clipsync/shared';
import { AuthScreen } from './AuthScreen';
import { MainScreen } from './MainScreen';
import { native } from './native';
import { clearSession, loadSession, saveSession } from './session';

export function App() {
  // On desktop the session lives in the main process (encrypted with the OS keychain).
  const [session, setSession] = useState<Session | null | undefined>(() => (native ? undefined : loadSession()));

  useEffect(() => {
    if (native) void native.getSession().then(setSession);
  }, []);

  const login = useCallback(async (s: Session) => {
    if (native) await native.setSession(s);
    else saveSession(s);
    setSession(s);
  }, []);

  const logout = useCallback(() => {
    if (native) void native.setSession(null);
    else clearSession();
    setSession(null);
  }, []);

  if (session === undefined) return null; // loading (desktop only, a few ms)
  if (!session) return <AuthScreen onAuthed={login} />;
  return <MainScreen key={session.deviceId} session={session} onLogout={logout} />;
}
