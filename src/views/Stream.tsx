import { useMemo, useState } from "react";
import { BookOpen, Coffee, Pause, Play, RotateCcw, Shuffle, Timer } from "lucide-react";
import { go } from "../lib/nav";
import { isDue, review } from "../lib/srs";
import { recordActivity, updateDoc, useStore } from "../lib/store";
import { shuffle } from "../lib/text";
import type { Card, QuizQ } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { usePomodoro } from "./pomodoro";

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
    <div className="page narrow">
      <div className="toolbar-row">
        <h1>Study Stream</h1>
        <span className="spacer" />
        <div className={"pomo" + (pomo.mode === "break" ? " break" : "")} role="timer" aria-label="Pomodoro timer">
          {pomo.mode === "break" ? <Coffee size={16} /> : <Timer size={16} />}
          <b>{pomo.label}</b>
          <button className="icon-btn" aria-label={pomo.running ? "Pause timer" : "Start timer"} onClick={pomo.toggle}>{pomo.running ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="icon-btn" aria-label="Reset timer" onClick={pomo.reset}><RotateCcw size={14} /></button>
        </div>
        <button onClick={() => setSeed(seed + 1)}><Shuffle size={15} /> Shuffle</button>
      </div>
      <p className="muted">An endless mix of due flashcards, quick questions and snippets from everything you've studied. Scroll to keep going.</p>
      {items.length === 0 && <p className="muted">Nothing to stream yet. Create a document first.</p>}
      <div className="feed">
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
    <button className="link small stream-src" onClick={() => go(`/doc/${item.docId}`)}>
      <BookOpen size={13} /> {item.title}
    </button>
  );

  if (item.t === "note")
    return (
      <section className="stream-item note">
        {head}
        <Markdown text={item.text} />
      </section>
    );

  if (item.t === "mc")
    return (
      <section className="stream-item">
        {head}
        <Markdown text={item.q.q} className="qtext" />
        <div className="options">
          {item.q.options.map((o, k) => (
            <button key={k} disabled={pick !== null} className={"option" + (pick !== null && k === item.q.answer ? " right" : "") + (pick === k && k !== item.q.answer ? " wrong" : "")} onClick={() => (setPick(k), recordActivity())}>
              <Markdown text={o} />
            </button>
          ))}
        </div>
        {pick !== null && <Markdown text={item.q.explanation} className="muted small" />}
      </section>
    );

  return (
    <section className="stream-item">
      {head}
      <button className={"flash small-flash" + (flip ? " flipped" : "")} onClick={() => setFlip(!flip)}>
        <span className="face front"><Markdown text={item.card.front} /></span>
        <span className="face back"><Markdown text={item.card.back} /></span>
      </button>
      {flip && (
        <div className="grades">
          {([["Again", 1], ["Good", 4], ["Easy", 5]] as const).map(([label, g]) => (
            <button key={label} className={"grade " + label.toLowerCase()} onClick={() => {
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
