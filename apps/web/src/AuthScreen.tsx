import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, Eye, EyeOff, Lock, Mail, MonitorSmartphone, ShieldCheck, Zap } from 'lucide-react';
import { logIn, signUp, type Session } from '@copyglide/shared';
import { currentPlatform, defaultDeviceName } from './native';
import { DEFAULT_SERVER_URL } from './session';
import { Logo, Wordmark } from './ui/Logo';
import { Segmented, Spinner } from './ui/controls';

type Mode = 'signup' | 'login';

function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = pw.length >= 8 ? 1 : 0;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return Math.max(1, score);
}
const STRENGTH = ['', 'Weak', 'Okay', 'Good', 'Strong'];

export function AuthScreen({ onAuthed }: { onAuthed: (s: Session) => void | Promise<void> }) {
  const [mode, setMode] = useState<Mode>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);

  useEffect(() => {
    defaultDeviceName().then((n) => setDeviceName((cur) => cur || n));
  }, []);

  function fail(msg: string) {
    setError(msg);
    setShake((n) => n + 1);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'signup' && password.length < 8) return fail('Use at least 8 characters for your password.');
    setBusy(true);
    try {
      const input = { serverUrl, email, password, deviceName: deviceName || 'My device', platform: currentPlatform() };
      await onAuthed(mode === 'signup' ? await signUp(input) : await logIn(input));
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const strength = mode === 'signup' ? passwordStrength(password) : 0;

  return (
    <div className="auth">
      <aside className="auth-hero">
        <div className="hero-glow" aria-hidden />
        <div className="hero-brand">
          <Logo size={34} />
          <Wordmark size="lg" />
        </div>
        <div className="hero-copy">
          <h1>
            Copy here.
            <br />
            <span className="gradient-text">Paste everywhere.</span>
          </h1>
          <p>Your clipboard, quietly in sync across every computer and phone you own.</p>
        </div>
        <GlideIllustration />
        <ul className="hero-points">
          <li>
            <ShieldCheck size={16} /> End-to-end encrypted
          </li>
          <li>
            <MonitorSmartphone size={16} /> Windows, Mac, Linux, Android, iPhone
          </li>
          <li>
            <Zap size={16} /> Arrives in under a second
          </li>
        </ul>
      </aside>

      <main className="auth-panel">
        <div key={shake} className={`auth-card ${shake ? 'shake' : ''}`}>
          <div className="auth-mobile-brand">
            <Logo size={40} />
            <Wordmark size="lg" />
            <p>Copy here. Paste everywhere.</p>
          </div>

          <h2>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
          <p className="auth-sub">
            {mode === 'signup' ? 'One account for all your devices.' : 'Sign in to sync this device.'}
          </p>

          <Segmented<Mode>
            className="auth-tabs"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError('');
            }}
            options={[
              { value: 'signup', label: 'Sign up' },
              { value: 'login', label: 'Log in' },
            ]}
          />

          <form onSubmit={submit} noValidate>
            <label className="field">
              <span className="field-label">Email</span>
              <span className="input-wrap">
                <Mail size={16} className="input-icon" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </span>
            </label>

            <label className="field">
              <span className="field-label">Password</span>
              <span className="input-wrap">
                <Lock size={16} className="input-icon" />
                <input
                  type={showPw ? 'text' : 'password'}
                  required
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="input-action"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </span>
              {mode === 'signup' && password && (
                <span className={`strength s${strength}`}>
                  <span className="strength-bars">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  {STRENGTH[strength]}
                </span>
              )}
            </label>

            <button type="button" className={`disclosure ${showMore ? 'open' : ''}`} onClick={() => setShowMore((v) => !v)}>
              Device &amp; server
              <ChevronDown size={14} />
            </button>
            {showMore && (
              <div className="more-fields">
                <label className="field">
                  <span className="field-label">This device's name</span>
                  <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">Server</span>
                  <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
                </label>
              </div>
            )}

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <button className="btn primary block lg" disabled={busy || !email || !password}>
              {busy ? (
                <>
                  <Spinner /> Securing your keys…
                </>
              ) : (
                <>
                  {mode === 'signup' ? 'Create account' : 'Log in'} <ArrowRight size={16} className="btn-arrow" />
                </>
              )}
            </button>
          </form>

          <p className="auth-foot">
            <ShieldCheck size={14} />
            <span>
              Your password encrypts your clips on this device. We never see them, so we can't recover them if you forget it.
            </span>
          </p>
        </div>
      </main>
    </div>
  );
}

/** Two device cards with a clip gliding between them. */
function GlideIllustration() {
  return (
    <div className="glide-illo" aria-hidden>
      <div className="illo-device laptop">
        <div className="illo-bar" />
        <div className="illo-line w70" />
        <div className="illo-line w45 hl" />
        <div className="illo-line w60" />
      </div>
      <div className="illo-trail" />
      <div className="illo-chip">“Meeting at 4 pm 📍”</div>
      <div className="illo-device phone">
        <div className="illo-notch" />
        <div className="illo-line w70" />
        <div className="illo-line w45 hl arrive" />
        <div className="illo-line w60" />
      </div>
    </div>
  );
}
