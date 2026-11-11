import { genCards, genCourse, genNotes, genPodcast, genQuiz } from "./ai";
import { addDoc, getState, saveAudio, setJob, updateDoc } from "./store";
import type { Doc, DocKind } from "./types";

/**
 * Background generation. The UI navigates to the document immediately and watches the job,
 * so notes stream in while flashcards and the quiz are still being written.
 */

const controllers = new Map<string, AbortController>();
const settings = () => getState().settings;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function begin(key: string) {
  controllers.get(key)?.abort();
  const c = new AbortController();
  controllers.set(key, c);
  return c.signal;
}

export function cancelJob(key: string) {
  controllers.get(key)?.abort();
  setJob(key, null);
}

export type NewDoc = { title: string; source: string; kind: DocKind; sourceUrl?: string; folderId?: string | null; audio?: Blob };

export function createDoc(o: NewDoc): string {
  const d = addDoc({ title: o.title, source: o.source, kind: o.kind, sourceUrl: o.sourceUrl, folderId: o.folderId ?? "f-general", hasAudio: !!o.audio });
  if (o.audio) void saveAudio(d.id, o.audio);
  void generateMissing(d.id);
  return d.id;
}

/** Fill in whatever the document is still missing (notes, cards, quiz). Safe to call again to retry. */
export async function generateMissing(id: string) {
  const signal = begin(id);
  const get = () => getState().docs.find((d) => d.id === id);
  let d = get();
  if (!d) return;
  try {
    if (!d.notes.trim() && d.source.trim()) {
      setJob(id, { step: "Writing your notes…" });
      let last = 0;
      const final = await genNotes(settings(), d.title, d.source, d.kind, (t) => {
        if (Date.now() - last > 200) {
          last = Date.now();
          updateDoc(id, { notes: t });
        }
      }, { signal });
      updateDoc(id, { notes: final });
    }
    d = get();
    if (!d) return;
    const text = d.source || d.notes;
    const needCards = d.cards.length === 0;
    const needQuiz = d.quiz.length === 0;
    if (text.trim() && (needCards || needQuiz)) {
      setJob(id, { step: "Creating flashcards and a quiz…" });
      const [cards, quiz] = await Promise.all([needCards ? genCards(settings(), text, { signal }) : Promise.resolve(d.cards), needQuiz ? genQuiz(settings(), text, 10, [], { signal }) : Promise.resolve(d.quiz)]);
      updateDoc(id, { cards, quiz });
    }
    setJob(id, { step: "", done: true });
    setTimeout(() => setJob(id, null), 2500);
  } catch (e) {
    if (signal.aborted) return;
    setJob(id, { step: "", error: msg(e) });
  } finally {
    if (controllers.get(id)?.signal === signal) controllers.delete(id);
  }
}

export async function generatePodcast(d: Doc) {
  const key = `${d.id}:podcast`;
  const signal = begin(key);
  setJob(key, { step: "Writing the script…" });
  try {
    const podcast = await genPodcast(settings(), d.title, d.notes || d.source, { signal });
    updateDoc(d.id, { podcast });
    setJob(key, null);
  } catch (e) {
    if (!signal.aborted) setJob(key, { step: "", error: msg(e) });
  }
}

export async function generateCourse(d: Doc) {
  const key = `${d.id}:course`;
  const signal = begin(key);
  setJob(key, { step: "Designing your 12-section course…" });
  try {
    const course = await genCourse(settings(), d.title, d.source || d.notes, { signal });
    updateDoc(d.id, { course });
    setJob(key, null);
  } catch (e) {
    if (!signal.aborted) setJob(key, { step: "", error: msg(e) });
  }
}

export async function moreQuiz(d: Doc, count = 10) {
  const key = `${d.id}:quiz`;
  const signal = begin(key);
  setJob(key, { step: "Writing new questions…" });
  try {
    const extra = await genQuiz(settings(), d.source || d.notes, count, d.quiz.map((q) => q.q), { signal });
    updateDoc(d.id, (cur) => ({ quiz: [...cur.quiz, ...extra] }));
    setJob(key, null);
    return extra;
  } catch (e) {
    if (!signal.aborted) setJob(key, { step: "", error: msg(e) });
    return [];
  }
}

/** Learn Mode: topic or source -> 12-section course, then the usual notes/cards/quiz derived from it. */
export function createCourseDoc(o: NewDoc): string {
  const d = addDoc({ title: o.title, source: o.source, kind: o.kind, folderId: o.folderId ?? "f-general" });
  void (async () => {
    const key = `${d.id}:course`;
    const signal = begin(key);
    setJob(d.id, { step: "Designing your 12-section course…" });
    setJob(key, { step: "Designing your 12-section course…" });
    try {
      const course = await genCourse(settings(), o.title, o.source, { signal });
      const lessons = course.map((c, i) => `## ${i + 1}. ${c.title}\n\n${c.lesson}`).join("\n\n");
      updateDoc(d.id, { course, source: o.source || lessons, notes: o.source ? "" : `# ${o.title}\n\n${lessons}` });
      setJob(key, null);
      await generateMissing(d.id);
    } catch (e) {
      if (!signal.aborted) {
        setJob(d.id, { step: "", error: msg(e) });
        setJob(key, { step: "", error: msg(e) });
      }
    }
  })();
  return d.id;
}

export function regenerate(d: Doc, what: "notes" | "cards" | "quiz") {
  updateDoc(d.id, what === "notes" ? { notes: "" } : what === "cards" ? { cards: [] } : { quiz: [] });
  void generateMissing(d.id);
}
