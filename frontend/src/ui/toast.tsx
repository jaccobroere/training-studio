import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export interface ToastT {
  id: number;
  text: string;
  tone?: "info" | "error";
  action?: { label: string; run: () => void | Promise<void> };
}

const Ctx = createContext<(t: Omit<ToastT, "id">) => void>(() => {});
export const useToast = () => useContext(Ctx);

/** Short-lived confirmation strip. Persistent history lives in the week's History panel;
 * a toast is only the fast path to Undo. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<ToastT, "id">) => {
    const id = ++seq.current;
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    window.setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.tone === "error" ? 9000 : 6500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone ?? "info"}`}>
            <span className="toast-t">{t.text}</span>
            {t.action && (
              <button className="key" onClick={() => {
                setToasts((all) => all.filter((x) => x.id !== t.id));
                void t.action!.run();
              }}>{t.action.label}</button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
