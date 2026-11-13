import { useMemo, useState } from "react";
import { BookOpen, Check, Coffee, Pause, Play, RotateCcw, Shuffle, Timer, X } from "lucide-react";
import { go } from "../lib/nav";
import { isDue, review } from "../lib/srs";
import { recordActivity, updateDoc, useStore } from "../lib/store";
import { shuffle } from "../lib/text";
import type { Card, QuizQ } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { FlipCard } from "../components/ReviewDeck";
import { usePomodoro } from "./pomodoro";
import "../styles/study.css";

type Item =
  | { t: "card"; docId: string; title: string; card: Card }
  | { t: "mc"; docId: string; title: string; q: Extract<QuizQ, { kind: "mc" }> }
  | { t: "note"; docId: string; title: string; text: string };

/** Notes become bite-sized snippets: bullets and key-takeaway lines. */
function snippets(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l.length > 50 && l.length < 260 && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("|"));
}

export function Stream() {
  const { docs } = useStore();
  const [seed, setSeed] = useState(0);
  const pomo = usePomodoro();

  const items = useMemo<Item[]>(() => {
    const cards: Item[] = [];
    const mcs: Item[] = [];
    const notes: Item[] = [];
    docs.forEach((d) => {
      d.cards.filter((c) => isDue(c)).slice(0, 10).forEach((card) => cards.push({ t: "card", docId: d.id, title: d.title, card }));
      d.quiz.filter((q): q is Extract<QuizQ, { kind: "mc" }> => q.kind === "mc").slice(0, 4).forEach((q) => mcs.push({ t: "mc", docId: d.id, title: d.title, q }));
      shuffle(snippets(d.notes)).slice(0, 3).forEach((text) => notes.push({ t: "note", docId: d.id, title: d.title, text }));
    });
    // interleave the three kinds so the feed never feels repetitive
    const a = shuffle(cards), b = shuffle(mcs), c = shuffle(notes);
    const out: Item[] = [];
    for (let i = 0; out.length < 40 && (a[i] || b[i] || c[i]); i++) [a[i], c[i], b[i]].forEach((x) => x && out.push(x));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.length, seed]);

  return (
    <div className="st-page sf">
      <header className="st-head sf-head">
        <div>
          <h1>Study Stream</h1>
          <p className="muted">An endless mix of due flashcards, quick questions and snippets from everything you've studied. Scroll to keep going.</p>
        </div>
        <div className="sf-tools">
          <div className={"sf-pomo" + (pomo.mode === "break" ? " break" : "")} role="timer" aria-label={`Pomodoro timer, ${pomo.mode === "break" ? "break" : "focus"}`}>
            {pomo.mode === "break" ? <Coffee size={16} /> : <Timer size={16} />}
            <b>{pomo.label}</b>
            <span className="sf-pomo-mode">{pomo.mode === "break" ? "Break" : "Focus"}</span>
            <button className="icon-btn" aria-label={pomo.running ? "Pause timer" : "Start timer"} onClick={pomo.toggle}>{pomo.running ? <Pause size={15} /> : <Play size={15} />}</button>
            <button className="icon-btn" aria-label="Reset timer" onClick={pomo.reset}><RotateCcw size={14} /></button>
          </div>
          <button onClick={() => setSeed(seed + 1)}><Shuffle size={15} /> Shuffle</button>
        </div>
      </header>
      {items.length === 0 && <p className="sf-empty muted">Nothing to stream yet. Create a lesson first.</p>}
      <div className="sf-feed">
        {items.map((it, i) => (
          <StreamCard key={`${seed}-${i}`} item={it} />
        ))}
      </div>
    </div>
  );
}

function StreamCard({ item }: { item: Item }) {
  const [flip, setFlip] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const head = (
    <button className="link sf-src" onClick={() => go(`/doc/${item.docId}`)}>
      <BookOpen size={13} /> {item.title}
    </button>
  );

  if (item.t === "note")
    return (
      <section className="sf-item note">
        {head}
        <Markdown text={item.text} />
      </section>
    );

  if (item.t === "mc")
    return (
      <section className="sf-item">
        {head}
        <Markdown text={item.q.q} className="qz-q" />
        <div className="qz-options">
          {item.q.options.map((o, k) => {
            const right = pick !== null && k === item.q.answer;
            const wrong = pick === k && k !== item.q.answer;
            return (
              <button key={k} disabled={pick !== null} className={"qz-opt" + (right ? " right" : "") + (wrong ? " wrong" : "") + (pick !== null && !right && !wrong ? " dim" : "")} onClick={() => (setPick(k), recordActivity())}>
                <span className="qz-badge" aria-hidden>{right ? <Check size={16} strokeWidth={3} /> : wrong ? <X size={16} strokeWidth={3} /> : "ABCD"[k]}</span>
                <span className="qz-opt-text"><Markdown text={o} /></span>
                {right && <span className="qz-flag">Correct answer</span>}
                {wrong && <span className="qz-flag">Your answer</span>}
              </button>
            );
          })}
        </div>
        {pick !== null && <Markdown text={item.q.explanation} className="muted small" />}
      </section>
    );

  return (
    <section className="sf-item">
      {head}
      <FlipCard compact front={item.card.front} back={item.card.back} flipped={flip} onFlip={() => setFlip(!flip)} />
      {flip && (
        <div className="rv-grades three">
          {([["Again", 1, "again"], ["Good", 4, "good"], ["Easy", 5, "easy"]] as const).map(([label, g, cls]) => (
            <button key={label} className={"rv-grade " + cls} onClick={() => {
              recordActivity();
              updateDoc(item.docId, (d) => ({ cards: d.cards.map((c) => (c.id === item.card.id ? review(c, g) : c)) }));
              setGone(true);
            }}>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
