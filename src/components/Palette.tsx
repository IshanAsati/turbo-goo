import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileText, Layers, Moon, Search, Settings, Waves, Compass } from "lucide-react";
import { go } from "../lib/nav";
import { setSettings, useStore } from "../lib/store";
import { dueCount } from "../lib/srs";

type Item = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void };

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { docs, settings } = useStore();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const due = docs.reduce((a, d) => a + dueCount(d.cards), 0);
  const items: Item[] = useMemo(() => {
    const actions: Item[] = [
      { id: "a-lib", label: "Go to Library", icon: <Layers size={16} />, run: () => go("/") },
      { id: "a-review", label: `Review due cards (${due})`, icon: <Layers size={16} />, run: () => go("/review") },
      { id: "a-learn", label: "Learn Mode", icon: <Compass size={16} />, run: () => go("/learn") },
      { id: "a-stream", label: "Study Stream", icon: <Waves size={16} />, run: () => go("/stream") },
      { id: "a-set", label: "Settings", icon: <Settings size={16} />, run: () => go("/settings") },
      { id: "a-theme", label: "Toggle dark mode", icon: <Moon size={16} />, run: () => setSettings({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }) },
    ];
    const docItems: Item[] = docs.map((d) => ({ id: d.id, label: d.title, hint: `${d.cards.length} cards`, icon: <FileText size={16} />, run: () => go(`/doc/${d.id}`) }));
    const all = [...actions, ...docItems];
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 12);
    const inNotes = docs.filter((d) => (d.notes + d.source).toLowerCase().includes(needle) && !d.title.toLowerCase().includes(needle)).map<Item>((d) => ({ id: "n" + d.id, label: d.title, hint: "in notes", icon: <Search size={16} />, run: () => go(`/doc/${d.id}`) }));
    return [...all.filter((x) => x.label.toLowerCase().includes(needle)), ...inNotes].slice(0, 12);
  }, [q, docs, due, settings.theme]);

  if (!open) return null;
  const choose = (it?: Item) => {
    if (!it) return;
    onClose();
    it.run();
  };
  return (
    <div className="modal top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Search size={18} />
          <input
            ref={inputRef}
            placeholder="Search documents, jump to a page…"
            value={q}
            onChange={(e) => (setQ(e.target.value), setI(0))}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(x + 1, items.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(x - 1, 0)));
              else if (e.key === "Enter") choose(items[i]);
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="palette-list" role="listbox">
          {items.map((it, k) => (
            <li key={it.id} role="option" aria-selected={k === i} className={k === i ? "on" : ""} onMouseMove={() => setI(k)} onClick={() => choose(it)}>
              {it.icon}
              <span>{it.label}</span>
              {it.hint && <small>{it.hint}</small>}
              {k === i && <CornerDownLeft size={14} />}
            </li>
          ))}
          {items.length === 0 && <li className="muted">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
