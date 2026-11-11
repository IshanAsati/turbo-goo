import { useMemo } from "react";
import { go } from "../lib/nav";
import { getState, recordActivity, updateDoc, useStore } from "../lib/store";
import { isDue } from "../lib/srs";
import { shuffle } from "../lib/text";
import { ReviewDeck, type ReviewItem } from "../components/ReviewDeck";

/** Global review: every due card across all documents, interleaved. */
export function Review() {
  const { docs } = useStore();
  const items: ReviewItem[] = useMemo(
    () => shuffle(docs.flatMap((d) => d.cards.filter((c) => isDue(c)).map((card) => ({ card, docId: d.id, docTitle: d.title })))).slice(0, 60),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return (
    <div className="page narrow">
      <h1>Review</h1>
      <ReviewDeck
        key="review"
        items={items}
        onGrade={(item, updated) => {
          recordActivity();
          updateDoc(item.docId, (d) => ({ cards: d.cards.map((c) => (c.id === updated.id ? updated : c)) }));
        }}
      >
        <button className="primary" onClick={() => go("/")}>Back to library</button>
        {getState().docs.length === 0 && <p className="muted">Create a document first to get flashcards.</p>}
      </ReviewDeck>
    </div>
  );
}
