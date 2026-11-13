import { useId, useRef, useState } from "react";
import { Sparkles, TriangleAlert, X } from "lucide-react";
import { hasLLM } from "../lib/llm";
import { go } from "../lib/nav";
import { notesCapacity } from "../lib/ai";
import { cancelJob } from "../lib/generate";
import { useJob, useStore } from "../lib/store";
import type { Doc, Job } from "../lib/types";
import { Mascot } from "./Mascot";
import "../styles/study.css";

export type Tier = { n: number; label: string };

/**
 * "Welcome to Flashcards / Quizzes": pick how many to write and, optionally, what to focus on.
 * The same screen shows the writing progress (mascot, step text, Cancel) and the error state (Retry).
 */
export function GeneratorScreen({
  doc,
  kind,
  job,
  jobKey,
  onGenerate,
  onBack,
}: {
  doc: Doc;
  kind: "cards" | "quiz";
  job?: Job;
  jobKey: string;
  onGenerate: (o: { count: number; instructions: string }) => void;
  /** Present when the doc already has items: lets the student go back to them. */
  onBack?: () => void;
}) {
  const { settings } = useStore();
  const notesJob = useJob(doc.id);
  const cards = kind === "cards";
  const tiers: Tier[] = cards
    ? [{ n: 10, label: "Quick review" }, { n: 20, label: "Standard set" }, { n: 30, label: "Comprehensive" }, { n: 50, label: "Deep dive" }]
    : [{ n: 5, label: "Quick check" }, { n: 10, label: "Standard quiz" }, { n: 15, label: "Comprehensive" }, { n: 20, label: "Deep dive" }];
  const [count, setCount] = useState(cards ? 20 : 10);
  const [instructions, setInstructions] = useState("");
  const ids = { area: useId(), hint: useId() };
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const noun = cards ? "Flashcards" : "Questions";
  const hasNotes = !!doc.notes.trim();
  const notesWriting = !!notesJob && !notesJob.error && !notesJob.done;
  const blocked = !hasNotes || notesWriting;
  const cap = notesCapacity(doc.notes);
  const supported = cards ? cap.cards : cap.questions;
  const tooShort = hasNotes && !notesWriting && count > supported;
  const busy = !!job && !job.error;

  const start = () => !blocked && onGenerate({ count, instructions: instructions.trim() });

  if (busy)
    return (
      <div className="gen gen-busy" role="status" aria-live="polite">
        <Mascot size={132} mood="thinking" />
        <h2 className="gen-title">{cards ? "Making your flashcards" : "Writing your quiz"}</h2>
        <p className="gen-sub">{job.step}</p>
        <div className="gen-indeterminate" aria-hidden><div /></div>
        <button className="gen-cancel" onClick={() => cancelJob(jobKey)}><X size={15} /> Cancel</button>
      </div>
    );

  if (job?.error)
    return (
      <div className="gen gen-busy" role="alert">
        <div className="gen-err-ico"><TriangleAlert size={26} /></div>
        <h2 className="gen-title">That didn't work</h2>
        <p className="gen-sub gen-err">{job.error}</p>
        <div className="gen-actions">
          <button className="primary" onClick={start} disabled={blocked}>Retry</button>
          <button onClick={() => cancelJob(jobKey)}>Change options</button>
        </div>
      </div>
    );

  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = (tiers.findIndex((t) => t.n === count) + d + tiers.length) % tiers.length;
    setCount(tiers[i].n);
    refs.current[i]?.focus();
  };

  return (
    <div className="gen">
      <h2 className="gen-title">Welcome to {cards ? "Flashcards" : "Quizzes"}</h2>
      <p className="gen-sub">Choose how many {cards ? "flashcards" : "questions"} to generate from your notes</p>

      <div className="gen-tiles" role="radiogroup" aria-label={`Number of ${cards ? "flashcards" : "questions"}`} onKeyDown={onKey}>
        {tiers.map((t, i) => {
          const on = t.n === count;
          return (
            <button key={t.n} ref={(el) => void (refs.current[i] = el)} role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={"gen-tile" + (on ? " on" : "")} onClick={() => setCount(t.n)}>
              {on && <Sparkles size={14} className="gen-spark" aria-hidden />}
              <b>{t.n}</b>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {tooShort && (
        <p className="gen-note" role="status">
          Your notes are short ({cap.words} words), so about {supported} {cards ? "flashcards" : "questions"} can be made from them, fewer than the {count} you picked. Add more to your notes for a bigger set.
        </p>
      )}

      <label className="gen-label" htmlFor={ids.area}>Special Instructions (Optional)</label>
      <textarea
        id={ids.area}
        className="gen-area"
        rows={5}
        maxLength={600}
        placeholder={`Describe what you want your ${cards ? "flashcards" : "quiz"} to focus on, or leave blank to cover the full notes...`}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      {!hasLLM(settings) && instructions.trim() && (
        <p className="gen-note">
          Offline mode can't follow special instructions.{" "}
          <button className="link" onClick={() => go("/settings")}>Add an API key in Settings</button> to use them.
        </p>
      )}

      <button className="primary gen-go" disabled={blocked} onClick={start} aria-describedby={blocked ? ids.hint : undefined}>
        Generate {count} {noun}
      </button>
      {blocked && (
        <p className="gen-note" id={ids.hint}>
          {notesWriting ? "Your notes are still being written. You can generate once they finish." : `There are no notes yet, and ${cards ? "flashcards are" : "questions are"} written from your notes.`}{" "}
          <button className="link" onClick={() => go(`/doc/${doc.id}?tab=notes`)}>Go to Notes</button>
        </p>
      )}
      {onBack && (
        <button className="link gen-back" onClick={onBack}>Back to your {cards ? "flashcards" : "quiz"}</button>
      )}
    </div>
  );
}
