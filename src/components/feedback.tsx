import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

/* ---------------- toasts ---------------- */

type T = { id: number; msg: string; kind: "info" | "ok" | "error" };
let toasts: T[] = [];
const tl = new Set<() => void>();
let n = 0;
const emitT = () => tl.forEach((l) => l());

export function toast(msg: string, kind: T["kind"] = "info") {
  const id = ++n;
  toasts = [...toasts, { id, msg, kind }];
  emitT();
  setTimeout(() => dismiss(id), kind === "error" ? 7000 : 3500);
}
const dismiss = (id: number) => {
  toasts = toasts.filter((t) => t.id !== id);
  emitT();
};

export function Toaster() {
  const list = useSyncExternalStore(
    (cb) => (tl.add(cb), () => void tl.delete(cb)),
    () => toasts,
  );
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "ok" ? <CheckCircle2 size={18} /> : t.kind === "error" ? <AlertTriangle size={18} /> : <Info size={18} />}
          <span>{t.msg}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- promise-based dialogs ---------------- */

type Req = { title: string; body?: string; input?: { label: string; value?: string; placeholder?: string }; confirm: string; danger?: boolean; resolve: (v: string | boolean | null) => void };
let req: Req | null = null;
const dl = new Set<() => void>();
const emitD = () => dl.forEach((l) => l());

export const confirmDialog = (title: string, body: string, confirm = "Confirm", danger = false) =>
  new Promise<boolean>((resolve) => {
    req?.resolve(false); // a dialog opened over another one: settle the old promise instead of leaving it pending forever
    req = { title, body, confirm, danger, resolve: (v) => resolve(v === true) };
    emitD();
  });

export const promptDialog = (title: string, label: string, value = "", confirm = "Save", placeholder = "") =>
  new Promise<string | null>((resolve) => {
    req?.resolve(false);
    req = { title, input: { label, value, placeholder }, confirm, resolve: (v) => resolve(typeof v === "string" ? v : null) };
    emitD();
  });

export function DialogHost() {
  const r = useSyncExternalStore(
    (cb) => (dl.add(cb), () => void dl.delete(cb)),
    () => req,
  );
  const [val, setVal] = useState("");
  useEffect(() => {
    setVal(r?.input?.value ?? "");
  }, [r]);
  if (!r) return null;
  const close = (v: string | boolean | null) => {
    req = null;
    emitD();
    r.resolve(v);
  };
  return (
    <Modal onClose={() => close(r.input ? null : false)} label={r.title} narrow>
      <h2>{r.title}</h2>
      {r.body && <p className="muted">{r.body}</p>}
      {r.input && (
        <label>
          {r.input.label}
          <input autoFocus value={val} placeholder={r.input.placeholder} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && val.trim() && close(val.trim())} />
        </label>
      )}
      <div className="row end">
        <button onClick={() => close(r.input ? null : false)}>Cancel</button>
        <button className={r.danger ? "danger-solid" : "primary"} autoFocus={!r.input} disabled={!!r.input && !val.trim()} onClick={() => close(r.input ? val.trim() : true)}>
          {r.confirm}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- modal ---------------- */

export function Modal({ children, onClose, label, narrow }: { children: React.ReactNode; onClose: () => void; label: string; narrow?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose; // callers pass a fresh closure every render; depending on it re-ran the effect and stole focus
  const prevFocus = useRef<HTMLElement | null>(typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)); // read at render: in StrictMode an effect-time read sees the dialog's own autofocused input
  useEffect(() => {
    const prev = prevFocus.current;
    const me = ref.current;
    if (me && !me.contains(document.activeElement)) (me.querySelector<HTMLElement>("[autofocus],input,textarea,select,button,[href]") ?? me).focus();
    stack.push(me!);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return; // only the top-most dialog reacts
      if (e.key === "Escape") return void close.current();
      if (e.key !== "Tab" || !me) return;
      const f = [...me.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")];
      if (!f.length) return e.preventDefault();
      const first = f[0];
      const last = f[f.length - 1];
      if (!me.contains(document.activeElement)) (e.preventDefault(), first.focus());
      else if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(me!), 1);
      if (prev?.isConnected) prev.focus?.();
    };
  }, []);
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      <div ref={ref} className={"dialog" + (narrow ? " narrow" : "")} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

const stack: HTMLElement[] = [];