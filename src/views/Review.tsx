import { useMemo } from "react";
import { go } from "../lib/nav";
import { getState, recordActivity, updateDoc, useStore } from "../lib/store";
import { isDue } from "../lib/srs";
import { shuffle } from "../lib/text";
import { ReviewDeck, type ReviewItem } from "../components/ReviewDeck";
import "../styles/study.css";

/** Global review: every due card across all documents, interleaved. */
export function Review() {
  const { docs } = useStore();
  const items: ReviewItem[] = useMemo(
    () => shuffle(docs.flatMap((d) => d.cards.filter((c) => isDue(c)).map((card) => ({ card, docId: d.id, docTitle: d.title })))).slice(0, 60),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const docCount = new Set(items.map((x) => x.docId)).size;
  return (
    <div className="st-page">
      <header className="st-head">
        <h1>Review</h1>
        <p className="muted">
          {items.length ? `${items.length} card${items.length === 1 ? "" : "s"} due${docCount > 1 ? ` across ${docCount} lessons` : ""}. Flip, then say how it went.` : "Your due flashcards from every lesson, mixed together."}
        </p>
      </header>
      <ReviewDeck
        key="review"
        items={items}
        onGrade={(item, updated) => {
          recordActivity();
          updateDoc(item.docId, (d) => ({ cards: d.cards.map((c) => (c.id === updated.id ? updated : c)) }));
        }}
      >
        <button className="primary" onClick={() => go("/")}>Back to home</button>
        {getState().docs.length === 0 && <p className="muted">Create a lesson first, then ask for flashcards from its notes.</p>}
      </ReviewDeck>
    </div>
  );
}
