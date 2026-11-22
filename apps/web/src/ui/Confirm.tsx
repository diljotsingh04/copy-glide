import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [closing, setClosing] = useState(false);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setClosing(false);
        setPending({ ...o, resolve });
      }),
    [],
  );

  const close = useCallback(
    (ok: boolean) => {
      if (!pending) return;
      pending.resolve(ok);
      setClosing(true);
      window.setTimeout(() => setPending(null), 160);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    confirmBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className={`dialog-backdrop ${closing ? 'closing' : ''}`} onMouseDown={() => close(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="dialog-title">{pending.title}</h2>
            {pending.body && <div className="dialog-body">{pending.body}</div>}
            <div className="dialog-actions">
              <button className="btn ghost" onClick={() => close(false)}>
                Cancel
              </button>
              <button ref={confirmBtn} className={`btn ${pending.danger ? 'danger' : 'primary'}`} onClick={() => close(true)}>
                {pending.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
