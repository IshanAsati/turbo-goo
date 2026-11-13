import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { preview, review, type Grade } from "../lib/srs";
import type { Card } from "../lib/types";
import { Markdown } from "./Markdown";
import { Mascot } from "./Mascot";
import "../styles/study.css";

export type ReviewItem = { card: Card; docId: string; docTitle?: string };

export const GRADES: { g: Grade; label: string; key: string; cls: string }[] = [
  { g: 1, label: "Again", key: "1", cls: "again" },
  { g: 3, label: "Hard", key: "2", cls: "hard" },
  { g: 4, label: "Good", key: "3", cls: "good" },
  { g: 5, label: "Easy", key: "4", cls: "easy" },
];

/** A large rounded flip card: question on the front, answer on the back. Flipping is a smooth turn (a fade with reduced motion). */
export function FlipCard({ front, back, flipped, onFlip, compact = false }: { front: string; back: string; flipped: boolean; onFlip: () => void; compact?: boolean }) {
  return (
    <div className={"rv-stage" + (compact ? " compact" : "")}>
      <div
        className={"rv-card" + (flipped ? " flipped" : "")}
        role="group"
        aria-roledescription="flashcard"
        aria-label={flipped ? "Flashcard, answer side. Press Space to flip back" : "Flashcard, question side. Press Space to flip"}
        tabIndex={0}
        onClick={onFlip}
        onKeyDown={(e) => {
          // Space and Enter are handled once here (the deck's global shortcut ignores keys that start on the card).
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onFlip();
          }
        }}
      >
        <div className="rv-face rv-front" aria-hidden={flipped}>
          <span className="rv-tag">Question</span>
          <div className="rv-text"><Markdown text={front} /></div>
          <span className="rv-hint">Tap to flip</span>
        </div>
        <div className="rv-face rv-back" aria-hidden={!flipped}>
          <span className="rv-tag">Answer</span>
          <div className="rv-text"><Markdown text={back} /></div>
          <span className="rv-hint">Tap to flip back</span>
        </div>
      </div>
    </div>
  );
}

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
      if (t.closest("input,textarea,select,[contenteditable],dialog,[role=dialog]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey || !cur) return;
      if (e.key === " " || e.key === "Enter") {
        // A focused button or link keeps its own Space/Enter (the rating buttons, "Show answer", menus).
        if (t.closest("button,a,[role=button],[role=radio]")) return;
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
      <div className="rv-done">
        <Mascot size={150} mood="cheer" />
        <h2>{stats.done ? "Session complete" : emptyText}</h2>
        {stats.done > 0 && (
          <p className="muted">
            {stats.done} reviews · {Math.round((stats.good / stats.done) * 100)}% rated Good or Easy
          </p>
        )}
        <div className="rv-done-actions">{children}</div>
      </div>
    );
  }

  const doneN = total - queue.length;
  return (
    <div className="rv">
      <div className="rv-top">
        <div className="progress-line rv-progress" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneN}>
          <div style={{ width: `${(doneN / Math.max(1, total)) * 100}%` }} />
        </div>
        <div className="rv-meta">
          <span>{queue.length} left</span>
          {cur.docTitle && <span className="rv-doc">{cur.docTitle}</span>}
          {cur.card.lapses > 0 && <span title="Times forgotten"><RotateCcw size={12} /> {cur.card.lapses}</span>}
        </div>
      </div>
      <FlipCard front={cur.card.front} back={cur.card.back} flipped={flip} onFlip={() => setFlip((f) => !f)} />
      {flip ? (
        <div className="rv-grades" role="group" aria-label="How well did you remember it?">
          {GRADES.map((x) => (
            <button key={x.g} className={"rv-grade " + x.cls} onClick={() => grade(x.g)}>
              <small>{preview(cur.card, x.g)}</small>
              <span>{x.label}</span>
              <kbd>{x.key}</kbd>
            </button>
          ))}
        </div>
      ) : (
        <div className="rv-show">
          <button className="primary" onClick={() => setFlip(true)}>Show answer <kbd>Space</kbd></button>
        </div>
      )}
    </div>
  );
}
