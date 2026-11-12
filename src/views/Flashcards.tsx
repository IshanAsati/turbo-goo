import { useMemo, useState } from "react";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { isDue, newCard } from "../lib/srs";
import { recordActivity, uid, updateDoc } from "../lib/store";
import type { Card, Doc } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { ReviewDeck } from "../components/ReviewDeck";
import { confirmDialog } from "../components/feedback";

type Mode = "due" | "all" | "browse";

export const ankiTsv = (cards: Card[]) => cards.map((c) => `${c.front.replace(/[\t\n]+/g, " ")}\t${c.back.replace(/[\t\n]+/g, " ")}`).join("\n");

export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000); // revoking synchronously can cancel the download
}

export function Flashcards({ doc }: { doc: Doc }) {
  const due = doc.cards.filter((c) => isDue(c)).length;
  const [mode, setMode] = useState<Mode>(due ? "due" : doc.cards.length ? "browse" : "browse");
  const [session, setSession] = useState(0);
  const avg = doc.cards.length ? Math.round(doc.cards.reduce((a, c) => a + c.mastery, 0) / doc.cards.length) : 0;

  const items = useMemo(
    () => (mode === "browse" ? [] : (mode === "due" ? doc.cards.filter((c) => isDue(c)) : doc.cards).map((card) => ({ card, docId: doc.id }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, session],
  );

  return (
    <div>
      <div className="toolbar-row">
        <div className="seg">
          <button className={mode === "due" ? "on" : ""} onClick={() => (setMode("due"), setSession((s) => s + 1))}>Due <span className="count">{due}</span></button>
          <button className={mode === "all" ? "on" : ""} onClick={() => (setMode("all"), setSession((s) => s + 1))}>Study all</button>
          <button className={mode === "browse" ? "on" : ""} onClick={() => setMode("browse")}>Browse &amp; edit</button>
        </div>
        <span className="spacer" />
        <span className="muted small">Knowledge score {avg}%</span>
        <button onClick={() => download(`${doc.title}-flashcards.txt`, ankiTsv(doc.cards))} disabled={!doc.cards.length} title="Tab-separated; import into Anki via File → Import">
          <Download size={15} /> Anki
        </button>
      </div>

      {mode !== "browse" ? (
        <ReviewDeck
          key={mode + session}
          items={items}
          emptyText={doc.cards.length ? "Nothing due. You're all caught up!" : "No flashcards yet."}
          onGrade={(item, updated) => {
            recordActivity();
            updateDoc(doc.id, (d) => ({ cards: d.cards.map((c) => (c.id === updated.id ? updated : c)) }));
          }}
        >
          <button onClick={() => setMode("browse")}>Browse cards</button>
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
    <div>
      <div className="card add-card">
        <b className="small">Add your own card</b>
        <div className="row">
          <input aria-label="Front" placeholder="Front (question or term)" value={front} onChange={(e) => setFront(e.target.value)} />
          <input aria-label="Back" placeholder="Back (answer)" value={back} onChange={(e) => setBack(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="primary" onClick={add} disabled={!front.trim() || !back.trim()}><Plus size={15} /> Add</button>
        </div>
      </div>
      {doc.cards.length === 0 && <p className="muted">No cards yet. Add one above, or they appear here once generation finishes.</p>}
      <ul className="card-list">
        {doc.cards.map((c) => (
          <li key={c.id} className="card">
            {editing === c.id ? (
              <div className="stack">
                <input aria-label="Front" value={ef} onChange={(e) => setEf(e.target.value)} />
                <textarea aria-label="Back" rows={2} value={eb} onChange={(e) => setEb(e.target.value)} />
                <div className="row">
                  <button className="primary" disabled={!ef.trim() || !eb.trim()} onClick={() => (updateDoc(doc.id, (d) => ({ cards: d.cards.map((x) => (x.id === c.id ? { ...x, front: ef.trim(), back: eb.trim() } : x)) })), setEditing(null))}>Save</button>
                  <button onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="cl-main">
                  <Markdown text={c.front} className="cl-front" />
                  <Markdown text={c.back} className="cl-back" />
                </div>
                <div className="cl-meta">
                  <div className="bar mini" title={`Mastery ${c.mastery}%`}><div style={{ width: `${c.mastery}%` }} /></div>
                  <small className="muted">{c.reps === 0 ? "new" : isDue(c) ? "due" : `in ${Math.max(1, Math.round((c.due - Date.now()) / 864e5))}d`}</small>
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
