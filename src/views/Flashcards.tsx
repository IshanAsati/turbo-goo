import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { isDue, newCard } from "../lib/srs";
import { recordActivity, uid, updateDoc, useJob } from "../lib/store";
import { generateCards, regenerate } from "../lib/generate";
import type { Card, Doc } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { ReviewDeck } from "../components/ReviewDeck";
import { GeneratorScreen } from "../components/GeneratorScreen";
import { confirmDialog } from "../components/feedback";
import "../styles/study.css";

type Mode = "due" | "all" | "browse";

export const ankiTsv = (cards: Card[]) => cards.map((c) => `${c.front.replace(/[\t\n]+/g, " ")}\t${c.back.replace(/[\t\n]+/g, " ")}`).join("\n");

export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000); // revoking synchronously can cancel the download
}

export function Flashcards({ doc }: { doc: Doc }) {
  const job = useJob(doc.id + ":cards");
  const due = doc.cards.filter((c) => isDue(c)).length;
  const [picked, setPicked] = useState<Mode | null>(null);
  const [session, setSession] = useState(0);
  const [more, setMore] = useState(false); // the student opened the generator to add more cards to an existing deck
  const before = useRef(0);
  const mode: Mode = picked ?? (due ? "due" : "browse");
  const avg = doc.cards.length ? Math.round(doc.cards.reduce((a, c) => a + c.mastery, 0) / doc.cards.length) : 0;

  const items = useMemo(
    () => (mode === "browse" ? [] : (mode === "due" ? doc.cards.filter((c) => isDue(c)) : doc.cards).map((card) => ({ card, docId: doc.id }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, session],
  );

  // An empty deck (new, or just cleared by Regenerate) starts fresh; freshly written cards open in Due.
  useEffect(() => {
    if (!doc.cards.length) setPicked(null);
  }, [doc.cards.length]);
  useEffect(() => {
    if (more && !job && doc.cards.length > before.current) {
      setMore(false);
      setPicked(null);
      setSession((s) => s + 1);
    }
  }, [more, job, doc.cards.length]);

  const generating = !!job && !job.error;
  if (!doc.cards.length || more || generating || job?.error) {
    return (
      <div className="st-wrap">
        <GeneratorScreen
          doc={doc}
          kind="cards"
          job={job}
          jobKey={doc.id + ":cards"}
          onGenerate={(o) => ((before.current = doc.cards.length), void generateCards(doc, o))}
          onBack={doc.cards.length ? () => setMore(false) : undefined}
        />
      </div>
    );
  }

  const pick = (m: Mode) => (setPicked(m), m !== "browse" && setSession((s) => s + 1));

  return (
    <div className="st-wrap fc">
      <div className="fc-bar">
        <div className="seg" role="tablist" aria-label="Study mode">
          <button role="tab" aria-selected={mode === "due"} className={mode === "due" ? "on" : ""} onClick={() => pick("due")}>Due <span className="fc-count">{due}</span></button>
          <button role="tab" aria-selected={mode === "all"} className={mode === "all" ? "on" : ""} onClick={() => pick("all")}>Study all</button>
          <button role="tab" aria-selected={mode === "browse"} className={mode === "browse" ? "on" : ""} onClick={() => pick("browse")}>Browse &amp; edit</button>
        </div>
        <span className="fc-score" title="Average mastery across the deck">Mastery <b>{avg}%</b></span>
        <span className="spacer" />
        <button className="fc-act" onClick={() => (before.current = doc.cards.length, setMore(true))} title="Write more flashcards from your notes"><Sparkles size={15} /> Generate more</button>
        <button
          className="fc-act"
          onClick={async () => (await confirmDialog("Regenerate flashcards?", "Your current flashcards and their progress will be removed, then you can choose how to write a new set.", "Regenerate", true)) && regenerate(doc, "cards")}
        >
          <RefreshCw size={15} /> Regenerate
        </button>
        <button className="fc-act fc-icon" aria-label="Export to Anki" onClick={() => download(`${doc.title}-flashcards.txt`, ankiTsv(doc.cards))} title="Export to Anki (tab-separated; import via File → Import)">
          <Download size={16} />
        </button>
      </div>

      {mode !== "browse" ? (
        <ReviewDeck
          key={mode + session}
          items={items}
          emptyText={mode === "due" ? "Nothing due. You're all caught up!" : "No flashcards yet."}
          onGrade={(_item, updated) => {
            recordActivity();
            updateDoc(doc.id, (d) => ({ cards: d.cards.map((c) => (c.id === updated.id ? updated : c)) }));
          }}
        >
          {mode === "due" && <button className="primary" onClick={() => pick("all")}>Study all cards</button>}
          <button onClick={() => pick("browse")}>Browse cards</button>
        </ReviewDeck>
      ) : (
        <Browse doc={doc} />
      )}
    </div>
  );
}

function Browse({ doc }: { doc: Doc }) {
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [ef, setEf] = useState("");
  const [eb, setEb] = useState("");

  const add = () => {
    if (!front.trim() || !back.trim()) return;
    updateDoc(doc.id, (d) => ({ cards: [newCard(uid(), front.trim(), back.trim(), true), ...d.cards] }));
    setFront("");
    setBack("");
  };

  return (
    <div className="fc-browse">
      <div className="fc-add">
        <b>Add your own card</b>
        <div className="fc-add-row">
          <input aria-label="Front" placeholder="Front (question or term)" value={front} onChange={(e) => setFront(e.target.value)} />
          <input aria-label="Back" placeholder="Back (answer)" value={back} onChange={(e) => setBack(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="primary" onClick={add} disabled={!front.trim() || !back.trim()}><Plus size={15} /> Add</button>
        </div>
      </div>
      <ul className="fc-list">
        {doc.cards.map((c) => (
          <li key={c.id} className="fc-item">
            {editing === c.id ? (
              <div className="fc-edit">
                <input aria-label="Front" value={ef} onChange={(e) => setEf(e.target.value)} />
                <textarea aria-label="Back" rows={2} value={eb} onChange={(e) => setEb(e.target.value)} />
                <div className="fc-edit-row">
                  <button className="primary" disabled={!ef.trim() || !eb.trim()} onClick={() => (updateDoc(doc.id, (d) => ({ cards: d.cards.map((x) => (x.id === c.id ? { ...x, front: ef.trim(), back: eb.trim() } : x)) })), setEditing(null))}>Save</button>
                  <button onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="fc-item-main">
                  <Markdown text={c.front} className="fc-front" />
                  <Markdown text={c.back} className="fc-back" />
                </div>
                <div className="fc-item-meta">
                  <div className="bar mini" title={`Mastery ${c.mastery}%`}><div style={{ width: `${c.mastery}%` }} /></div>
                  <small>{c.reps === 0 ? "new" : isDue(c) ? "due" : `in ${Math.max(1, Math.round((c.due - Date.now()) / 864e5))}d`}</small>
                  <button className="icon-btn" aria-label="Edit card" onClick={() => (setEditing(c.id), setEf(c.front), setEb(c.back))}><Pencil size={15} /></button>
                  <button
                    className="icon-btn"
                    aria-label="Delete card"
                    onClick={async () => (await confirmDialog("Delete card?", "This can't be undone.", "Delete", true)) && updateDoc(doc.id, (d) => ({ cards: d.cards.filter((x) => x.id !== c.id) }))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
