import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Info } from 'lucide-react';

type Tone = 'success' | 'info' | 'error';
interface ToastState {
  id: number;
  message: string;
  tone: Tone;
  leaving: boolean;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timers = useRef<number[]>([]);

  const show = useCallback((message: string, tone: Tone = 'success') => {
    timers.current.forEach(clearTimeout);
    const id = Date.now();
    setToast({ id, message, tone, leaving: false });
    timers.current = [
      window.setTimeout(() => setToast((t) => (t?.id === id ? { ...t, leaving: true } : t)), 2200),
      window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2500),
    ];
  }, []);

  const Icon = toast?.tone === 'error' ? AlertCircle : toast?.tone === 'info' ? Info : Check;
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toast && (
          <div key={toast.id} className={`toast ${toast.tone} ${toast.leaving ? 'leaving' : ''}`}>
            <span className="toast-icon">
              <Icon size={14} strokeWidth={2.5} />
            </span>
            {toast.message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
