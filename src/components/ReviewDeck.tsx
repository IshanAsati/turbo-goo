import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, RotateCcw } from "lucide-react";
import { preview, review, type Grade } from "../lib/srs";
import type { Card } from "../lib/types";
import { Markdown } from "./Markdown";

export type ReviewItem = { card: Card; docId: string; docTitle?: string };

const GRADES: { g: Grade; label: string; key: string; cls: string }[] = [
  { g: 1, label: "Again", key: "1", cls: "again" },
  { g: 3, label: "Hard", key: "2", cls: "hard" },
  { g: 4, label: "Good", key: "3", cls: "good" },
  { g: 5, label: "Easy", key: "4", cls: "easy" },
];

/** Spaced-repetition session: flip, grade (keyboard 1-4), failed cards come back at the end of the session. */
export function ReviewDeck({ items, onGrade, emptyText = "All caught up. Nothing is due right now.", children }: { items: ReviewItem[]; onGrade: (item: ReviewItem, updated: Card, grade: Grade) => void; emptyText?: string; children?: React.ReactNode }) {
  const initial = useMemo(() => items, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [queue, setQueue] = useState<ReviewItem[]>(initial);
  const [flip, setFlip] = useState(false);
  const [stats, setStats] = useState({ done: 0, good: 0 });
  const total = initial.length;
  const cur = queue[0];

  const grade = useCallback(
    (g: Grade) => {
      if (!cur) return;
      const updated = review(cur.card, g);
      onGrade(cur, updated, g);
      setStats((s) => ({ done: s.done + 1, good: s.good + (g >= 4 ? 1 : 0) }));
      setQueue((q) => (g < 3 ? [...q.slice(1), { ...cur, card: updated }] : q.slice(1)));
      setFlip(false);
    },
    [cur, onGrade],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable]")) return;
      if (!cur) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlip((f) => !f);
      } else if (flip) {
        const m = GRADES.find((x) => x.key === e.key);
        if (m) grade(m.g);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, flip, grade]);

  if (!cur) {
    return (
      <div className="deck done-state">
        <CheckCircle2 size={44} className="ok-ico" />
        <h2>{stats.done ? "Session complete" : emptyText}</h2>
        {stats.done > 0 && (
          <p className="muted">
            {stats.done} reviews · {Math.round((stats.good / stats.done) * 100)}% rated Good or Easy
          </p>
        )}
        {children}
      </div>
    );
  }

  return (
    <div className="deck">
      <div className="progress-line" aria-label={`${total - queue.length} of ${total}`}>
        <div style={{ width: `${((total - queue.length) / Math.max(1, total)) * 100}%` }} />
      </div>
      <div className="muted small deck-meta">
        <span>{queue.length} left</span>
        {cur.docTitle && <span className="pill">{cur.docTitle}</span>}
        {cur.card.lapses > 0 && <span title="Times forgotten"><RotateCcw size={12} /> {cur.card.lapses}</span>}
      </div>
      <button className={"flash" + (flip ? " flipped" : "")} onClick={() => setFlip(!flip)} aria-label={flip ? "Show question" : "Show answer"}>
        <span className="face front"><Markdown text={cur.card.front} /></span>
        <span className="face back"><Markdown text={cur.card.back} /></span>
        <span className="hint">{flip ? "answer" : "space to flip"}</span>
      </button>
      {flip ? (
        <div className="grades">
          {GRADES.map((x) => (
            <button key={x.g} className={"grade " + x.cls} onClick={() => grade(x.g)}>
              <small>{preview(cur.card, x.g)}</small>
              <span>{x.label}</span>
              <kbd>{x.key}</kbd>
            </button>
          ))}
        </div>
      ) : (
        <div className="grades single">
          <button className="primary" onClick={() => setFlip(true)}>Show answer</button>
        </div>
      )}
    </div>
  );
}
