import { genCards, genLesson, genNotes, genOutline, genPodcast, genQuiz } from "./ai";
import { addDoc, getState, saveAudio, setJob, updateDoc } from "./store";
import { detectSubject } from "./subjects";
import type { Doc, DocKind, Section, Subject } from "./types";

/**
 * Background generation. The UI navigates to the document immediately and watches the job.
 * Notes are written from the source automatically. Flashcards and quizzes are written only when the student asks
 * (generateCards / generateQuiz), from the notes alone, which keeps those prompts short.
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

export type NewDoc = { title: string; source: string; kind: DocKind; sourceUrl?: string; folderId?: string | null; audio?: Blob; subject?: Subject };

/** The document's subject: the user's choice, else a guess from its title and text (stored so it stays stable). */
function subjectOf(d: Doc): Subject {
  if (d.subject) return d.subject;
  const guess = detectSubject(d.title, d.source || d.notes);
  updateDoc(d.id, { subject: guess });
  return guess;
}

export function createDoc(o: NewDoc): string {
  const d = addDoc({ title: o.title, source: o.source, kind: o.kind, sourceUrl: o.sourceUrl, folderId: o.folderId ?? "f-general", hasAudio: !!o.audio, subject: o.subject });
  if (o.audio) void saveAudio(d.id, o.audio);
  void generateMissing(d.id);
  return d.id;
}

/**
 * Write the notes for a document that has a source but no notes yet. Safe to call again to retry.
 * Flashcards and quizzes are NOT written here any more: the student asks for them from the Flashcards and Quiz
 * screens (see generateCards / generateQuiz), choosing how many and what to focus on.
 */
export async function generateMissing(id: string) {
  const get = () => getState().docs.find((d) => d.id === id);
  const d = get();
  if (!d) return;
  subjectOf(d); // keep the subject stable even when there is nothing to write
  if (d.notes.trim() || !d.source.trim()) return; // nothing to do: no job, no banner
  const signal = begin(id);
  try {
    const subject = subjectOf(d);
    let last = 0;
    let thinking = false;
    setJob(id, { step: "Writing your notes…" });
    const final = await genNotes(
      settings(),
      d.title,
      d.source,
      d.kind,
      (t) => {
        if (Date.now() - last > 200) {
          last = Date.now();
          updateDoc(id, { notes: t });
        }
      },
      {
        signal,
        subject,
        onThinking: () => {
          if (thinking) return;
          thinking = true;
          setJob(id, { step: "Model is thinking before it writes…" });
        },
      },
    );
    updateDoc(id, { notes: final });
    if (signal.aborted) return;

    setJob(id, { step: "", done: true });
    setTimeout(() => setJob(id, null), 2500);
  } catch (e) {
    if (signal.aborted) return;
    setJob(id, { step: "", error: msg(e) });
  } finally {
    if (controllers.get(id)?.signal === signal) controllers.delete(id);
  }
}

/** What the student chose on the generator screen. */
export type GenerateOpts = { count: number; instructions?: string };

/** Write flashcards from the notes only and add them to the deck (skipping fronts already in it). Job key `${id}:cards`. */
export async function generateCards(d: Doc, o: GenerateOpts) {
  const key = `${d.id}:cards`;
  const signal = begin(key);
  setJob(key, { step: `Writing ${o.count} flashcards from your notes…` });
  try {
    const cur = getState().docs.find((x) => x.id === d.id) ?? d;
    if (!cur.notes.trim()) throw new Error("There are no notes to build flashcards from yet.");
    const cards = await genCards(settings(), cur.notes, { signal, subject: subjectOf(cur), count: o.count, instructions: o.instructions, avoid: cur.cards.map((c) => c.front) });
    if (signal.aborted) return;
    if (!cards.length) throw new Error("No new flashcards could be made from these notes. Try different instructions, or add more to your notes.");
    updateDoc(d.id, (c) => ({ cards: [...c.cards, ...cards] }));
    setJob(key, null);
  } catch (e) {
    if (!signal.aborted) setJob(key, { step: "", error: msg(e) });
  } finally {
    if (controllers.get(key)?.signal === signal) controllers.delete(key);
  }
}

/** Write a quiz from the notes only and add it to the doc's questions (skipping repeats). Job key `${id}:quiz`. */
export async function generateQuiz(d: Doc, o: GenerateOpts) {
  const key = `${d.id}:quiz`;
  const signal = begin(key);
  setJob(key, { step: `Writing ${o.count} questions from your notes…` });
  try {
    const cur = getState().docs.find((x) => x.id === d.id) ?? d;
    if (!cur.notes.trim()) throw new Error("There are no notes to write questions from yet.");
    const qs = await genQuiz(settings(), cur.notes, o.count, cur.quiz.map((q) => q.q), { signal, subject: subjectOf(cur), count: o.count, instructions: o.instructions });
    if (signal.aborted) return;
    if (!qs.length) throw new Error("No new questions could be made from these notes. Try different instructions, or add more to your notes.");
    updateDoc(d.id, (c) => ({ quiz: [...c.quiz, ...qs] }));
    setJob(key, null);
  } catch (e) {
    if (!signal.aborted) setJob(key, { step: "", error: msg(e) });
  } finally {
    if (controllers.get(key)?.signal === signal) controllers.delete(key);
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

/** Add more questions to an existing quiz (the "More questions" button). Resolves to the new questions. */
export async function moreQuiz(d: Doc, count = 10) {
  const key = `${d.id}:quiz`;
  const signal = begin(key);
  setJob(key, { step: "Writing new questions from your notes…" });
  try {
    const cur = getState().docs.find((x) => x.id === d.id) ?? d;
    if (!cur.notes.trim()) throw new Error("There are no notes to write questions from.");
    const extra = await genQuiz(settings(), cur.notes, count, cur.quiz.map((q) => q.q), { signal, subject: subjectOf(cur) });
    if (signal.aborted) return [];
    updateDoc(d.id, (c) => ({ quiz: [...c.quiz, ...extra] }));
    setJob(key, null);
    return extra;
  } catch (e) {
    if (!signal.aborted) setJob(key, { step: "", error: msg(e) });
    return [];
  } finally {
    if (controllers.get(key)?.signal === signal) controllers.delete(key);
  }
}
/* ------------------------------------------------------------------ */
/* Courses: outline first, then one call per lesson (2 at a time).     */
/* ------------------------------------------------------------------ */

const courseKey = (id: string) => `${id}:course`;
const getDoc = (id: string) => getState().docs.find((x) => x.id === id);
/** True while a course job for this key is running (not cancelled). */
const live = (key: string) => {
  const c = controllers.get(key);
  return !!c && !c.signal.aborted;
};
/** Which run currently owns a lesson. A cancelled run must not touch a lesson a newer run has taken over. */
const owners = new Map<string, AbortSignal>();
const patchSection = (docId: string, secId: string, patch: Partial<Section>) =>
  updateDoc(docId, (d) => ({ course: d.course.map((x) => (x.id === secId ? { ...x, ...patch } : x)) }));
const BLANK: Partial<Section> = { lesson: "", example: undefined, practice: undefined, recap: undefined };

/** Source text lessons are written from. A topic-only course has none: the model teaches from its own knowledge. */
const courseMaterial = (d: Doc) => (d.kind === "topic" ? "" : d.source || d.notes);

/**
 * Build the course for a document, or finish it: with no lessons yet this writes the outline and then every lesson;
 * with lessons it writes only the pending and failed ones (lessons already written are never touched).
 * `only` writes just that lesson (used by Retry). `rebuild` replaces the whole course.
 */
export async function generateCourse(d: Doc, o: { rebuild?: boolean; only?: string } = {}) {
  const key = courseKey(d.id);
  const signal = begin(key);
  setJob(key, { step: o.rebuild || !d.course.length ? "Designing your course outline…" : "Starting…" });
  try {
    const subject0 = subjectOf(d);
    const material = courseMaterial(d);
    if (o.rebuild || !getDoc(d.id)?.course.length) {
      const out = await genOutline(settings(), d.title, material, {
        signal,
        subject: subject0,
        onThinking: () => !signal.aborted && setJob(key, { step: "Designing your course outline (the model is thinking first)…" }),
      });
      if (signal.aborted) return;
      updateDoc(d.id, { course: out.sections, courseInfo: out.info });
    }
    // A bare title ("Quadratic equations") is a weak signal; the outline's lesson titles and objectives make the subject clear.
    let subject = subject0;
    if (subject === "general") {
      const cur = getDoc(d.id);
      const guess = detectSubject(d.title, (cur?.course ?? []).map((s) => `${s.title} ${(s.objectives ?? []).join(" ")}`).join("\n") + "\n" + (cur?.courseInfo?.summary ?? ""));
      if (guess !== "general") (subject = guess), updateDoc(d.id, { subject: guess });
    }
    const ok = await writeLessons(d.id, key, signal, subject, o.only);
    if (signal.aborted || !ok) return;
    setJob(key, null);
    await finishCourse(d.id, signal);
  } catch (e) {
    if (!signal.aborted) setJob(key, { step: "", error: msg(e) });
  } finally {
    if (controllers.get(key)?.signal === signal) controllers.delete(key);
  }
}

export const rebuildCourse = (d: Doc) => generateCourse(d, { rebuild: true });

/** Put one failed lesson back in the queue. Joins the running job if there is one, else starts a small one. */
export function retryLesson(docId: string, secId: string) {
  patchSection(docId, secId, { status: "pending", error: undefined });
  const d = getDoc(docId);
  if (d && !live(courseKey(docId))) void generateCourse(d, { only: secId });
}

/** Writes lessons with up to two calls in flight. Returns false if it gave up (the job then carries the error). */
async function writeLessons(docId: string, key: string, signal: AbortSignal, subject: Subject, only?: string): Promise<boolean> {
  const first = getDoc(docId);
  if (!first) return false;
  const retry = new Set(first.course.filter((x) => x.status === "failed").map((x) => x.id));
  const taken = new Set<string>();
  const next = () =>
    getDoc(docId)?.course.find(
      (x) => !taken.has(x.id) && (only ? x.id === only : x.status === "pending" || x.status === "writing" || (x.status === "failed" && retry.has(x.id))),
    );
  let ok = 0;
  let failedInARow = 0;
  let lastError = "";
  let gaveUp = false;

  const writeOne = async (secId: string) => {
    const own = `${docId}:${secId}`;
    owners.set(own, signal);
    const d0 = getDoc(docId);
    if (!d0) return;
    const index = d0.course.findIndex((x) => x.id === secId);
    const label = `Writing lesson ${index + 1} of ${d0.course.length}`;
    patchSection(docId, secId, { ...BLANK, status: "writing", error: undefined });
    setJob(key, { step: `${label}…` });
    let thinking = false;
    try {
      const parts = await genLesson(
        settings(),
        { title: d0.title, info: d0.courseInfo, sections: d0.course, index, material: courseMaterial(d0) },
        {
          signal,
          subject,
          onThinking: () => {
            if (thinking || signal.aborted) return;
            thinking = true;
            setJob(key, { step: `${label} (the model is thinking first)…` });
          },
          onPartial: (p) => {
            if (!signal.aborted && owners.get(own) === signal) patchSection(docId, secId, { lesson: p.lesson, example: p.example, practice: p.practice, recap: p.recap });
          },
        },
      );
      if (owners.get(own) !== signal) return;
      patchSection(docId, secId, { ...BLANK, ...parts, status: "ready", error: undefined });
      ok++;
      failedInARow = 0;
    } catch (e) {
      if (owners.get(own) !== signal) return;
      if (signal.aborted) {
        // Cancelled mid-lesson: hand it back to the queue so "Write remaining lessons" picks it up.
        patchSection(docId, secId, { ...BLANK, status: "pending", error: undefined });
        return;
      }
      lastError = msg(e);
      patchSection(docId, secId, { ...BLANK, status: "failed", error: lastError });
      failedInARow++;
      // Two failures with no success usually means a wrong key, model or URL: stop instead of burning through every lesson.
      if (ok === 0 && failedInARow >= 2) gaveUp = true;
    }
  };

  const worker = async () => {
    while (!signal.aborted && !gaveUp) {
      const sec = next();
      if (!sec) return;
      taken.add(sec.id);
      await writeOne(sec.id);
    }
  };
  await Promise.all([worker(), worker()]);
  if (signal.aborted) return false;
  if (gaveUp) {
    setJob(key, { step: "", error: `Stopped after repeated errors. ${lastError}` });
    return false;
  }
  return true;
}

/** Once every lesson is written: fill in notes (compact, from the recaps, for a topic course), then cards and quiz. */
async function finishCourse(docId: string, signal: AbortSignal) {
  const d = getDoc(docId);
  if (!d || signal.aborted) return;
  if (d.course.some((x) => x.status === "pending" || x.status === "writing" || x.status === "failed")) return;
  if (!d.notes.trim() && !d.source.trim()) {
    // Topic only: notes are the outline plus each lesson's recap, a few hundred words, not the lessons themselves.
    updateDoc(docId, { notes: compactNotes(d), source: lessonsAsSource(d) });
  }
  const cur = getDoc(docId);
  if (cur && (!cur.notes.trim() || cur.cards.length === 0 || cur.quiz.length === 0)) await generateMissing(docId);
}

function compactNotes(d: Doc): string {
  const lines = [`# ${d.title}`, ""];
  if (d.courseInfo?.summary) lines.push(d.courseInfo.summary, "");
  d.course.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s.title}`, "");
    const points = (s.recap?.length ? s.recap : s.objectives ?? []).slice(0, 3);
    points.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  });
  return lines.join("\n").trim();
}

/** The lessons as one text, so chat and the podcast can be grounded in what the course taught. */
function lessonsAsSource(d: Doc): string {
  return [`# ${d.title}`, ...d.course.map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.lesson}${s.example ? `\n\nWorked example:\n${s.example}` : ""}`)].join("\n\n");
}

/** Learn Mode: topic or source -> an outline, then lessons written one by one; notes, cards and quiz follow. */
export function createCourseDoc(o: NewDoc): string {
  const d = addDoc({ title: o.title, source: o.source, kind: o.kind, sourceUrl: o.sourceUrl, folderId: o.folderId ?? "f-general", subject: o.subject });
  void generateCourse(d);
  return d.id;
}

/** Notes are rewritten from the source. Cards and the quiz are just cleared: their generator screen then asks what to write. */
export function regenerate(d: Doc, what: "notes" | "cards" | "quiz") {
  if (what !== "notes") cancelJob(`${d.id}:${what}`);
  updateDoc(d.id, what === "notes" ? { notes: "" } : what === "cards" ? { cards: [] } : { quiz: [] });
  if (what === "notes") void generateMissing(d.id);
}
