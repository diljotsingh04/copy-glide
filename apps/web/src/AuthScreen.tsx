import { useEffect, useState, type FormEvent } from 'react';
import { logIn, signUp, type Session } from '@clipsync/shared';
import { currentPlatform, defaultDeviceName } from './native';
import { DEFAULT_SERVER_URL } from './session';

export function AuthScreen({ onAuthed }: { onAuthed: (s: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    defaultDeviceName().then((n) => setDeviceName((cur) => cur || n));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'signup' && password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }
    setBusy(true);
    try {
      const input = { serverUrl, email, password, deviceName, platform: currentPlatform() };
      onAuthed(mode === 'signup' ? await signUp(input) : await logIn(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">
          <span className="logo" aria-hidden>
            ⧉
          </span>
          <h1>ClipSync</h1>
        </div>
        <p className="muted">Copy on one device, paste on all of them.</p>

        <div className="segmented" role="tablist">
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
            Create account
          </button>
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Log in
          </button>
        </div>

        <form onSubmit={submit}>
          <label>
            Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            This device's name
            <input required value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
          </label>

          <button type="button" className="link" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Hide' : 'Show'} advanced
          </button>
          {showAdvanced && (
            <label>
              Server URL
              <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </label>
          )}

          {error && <p className="error">{error}</p>}

          <button className="primary" disabled={busy}>
            {busy ? 'Securing your keys…' : mode === 'signup' ? 'Create account' : 'Log in'}
          </button>
        </form>

        <p className="fine">
          🔒 Your password encrypts your clipboard on this device. We never see your clips, so we can't recover them if you
          forget it.
        </p>
      </div>
    </div>
  );
}
