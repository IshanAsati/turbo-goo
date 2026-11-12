import type { Attachment, Card, ChatMsg, CourseInfo, DocKind, PodcastLine, PracticeQ, QuizQ, Section, Settings, Subject } from "./types";
import { LLMError, complete, completeJSON, hasLLM, modelFor, parseJSON, stream, ttsSupportsTags } from "./llm";
import { newCard } from "./srs";
import { uid } from "./store";
import { detectSubject, guide } from "./subjects";
import { cap, chunk, contentWords, dedupeBy, mask, normalizeAnswer, retrieve, segments, sentences, shuffle, topKeywords, topSentences } from "./text";

type Opt = { signal?: AbortSignal; subject?: Subject };
const clip = (s: string, n = 24000) => (s.length > n ? s.slice(0, n) : s);
const noisy = (k: DocKind) => k === "audio" || k === "youtube";

/** Run an LLM JSON call; retry once if the model returned something unparseable.
 *  With an API key configured a second failure is an error the user can see and retry, not a silent switch to the weak offline engine. */
async function json<T>(s: Settings, tier: "fast" | "smart", system: string, user: string, o: Opt): Promise<T | null> {
  if (!hasLLM(s)) return null;
  for (let i = 0; i < 2; i++) {
    if (o.signal?.aborted) throw new LLMError("Cancelled.");
    const r = await completeJSON<T>(s, tier, system, user, o);
    if (r) return r;
  }
  throw new LLMError("The model didn't return usable JSON twice in a row. Try again, or pick a different model in Settings.");
}

/* ------------------------------------------------------------------ */
/* Notes                                                                */
/* ------------------------------------------------------------------ */

const notesSystem = (targetWords: number, extra = "") => `You write concise study notes that a student can revise from in minutes. You compress; you do not transcribe.

LENGTH (strict): about ${targetWords} words. The absolute ceiling is ${Math.round(targetWords * 1.3)} words: a longer answer is a failure, so drop the least important bullets instead of going over. Shorter is better than padded; stop when the key ideas are covered.

FORMAT (Markdown):
- Start with "# Title" (only when told to), then 3-6 "## Section" headings in the source's order.
- Under each heading: 3-7 short bullets, one idea each, at most ~20 words per bullet. No paragraphs, no sub-sub-bullets.
- **Bold** a key term where it is defined. Use a table only when comparing 3+ things on the same attributes.
- Math and chemistry use LaTeX ($x^2$ inline, $$...$$ for display). Give the result and the one step that matters, not every line of algebra.
- At most one "> 💡 Example:" blockquote per section, and only when the example teaches something the bullets cannot.

WHAT TO KEEP: definitions, laws and formulas, cause and effect, distinctions between easily confused things, worked-example results, anything the speaker says is important or examinable.
WHAT TO DROP: greetings, jokes, administration, tangents, repetition, anecdotes, filler, and the same point made twice. If two bullets say the same thing, keep one.

RULES:
- Use only what is in the source. Never invent facts, numbers or examples.
- If the speaker flagged confusion with "[?]", list those moments under "## Open questions".
- End with "## Key takeaways": 3-5 bullets, each a different idea not already stated word-for-word above.${extra}`;

/** Words per note part: about a fifth of a long source, a bit under half of a short one (which is already dense), kept inside a sensible range. */
const noteTarget = (partWords: number) => (partWords < 450 ? Math.max(60, Math.round(partWords * 0.4)) : Math.max(120, Math.min(450, Math.round(partWords * 0.2))));
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function genNotes(s: Settings, title: string, source: string, kind: DocKind, onPartial: (text: string) => void, o: Opt & { onThinking?: () => void } = {}): Promise<string> {
  if (hasLLM(s)) {
    const parts = segments(source, 14000);
    const out: string[] = parts.map(() => "");
    const show = () => onPartial(out.filter(Boolean).join("\n\n"));
    const note = noisy(kind) ? "This is a noisy classroom/video transcript: remove chatter and tangents but keep what the instructor emphasises.\n" : "";
    // Segments don't depend on each other, so write up to 3 at once and stitch them back in order.
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < parts.length; i = next++) {
        if (o.signal?.aborted) return;
        const target = noteTarget(wordCount(parts[i]));
        const multi = parts.length > 1 ? `This is part ${i + 1} of ${parts.length}. ${i === 0 ? 'Start with the "# Title".' : "Continue the notes: no title, and no Key takeaways or Open questions yet."}\n` : "";
        out[i] = await stream(
          s,
          "smart",
          [
            { role: "system", content: notesSystem(target, guide(s, o.subject, "notes")) },
            { role: "user", content: `${note}${multi}Title: ${title}\n\nSource:\n${parts[i]}` },
          ],
          (t) => ((out[i] = t), show()),
          // Hard backstop: ~1.6 tokens per word of the longest allowed note, plus room for reasoning tokens.
          { ...o, onThinking: o.onThinking, maxTokens: Math.round(target * 1.3 * 1.6) + 1500 },
        );
        show();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, parts.length) }, worker));
    let acc = out.join("\n\n");
    if (parts.length > 1 && !o.signal?.aborted) {
      const tk = await complete(s, "fast", [{ role: "user", content: `Write a "## Key takeaways" section for these notes: 4-6 bullets, each under 20 words, each a different idea. Output only the section.\n\n${clip(acc, 20000)}` }], { ...o, maxTokens: 1200 });
      acc += "\n\n" + tk;
      onPartial(acc);
    }
    return acc;
  }

  // Offline: cluster source into sections, summarise each by its top sentences.
  const lines = [`# ${title}`, "", "> Generated by the offline engine. Add an API key in Settings for much better notes.", ""];
  const kw = topKeywords(source, 8);
  if (kw.length) lines.push(`**Key terms:** ${kw.map((k) => `\`${k}\``).join(", ")}`, "");
  chunk(source, 1500).forEach((c, i) => {
    lines.push(`## ${i + 1}. ${topKeywords(c, 3).map(cap).join(" · ") || `Part ${i + 1}`}`, "");
    (topSentences(c, 2).length ? topSentences(c, 2) : [c.slice(0, 200)]).forEach((t) => lines.push(`- ${t}`));
    lines.push("");
  });
  const text = lines.join("\n");
  onPartial(text);
  return text;
}

/* ------------------------------------------------------------------ */
/* Flashcards                                                           */
/* ------------------------------------------------------------------ */

const DEF = /^([A-Za-z][\w\- ]{2,40}?)\s+(?:is|are|refers to|means|is defined as)\s+(.{15,})$/;
/** Words that mean the "term" is really a clause or conversational filler, not a concept name. */
const NOT_TERM = new Set("that which this there it we i you they he she what so but and or because if when then also not let here quick okay alright remember today next now just really together these those formally geometrically thus hence therefore however similarly".split(" "));
const looksLikeTerm = (t: string) => {
  const w = t.toLowerCase().split(/\s+/);
  return w.length <= 4 && !w.some((x) => NOT_TERM.has(x) || /ly$/.test(x));
};
const looksLikeDefinition = (d: string) => !/^(where|when|why|because|how|if|that|which)\b/i.test(d.trim());

export async function genCards(s: Settings, source: string, o: Opt = {}): Promise<Card[]> {
  if (hasLLM(s)) {
    const parts = segments(source, 12000).slice(0, 3);
    const words = wordCount(source);
    // About one card per 25 words of notes, never fewer than 6 or more than 30 in total.
    const total = Math.max(6, Math.min(30, Math.round(words / 25)));
    const perPart = Math.max(4, Math.ceil(total / parts.length));
    const all: { front: string; back: string }[] = [];
    let failure: unknown;
    for (const p of parts) {
      let j: { cards: { front: string; back: string }[] } | null = null;
      try {
        j = await json<{ cards: { front: string; back: string }[] }>(
        s,
        "fast",
        `You write spaced-repetition flashcards from a student's own study notes. Make at most ${perPart} cards, fewer if the notes do not support that many. Quality beats quantity.

A good card:
- tests ONE idea that a student must actually know: a definition, a law or formula, a cause and effect, a distinction between two things, or why/how something works;
- has a front that is a specific question or prompt a student could answer from memory, and that makes sense on its own (never "this", "the above", "the passage", or "according to the notes");
- has a back of 1-2 short sentences or a formula, under 25 words, that fully answers the front;
- uses LaTeX ($...$) for any math.

Do NOT make cards for: the document's title, headings, structure or "key takeaways" as such; trivia, dates, names or numbers unless the notes stress them; vague prompts like "Explain X" or "Describe the topic"; anything the notes do not state; or two cards that test the same fact in different words.

Return only JSON: {"cards":[{"front":string,"back":string}]}.${guide(s, o.subject, "cards")}`,
        p,
        o,
        );
      } catch (e) {
        if (o.signal?.aborted) throw e;
        failure = e; // keep the cards from the parts that did work
      }
      if (j?.cards) all.push(...j.cards.filter((c) => c?.front && c?.back && c.front.trim().length > 8));
    }
    // A thin reply (say 1 card from 180 words of notes) is a model hiccup: ask once more before accepting it.
    if (all.length < Math.min(4, total) && !o.signal?.aborted) {
      try {
        const again = await json<{ cards: { front: string; back: string }[] }>(s, "fast", `Write flashcards from the notes: ${Math.min(total, 10)} cards, each testing one important idea, front is a specific question, back under 25 words. Return only JSON: {"cards":[{"front":string,"back":string}]}.${guide(s, o.subject, "cards")}`, parts[0], o);
        if (again?.cards) all.push(...again.cards.filter((c) => c?.front && c?.back && c.front.trim().length > 8));
      } catch (e) {
        if (o.signal?.aborted) throw e;
        failure ??= e;
      }
    }
    if (!all.length && failure) throw failure;
    if (all.length) return dedupeBy(all, (c) => c.front).slice(0, total + 4).map((c) => newCard(uid(), c.front.trim(), c.back.trim()));
    throw new LLMError("The model didn't write any usable flashcards from these notes. Try again, or pick a different model in Settings.");
  }

  const cards: Card[] = [];
  const seen = new Set<string>();
  for (const sent of sentences(source)) {
    const m = sent.match(DEF);
    if (m && looksLikeTerm(m[1]) && looksLikeDefinition(m[2]) && !seen.has(m[1].toLowerCase())) {
      seen.add(m[1].toLowerCase());
      cards.push(newCard(uid(), `What ${/\bare\b/.test(sent) ? "are" : "is"} ${m[1].trim().replace(/^(A|An|The)\s/, (a) => a.toLowerCase())}?`, m[2].replace(/[.]$/, "")));
    }
  }
  if (cards.length < 12) {
    const kw = topKeywords(source, 30);
    const used = new Map<string, number>();
    for (const sent of topSentences(source, 30)) {
      // blank out the least-used keyword in the sentence so cloze cards test different terms
      const present = kw.filter((k) => !k.includes("'") && new RegExp(`\\b${k}\\b`, "i").test(sent) && (used.get(k) ?? 0) < 2);
      const term = present.sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0) || b.length - a.length)[0];
      if (term && cards.length < 20) {
        used.set(term, (used.get(term) ?? 0) + 1);
        cards.push(newCard(uid(), mask(sent, term), term));
      }
    }
  }
  return cards;
}

/* ------------------------------------------------------------------ */
/* Quiz                                                                 */
/* ------------------------------------------------------------------ */

export async function genQuiz(s: Settings, source: string, count = 10, avoid: string[] = [], o: Opt = {}): Promise<QuizQ[]> {
  if (hasLLM(s)) {
    const text = segments(source, 12000)[0];
    // Short notes cannot support a long quiz: about one question per 40 words, between 4 and `count`.
    const n = Math.max(4, Math.min(count, Math.round(wordCount(text) / 40)));
    const attempt = async (): Promise<QuizQ[]> => {
    const j = await json<{ questions: any[] }>(
      s,
      "fast",
      `You write a short practice quiz from a student's own study notes. Write at most ${n} questions, fewer if the notes do not support that many. Every question must be answerable from the notes alone and must test understanding of an important idea, not trivia, wording or the document's structure.

Mix: about half multiple choice ("mc"), a quarter fill-in-the-blank ("cloze"), a quarter short open-ended ("open").

Rules:
- Multiple choice: exactly 4 options and exactly one correct. The 3 wrong options must be plausible mistakes of the same kind as the right answer (for example other laws when asking about a law), never jokes or obviously absurd. Do not use "all of the above" or "none of the above". Vary which position is correct. "explanation" is one sentence on why the answer is right.
- Cloze: one sentence with a single blank written as ______ where the missing word or short phrase is a key term. The sentence must make the answer unambiguous without being given away.
- Open: a question that needs a 1-3 sentence answer, with "reference" holding a model answer taken from the notes.
- Questions must not repeat each other or test the same fact twice, and must make sense on their own (never "according to the notes").${avoid.length ? ` Do not repeat or rephrase these existing questions: ${avoid.slice(-30).join(" | ")}.` : ""}

Return only JSON: {"questions":[{"kind":"mc","q":string,"options":[4 strings],"answer":0-3,"explanation":string},{"kind":"cloze","q":string,"answer":string},{"kind":"open","q":string,"reference":string}]}.${guide(s, o.subject, "quiz")}`,
      text,
      o,
    );
    return (j?.questions ?? [])
      .filter((q) => q?.q && ["mc", "cloze", "open"].includes(q.kind))
      .filter((q) => q.kind !== "mc" || (Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4))
      .map((q) => ({ ...q, id: uid() }) as QuizQ);
    };
    const qs = await attempt();
    if (qs.length >= Math.min(3, n)) return dedupeBy(qs, (q) => q.q);
    if (qs.length) {
      // Too few: one more attempt, then keep whichever set is larger.
      try {
        const retry = await attempt();
        if (retry.length > qs.length) return dedupeBy(retry, (q) => q.q);
      } catch (e) {
        if (o.signal?.aborted) throw e;
      }
      return dedupeBy(qs, (q) => q.q);
    }
    throw new LLMError("The model didn't write any usable quiz questions from these notes. Try again, or pick a different model in Settings.");
  }

  const kw = topKeywords(source, 40);
  const out: QuizQ[] = [];
  topSentences(source, Math.max(15, count * 2)).forEach((sent, i) => {
    const term = kw.find((k) => new RegExp(`\\b${k}\\b`, "i").test(sent));
    if (!term || avoid.includes(sent)) return;
    const kind = i % 3;
    if (kind === 0) {
      const distract = shuffle(kw.filter((k) => k !== term && Math.abs(k.length - term.length) < 5)).slice(0, 3);
      if (distract.length < 3) return;
      const options = shuffle([term, ...distract]);
      out.push({ id: uid(), kind: "mc", q: mask(sent, term), options, answer: options.indexOf(term), explanation: `From the source: "${sent}"` });
    } else if (kind === 1) out.push({ id: uid(), kind: "cloze", q: mask(sent, term), answer: term });
    else out.push({ id: uid(), kind: "open", q: `Explain in your own words: "${sent.slice(0, 140)}${sent.length > 140 ? "…" : ""}"`, reference: sent });
  });
  return out.slice(0, count);
}

export async function gradeOpen(s: Settings, q: string, reference: string, answer: string, o: Opt = {}) {
  if (hasLLM(s)) {
    try {
      const j = await json<{ score: number; feedback: string }>(
        s,
        "fast",
        'Grade a student\'s free-response answer against the reference answer. Be fair: reward correct ideas even if worded differently. Schema: {"score":0..1,"feedback":"1-2 sentences: what was right, what was missing"}.',
        `Question: ${q}\nReference: ${reference}\nStudent answer: ${answer}`,
        o,
      );
      if (j && typeof j.score === "number") return { ...j, score: Math.max(0, Math.min(1, j.score)) };
    } catch (e) {
      if (o.signal?.aborted) throw e;
      // Don't fail a quiz because the grader hiccuped: use the simple checker and say so.
      const g = gradeOffline(reference, answer);
      return { ...g, feedback: `${g.feedback} (The AI grader didn't answer, so this used a simple word-match check.)` };
    }
  }
  return gradeOffline(reference, answer);
}

function gradeOffline(reference: string, answer: string) {
  const ref = new Set(contentWords(reference));
  const got = new Set(contentWords(answer));
  let hit = 0;
  ref.forEach((w) => got.has(w) && hit++);
  const score = ref.size ? Math.min(1, (hit / ref.size) * 1.6) : 0;
  return { score, feedback: score > 0.6 ? "Good: you covered the key ideas." : `Partial. Reference answer: ${reference}` };
}

/* ------------------------------------------------------------------ */
/* Podcast                                                              */
/* ------------------------------------------------------------------ */

export async function genPodcast(s: Settings, title: string, notes: string, o: Opt = {}): Promise<PodcastLine[]> {
  const j = await json<{ lines: PodcastLine[] }>(
    s,
    "smart",
    `Write a natural, engaging two-host educational podcast about the notes. Hosts: "Goo" (curious, asks the questions students would ask, reacts, uses everyday analogies) and "Turbo" (the knowledgeable one, explains clearly with examples). Open with a hook, move through the key ideas in order with real back-and-forth (interruptions, "wait, so...", rhetorical questions), and end with a quick recap. Be accurate: only teach what is in the notes. 24-40 lines, each 1-3 sentences, plain spoken English (no markdown, no LaTeX symbols: say math aloud).${ttsSupportsTags(s) ? " The voices can perform sound tags: where it feels natural (at most one line in five), put [laugh], [chuckle] or [sigh] inside a line, e.g. \"Wait, really? [chuckle] That's wild.\"" : ""} Schema: {"lines":[{"host":"Goo"|"Turbo","text":string}]}.`,
    `Title: ${title}\n\nNotes:\n${clip(notes, 14000)}`,
    o,
  );
  const lines = j?.lines?.filter((l) => l?.text && (l.host === "Goo" || l.host === "Turbo"));
  if (lines?.length) return lines;

  const pts = topSentences(notes.replace(/[#>*`\-|]/g, " ").replace(/\$/g, ""), 10);
  const out: PodcastLine[] = [
    { host: "Goo", text: `Welcome to TurboGoo! Today we're unpacking: ${title}.` },
    { host: "Turbo", text: "Let's dive in. What's the big idea to hold on to first?" },
  ];
  pts.forEach((p, i) => {
    out.push({ host: "Turbo", text: i === 0 ? p : `${["Next up,", "Here's another key point:", "Importantly,"][i % 3]} ${p}` });
    out.push({ host: "Goo", text: ["Interesting! Why does that matter?", "So how would you remember that?", "Can you give a quick example?", "Right, that connects to what we said earlier."][i % 4] });
  });
  out.push({ host: "Turbo", text: "That's the recap. Quiz yourself with the flashcards to lock it in!" });
  return out;
}

/* ------------------------------------------------------------------ */
/* Learn Mode: a real course. An outline first, then one call per      */
/* lesson (generate.ts runs those, two at a time).                      */
/* ------------------------------------------------------------------ */

export type CourseOutline = { info: CourseInfo; sections: Section[] };
/** Everything a lesson prompt needs: the course so far, which lesson this is, and the source (empty for a bare topic). */
export type LessonCtx = { title: string; info?: CourseInfo; sections: Section[]; index: number; material: string };
export type LessonParts = Pick<Section, "lesson" | "example" | "practice" | "recap">;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const strs = (x: unknown, max: number): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()).slice(0, max) : []);

/** Lessons in a course: from the amount of source (about one per 600 words, 5-10); a bare topic gets 8 unless the model chooses 6-10. */
export function lessonCount(material: string): number {
  const w = wordCount(material);
  return w > 0 ? clamp(Math.round(w / 600), 5, 10) : 8;
}

/** A long source cut into four evenly spread slices, so the outline sees the whole arc without sending everything. */
function sampleSource(m: string, max = 14000): string {
  if (m.length <= max) return m;
  const k = 4;
  const part = Math.floor(max / k);
  const step = (m.length - part) / (k - 1);
  return Array.from({ length: k }, (_, i) => m.slice(Math.round(i * step), Math.round(i * step) + part)).join("\n[...]\n");
}

const isCbse = (s: Settings) => (s.curriculum ?? "cbse10") === "cbse10";

/* ---------------- subject-specific lesson instructions ---------------- */

/**
 * How to teach and test each subject in a course lesson. Separate from subjects.ts (which shapes notes, cards and quizzes):
 * these say what a good lesson, worked example and practice set look like in that subject. "cbse" is added when the
 * student's study focus is CBSE Class 10.
 */
const COURSE_GUIDE: Record<Subject, { base: string; cbse: string }> = {
  maths: {
    base: "Subject: Mathematics. Build each idea from a concrete case before the general rule. Give every formula in LaTeX, say when it applies and what each symbol means. The worked example shows every algebraic step with its reason. Practice problems are numerical or algebraic and the answer shows all working and ends with a line starting \"Hence,\". Name the usual slip (a sign, a unit, a forgotten condition).",
    cbse: "CBSE Class 10 Maths: use NCERT terms and notation (zeroes, discriminant, common difference, and so on) and the NCERT method for the chapter. Write the worked example and every solution as a board answer: Given, To find (or To prove), Solution, Hence. Q1 is a 2-mark problem, Q2 a 3-mark problem, Q3 a 4-mark problem, and a step-wise solution where each key step earns a mark. Use a proof or a real-life case-based item when the topic suits one.",
  },
  science: {
    base: "Subject: Science (Physics, Chemistry or Biology). Start from the phenomenon the student can picture, then give the law or definition, then the reason it happens. Give laws with the formula, the meaning of each symbol and the SI unit. Write every chemical equation balanced. Describe a diagram in words by listing its labelled parts in order, and write a biological process as ordered steps. The worked example is a numerical with units (Physics, Chemistry) or a reasoned explanation (Biology). Practice mixes a numerical, a \"give reason\" and a \"what happens when\" question.",
    cbse: "CBSE Class 10 Science: use NCERT Class 10 wording and the standard terms examiners look for. Board answers state the term or law, then the reason, then the formula with unit or the balanced equation. A numerical is written as Given, Formula, Substitution, Answer with unit. Q1 is a 1-2 mark question, Q2 a 3-mark question, Q3 a 3-5 mark question or a short case-based item.",
  },
  sst: {
    base: "Subject: Social Science (History, Geography, Political Science, Economics). History: cause, then event, then effect, with dates, people and places exactly as the source gives them. Geography: types, features, factors and named examples with where they are found. Political Science and Economics: definition, features, significance, and a real example. The worked example is a model answer to a typical question, laid out in points. Practice questions are \"explain\", \"describe\" and \"why\" questions answered in points. Never guess a date, name or figure; say when you are unsure.",
    cbse: "CBSE Class 10 Social Science: follow the NCERT chapter (India and the Contemporary World II, Contemporary India II, Democratic Politics II, Understanding Economic Development) and keep textbook definitions close to the original wording. Board answers are point-wise and keyword-rich: a 3-mark answer has 3 points and a 5-mark answer has 5 points (about 100 words). Q1 is a 2-mark question, Q2 a 3-mark question, Q3 a 5-mark question. Where the lesson has a usable passage, make one question source-based. For places, ask the student to locate and describe them in words (no drawing).",
  },
  english: {
    base: "Subject: English. Literature: the central idea, a summary in order, characters (one trait plus the detail that shows it), tone, and each literary device with a short exact quote. Quote only words that appear in the source passages. If no passage is given, do not quote: describe instead. Language: the rule, one correct and one incorrect example, then the format. The worked example is a model answer (to an extract-based question or a short writing task). Practice is an extract or inference question, a grammar or vocabulary task, and a short writing task.",
    cbse: "CBSE Class 10 English (Language and Literature: First Flight, Footprints Without Feet, grammar and writing): answer literature questions in full sentences with textual evidence. Writing follows the board formats (formal letter, analytical paragraph, notice) with the parts in order. Grammar covers tenses, modals, subject-verb agreement, reported speech, editing and omission. Q1 is a 2-mark short answer (about 40 words), Q2 a 3-mark answer, Q3 a 5-mark writing or long-answer task (about 100-120 words).",
  },
  hindi: {
    base: "Subject: Hindi. Write the lesson, the worked example, the questions and the answers in simple standard Hindi in Devanagari. Keep the four headings (## Lesson, ## Worked example, ## Practice, ## Recap), the Q1/Q2/Q3 headings and the labels **Hint:** and **Answer:** in English exactly as given, because they are parsed. For literature give पाठ/कविता का सार, मुख्य भाव and कठिन शब्दों के अर्थ, quoting lines exactly as in the source. For grammar give the rule, an example and an exception.",
    cbse: "CBSE Class 10 Hindi (क्षितिज, कृतिका, स्पर्श, संचयन and व्याकरण): board-style questions such as अपठित गद्यांश, पाठ-आधारित प्रश्न and व्याकरण (मुहावरे, समास, अलंकार, वाच्य, पदबंध). Q1 is a 2-mark question, Q2 a 3-mark question, Q3 a 5-mark question, answered in short, point-wise Hindi.",
  },
  cs: {
    base: "Subject: Information Technology / Computer Applications. For each idea give the definition, how it works in ordered steps, the syntax, formula or command with one minimal working example in a code block, and the common error. Keep code exact. The worked example is one complete task done step by step with the exact result. Practice asks the student to write a formula, tag or query, to predict an output, or to list the steps of a task.",
    cbse: "CBSE Class 10 IT / Computer Applications: stay inside the syllabus scope (spreadsheets, databases and SQL basics, HTML and web basics, cyber safety, digital documentation) and use its terms. Q1 is a 1-2 mark question, Q2 a 3-mark question, Q3 a practical-style task worth 3-4 marks.",
  },
  general: {
    base: "Teach the subject clearly with concrete examples. Practice problems make the student apply the ideas, not recall a sentence.",
    cbse: "",
  },
};

const BOARD_STYLE =
  "BOARD STYLE (CBSE Class 10): the practice problems are board-style. Put the marks in brackets at the end of each question, for example \"(2 marks)\", \"(3 marks)\". Write every answer the way a board answer is written, so the steps or points match the marks. The worked example is also written as a model board answer.";

function courseGuide(s: Settings, subject: Subject): string {
  const g = COURSE_GUIDE[subject] ?? COURSE_GUIDE.general;
  const cbse = isCbse(s);
  const parts = [g.base, cbse ? g.cbse : "", cbse ? BOARD_STYLE : ""].filter(Boolean);
  return parts.length ? `\n\nSUBJECT RULES FOR LESSONS:\n${parts.join("\n")}` : "";
}

/* ---------------- stage 1: the outline ---------------- */

/**
 * Models that think before they answer (Nemotron, DeepSeek, o-series...) can spend thousands of tokens reasoning, and a
 * token cap sized for the answer alone then cuts them off before they write anything. When that happens we remember it
 * for that model and give every later call extra room.
 */
const thinkExtra = new Map<string, number>();
const thinkKey = (s: Settings, tier: "fast" | "smart") => `${s.baseUrl}|${modelFor(s, tier)}`;

/**
 * A JSON reply read from a stream (so it can be cancelled, and is not subject to the 90 s limit on non-streaming calls
 * that slow reasoning models run into). `answerTokens` is the room for the JSON itself; thinking room is added on top.
 */
async function streamJSON<T>(s: Settings, tier: "fast" | "smart", system: string, user: string, answerTokens: number, o: Opt & { onThinking?: () => void }): Promise<T | null> {
  const key = thinkKey(s, tier);
  for (let i = 0; i < 2; i++) {
    let thought = 0;
    const text = await stream(
      s,
      tier,
      [{ role: "system", content: system + "\nRespond with a single valid JSON object only. No prose." }, { role: "user", content: user }],
      () => {},
      { signal: o.signal, temperature: 0.3, onThinking: (n) => ((thought = n), o.onThinking?.()), maxTokens: answerTokens + 6000 + (thinkExtra.get(key) ?? 0) },
    );
    if (o.signal?.aborted) throw new Error("Cancelled.");
    const j = parseJSON<T>(text);
    if (j) return j;
    if (thought > 0) thinkExtra.set(key, 8000); // thinking ate the budget: allow more next time
  }
  return null;
}

type RawOutline = { title?: unknown; summary?: unknown; outcomes?: unknown; lessons?: { module?: unknown; title?: unknown; objectives?: unknown; minutes?: unknown }[] };

const outlineSystem = (count: string, hasSource: boolean, s: Settings) => `You are a course designer. Plan a short course a student can learn a topic from, in teaching order, from what they already know to the harder ideas.

Return JSON only: {"title":string,"summary":string,"outcomes":[string],"lessons":[{"module":string,"title":string,"objectives":[string],"minutes":number}]}

- "summary": one paragraph of 2-3 plain sentences: what the course covers and why it is worth learning.
- "outcomes": 3-6 items, each starting with a verb (Solve, Explain, Compare...): what the student can do at the end.
- "lessons": ${count}, in teaching order, each building on the earlier ones. Group them into 2-4 modules by giving consecutive lessons the same short "module" name (for example "Foundations"). Each lesson has a specific "title" (no "Lesson 1:" prefix), 2-4 "objectives" (short phrases starting with a verb) and "minutes" (a whole number from 6 to 20 for reading plus practice).
- Every lesson must teach something the others do not. No padding lessons such as "Introduction" or "Conclusion" unless they carry real content.
- ${hasSource ? "Base the plan strictly on the source material: follow its order and emphasis and add no topic it does not cover." : "No source was given: plan from your own knowledge of the topic and include only well-established content."}${isCbse(s) ? "\n- The student is preparing for CBSE Class 10 (NCERT). Follow the NCERT chapter's order and terms and pitch it at Class 10 level." : ""}`;

export async function genOutline(s: Settings, title: string, material: string, o: Opt & { onThinking?: () => void } = {}): Promise<CourseOutline> {
  const hasSource = material.trim().length > 0;
  if (hasLLM(s)) {
    const n = lessonCount(material);
    const count = hasSource ? `exactly ${n} lessons` : "between 6 and 10 lessons (choose the number the topic needs)";
    const j = await streamJSON<RawOutline>(s, "fast", outlineSystem(count, hasSource, s), `Topic: ${title}${hasSource ? `\n\nSource material:\n${sampleSource(material)}` : ""}`, 2500, o);
    const out = outlineFrom(j);
    if (out) return out;
    if (!hasSource) throw new Error("The AI couldn't plan this course (its reply wasn't a usable outline). Try again, or pick a different model in Settings.");
    // A source exists: fall through to the offline outline instead of failing.
  }
  if (!hasSource) throw new Error("Add an API key in Settings so TurboGoo can research this topic, or build the course from a file or pasted text.");
  return offlineOutline(title, material);
}

function outlineFrom(j: RawOutline | null): CourseOutline | null {
  const raw = Array.isArray(j?.lessons) ? j!.lessons : [];
  let module = "Lessons";
  const sections: Section[] = [];
  for (const l of raw.slice(0, 10)) {
    if (typeof l?.title !== "string" || !l.title.trim()) continue;
    if (typeof l.module === "string" && l.module.trim()) module = l.module.trim();
    sections.push({
      id: uid(),
      title: l.title.trim().replace(/^lesson\s*\d+\s*[:.\-–]\s*/i, ""),
      lesson: "",
      done: false,
      status: "pending",
      module,
      objectives: strs(l.objectives, 4),
      minutes: typeof l.minutes === "number" && Number.isFinite(l.minutes) ? clamp(Math.round(l.minutes), 5, 25) : 10,
    });
  }
  if (sections.length < 3) return null;
  const outcomes = strs(j!.outcomes, 6);
  return {
    sections,
    info: { summary: typeof j!.summary === "string" ? j!.summary.trim() : "", outcomes: outcomes.length ? outcomes : sections.slice(0, 4).map((x) => x.title) },
  };
}

/** Sentences cut into n consecutive groups. The offline lesson writer recomputes the same groups from the lesson count. */
function groupOf(sents: string[], index: number, n: number): string[] {
  const per = Math.max(1, Math.ceil(sents.length / n));
  const g = sents.slice(index * per, index * per + per);
  return g.length ? g : sents.slice(-1);
}

function offlineOutline(title: string, material: string): CourseOutline {
  const sents = sentences(material);
  const want = Math.max(1, Math.min(lessonCount(material), sents.length || 1));
  const per = Math.max(1, Math.ceil(sents.length / want));
  const n = Math.max(1, Math.ceil(sents.length / per));
  const sections: Section[] = Array.from({ length: n }, (_, i) => {
    const g = groupOf(sents, i, n);
    const text = g.join(" ");
    const kw = topKeywords(text, 3);
    const name = kw.slice(0, 2).map(cap).join(" & ") || `Part ${i + 1}`;
    return {
      id: uid(),
      title: i === 0 ? `Introduction: ${name}` : name,
      lesson: "",
      done: false,
      status: "pending" as const,
      module: n < 4 ? "Lessons" : i < n / 3 ? "Foundations" : i < (2 * n) / 3 ? "Core ideas" : "Going further",
      objectives: [kw[0] ? `Explain ${kw[0]} in your own words` : "", kw[1] ? `Say how ${kw[1]} connects to ${kw[0]}` : ""].filter(Boolean),
      minutes: clamp(Math.round(wordCount(text) / 120) + 4, 4, 15),
    };
  });
  return {
    sections,
    info: {
      summary: topSentences(material, 2).join(" ") || `A guided course on ${title}.`,
      outcomes: sections.slice(0, 5).map((s) => `Explain ${s.title.replace(/^Introduction:\s*/, "").toLowerCase()} in your own words`),
    },
  };
}

/* ---------------- stage 2: one lesson per call ---------------- */

const lessonSystem = (s: Settings, hasSource: boolean) => `You are an expert teacher writing ONE lesson of a course. Teach, do not summarise. Use clear, warm, direct language, like a good teacher explaining at a board.

OUTPUT: Markdown with exactly these four headings, in this order, spelled exactly like this (in English, whatever the language of the lesson):
## Lesson
## Worked example
## Practice
## Recap
Write nothing before "## Lesson" and nothing after the Recap. All four headings are required: the reply is not finished until the Recap is written.

## Lesson (350-600 words)
- Start from what the student already knows (earlier lessons or everyday experience) and build up to the new idea. Do not open with a block of definitions.
- Explain the idea, and put each key term in **bold** where it is first defined.
- Use 2-4 "###" sub-headings. Write formulas in LaTeX: $...$ inline, $$...$$ on their own lines for display.
- Use one analogy or everyday example if it makes the idea easier, and name the mistake students most often make.
- Cover every learning objective of this lesson. Do not teach what belongs to other lessons; a short reference such as "as in the lesson on X" is enough.

## Worked example (100-250 words)
One complete example, solved in numbered steps. Say why each step is taken and state the final answer clearly. Use a different example from the one in the Lesson.

## Practice
Exactly 3 problems, easy to harder, in exactly this layout:
### Q1
The question.
**Hint:** one or two sentences that nudge without giving the answer away.
**Answer:** the full worked solution and the final answer, in 3-8 lines.
### Q2
(same layout)
### Q3
(same layout)
These are open problems the student answers in their own words or working. No multiple choice and no options. Each must be answerable from this lesson.

## Recap
4-5 bullets, one sentence each: the ideas to remember.

RULES
- Keep to these lengths. No padding, no repetition, no emojis, no opening or closing remarks, and no announcements like "In this lesson we will".
- Be accurate. ${hasSource ? "Teach from the SOURCE PASSAGES given: they are the authority. The outline is only there to place this lesson. If the passages leave a gap the objectives need, fill it with well-established general knowledge and keep it brief." : "There is no source material, so teach from your own knowledge. If you are not sure of a fact, number, date or formula, say so plainly in the text instead of inventing it."}`;

let chunkMemo: { src: string; chunks: string[] } | null = null;
const chunksOf = (src: string) => (chunkMemo?.src === src ? chunkMemo.chunks : (chunkMemo = { src, chunks: chunk(src, 700) }).chunks);

/** The few passages of the source that matter for this lesson (BM25 on its title and objectives), in source order. */
export function lessonPassages(ctx: LessonCtx, k = 5): string[] {
  if (!ctx.material.trim()) return [];
  const sec = ctx.sections[ctx.index];
  const pool = chunksOf(ctx.material);
  let hits = retrieve(`${sec.title} ${(sec.objectives ?? []).join(" ")}`, pool, k);
  if (hits.length < 2) {
    // Nothing matched well: fall back to the stretch of the source where this lesson sits.
    const per = Math.max(1, Math.ceil(pool.length / ctx.sections.length));
    hits = [...hits, ...pool.slice(ctx.index * per, ctx.index * per + per).filter((c) => !hits.includes(c))].slice(0, k);
  }
  return hits.sort((a, b) => pool.indexOf(a) - pool.indexOf(b)).map((c) => (c.length > 900 ? c.slice(0, 900) : c));
}

function lessonUser(ctx: LessonCtx, passages: string[]): string {
  const { sections, index } = ctx;
  const sec = sections[index];
  const prev = sections[index - 1];
  const next = sections[index + 1];
  const outline = sections.map((x, i) => `${i + 1}. ${x.title}${i === index ? "   <- THIS LESSON" : ""}`).join("\n");
  return [
    `Course: ${ctx.title}`,
    ctx.info?.summary ? `About the course: ${ctx.info.summary}` : "",
    `Outline:\n${outline}`,
    `Write lesson ${index + 1} of ${sections.length}: "${sec.title}"${sec.module ? ` (module: ${sec.module})` : ""}.`,
    sec.objectives?.length ? `Learning objectives:\n${sec.objectives.map((x) => `- ${x}`).join("\n")}` : "",
    prev ? `The previous lesson was "${prev.title}": build on it.` : "This is the first lesson: start from what a student already knows.",
    next ? `The next lesson is "${next.title}": do not teach it.` : "This is the last lesson: help the student pull the course together.",
    passages.length ? `SOURCE PASSAGES:\n${passages.map((p, i) => `[${i + 1}] ${p}`).join("\n\n")}` : "There is no source material. Teach from your own knowledge.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ---------------- parsing a lesson reply ---------------- */

const SECTION_HEAD = /^\s{0,3}#{1,2}\s*\**\s*(lesson|worked\s+examples?|practice(?:\s+(?:problems|questions))?|recap|summary|key\s+takeaways)\b[^\n]*$/i;
const canonical = (h: string) => (/^lesson/i.test(h) ? "lesson" : /^worked/i.test(h) ? "example" : /^practice/i.test(h) ? "practice" : "recap");
const QUESTION_HEAD = /^\s{0,3}#{2,5}\s*\**\s*(?:Q(?:uestion)?\.?\s*)?(\d+)\s*\**\s*[.):\-–]?\s*(.*)$/i;
const LABEL = /^\s*(?:[-*>]\s+)?\**\s*(hint|answer|solution)\s*\**\s*:\s*\**\s*(.*)$/i;
const MARKS_ONLY = /^\W*\(?\s*\d+\s*marks?\s*\)?\W*$/i;

/** Turns the model's Markdown into lesson fields. Tolerant of heading variants, code fences and missing parts. */
export function parseLesson(raw: string, partial = false): LessonParts {
  let t = raw.replace(/\r/g, "").trim().replace(/^```(?:markdown|md)?[ \t]*\n/i, "").replace(/\n```\s*$/, "");
  if (partial) t = t.replace(/\n#{1,3}[ \t]*\w{0,14}$/, ""); // half-typed heading at the end of a stream
  const parts: Record<string, string[]> = { pre: [] };
  let cur = "pre";
  let fence = false;
  for (const line of t.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence ? line.match(SECTION_HEAD) : null;
    if (m) {
      cur = canonical(m[1]);
      parts[cur] ??= [];
    } else (parts[cur] ??= []).push(line);
  }
  const clean = (a?: string[]) => (a ?? []).join("\n").replace(/\n\s*-{3,}\s*$/, "").trim();
  const lesson = clean(parts.lesson?.length ? parts.lesson : parts.pre);
  const example = clean(parts.example) || undefined;
  const recapLines = (parts.recap ?? []).map((l) => l.trim()).filter(Boolean);
  const bullets = recapLines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ""));
  const recap = (bullets.length ? bullets : recapLines.filter((l) => !/^-{3,}$/.test(l))).slice(0, 6);
  return { lesson, example, practice: parsePractice(parts.practice ?? [], partial), recap: recap.length ? recap : undefined };
}

function parsePractice(lines: string[], partial: boolean): PracticeQ[] | undefined {
  // Split into one block per "### Q1"-style heading; fall back to numbered lines if the model used no headings.
  const blocks: { head: string; body: string[] }[] = [];
  let curBlock: { head: string; body: string[] } | null = null;
  let useHeads = lines.some((l) => QUESTION_HEAD.test(l));
  const NUMBERED = /^\s*\**\s*(?:Q\s*)?\d+\s*\**\s*[.)]\s*\**\s*(.*)$/i;
  if (!useHeads && !lines.some((l) => NUMBERED.test(l))) useHeads = true;
  for (const l of lines) {
    const m = useHeads ? l.match(QUESTION_HEAD) : l.match(NUMBERED);
    if (m) blocks.push((curBlock = { head: useHeads ? m[2] : m[1], body: [] }));
    else if (curBlock) curBlock.body.push(l);
  }
  const out: PracticeQ[] = [];
  for (const b of blocks) {
    const q: string[] = [];
    const hint: string[] = [];
    const ans: string[] = [];
    let mode: "q" | "hint" | "answer" = "q";
    const headTxt = b.head.trim();
    const trailing = headTxt && MARKS_ONLY.test(headTxt) ? headTxt : "";
    if (headTxt && !trailing) q.push(headTxt);
    for (const l of b.body) {
      const m = l.match(LABEL);
      if (m) {
        const kind = m[1].toLowerCase() === "hint" ? "hint" : "answer";
        if (!(mode === "answer" && kind === "answer")) {
          mode = kind;
          (mode === "hint" ? hint : ans).push(m[2]);
          continue;
        }
      }
      (mode === "q" ? q : mode === "hint" ? hint : ans).push(l);
    }
    const question = `${q.join("\n").trim()}${trailing && !/\bmarks?\b/i.test(q.join(" ")) ? ` ${trailing.trim()}` : ""}`.trim();
    const answer = ans.join("\n").trim();
    if (!question || (!answer && !partial)) continue;
    out.push({ q: question, hint: hint.join(" ").trim(), answer });
  }
  return out.length ? out : undefined;
}

const lessonOk = (p: LessonParts) => wordCount(p.lesson) >= 120;

/** Writes one lesson. Streams the reply (so it can be cancelled), retries once if the reply is unusable. */
export async function genLesson(s: Settings, ctx: LessonCtx, o: Opt & { onPartial?: (p: LessonParts) => void; onThinking?: () => void } = {}): Promise<LessonParts> {
  if (!hasLLM(s)) return offlineLesson(ctx);
  const hasSource = ctx.material.trim().length > 0;
  const subject = o.subject ?? detectSubject(ctx.title, ctx.material);
  const messages = [
    { role: "system" as const, content: lessonSystem(s, hasSource) + courseGuide(s, subject) + guide(s, subject, "notes") + "\n\nThe lesson structure and the lengths above take priority over any note-taking style in the guidance." },
    { role: "user" as const, content: lessonUser(ctx, hasSource ? lessonPassages(ctx) : []) },
  ];
  let last: LessonParts = { lesson: "" };
  const key = thinkKey(s, "smart");
  for (let attempt = 0; attempt < 2; attempt++) {
    let shown = 0;
    let thought = 0;
    const text = await stream(
      s,
      "smart",
      messages,
      (t) => {
        if (!o.onPartial || Date.now() - shown < 300) return;
        shown = Date.now();
        o.onPartial(parseLesson(t, true));
      },
      // About 1.6 tokens per word of the longest allowed lesson (~1500 words in all), plus room for models that think first.
      // If an earlier call showed that thinking used up the whole cap, thinkExtra adds more room.
      { signal: o.signal, onThinking: (n) => ((thought = n), o.onThinking?.()), maxTokens: Math.round(1500 * 1.6) + 1500 + (thinkExtra.get(key) ?? 0) },
    );
    if (o.signal?.aborted) throw new Error("Cancelled.");
    last = parseLesson(text);
    if (lessonOk(last) && !last.recap?.length) {
      // Models sometimes stop before the Recap: build one from the lesson's most informative sentences.
      const pts = topSentences(last.lesson.replace(/^#+\s.*$/gm, "").replace(/\*\*/g, ""), 4).map((x) => (x.length > 200 ? x.slice(0, 197) + "…" : x));
      if (pts.length) last = { ...last, recap: pts };
    }
    if (lessonOk(last) && last.practice?.length) return last;
    if (thought > 0 && !lessonOk(last)) thinkExtra.set(key, 8000);
  }
  if (lessonOk(last)) return last; // usable, just missing practice
  throw new Error(
    thinkExtra.has(key) && !last.lesson
      ? "The model used its whole output allowance thinking and wrote nothing. Retry (it now gets more room), or set Reasoning to “low” in Settings."
      : "The model's reply was cut off or not in the expected format. Retry the lesson, or pick a different model in Settings.",
  );
}

function offlineLesson(ctx: LessonCtx): LessonParts {
  const sents = sentences(ctx.material);
  if (!sents.length) return { lesson: chunk(ctx.material, 600)[ctx.index] ?? ctx.material.slice(0, 600) };
  const g = groupOf(sents, ctx.index, ctx.sections.length);
  const kw = topKeywords(g.join(" "), 3);
  const paras: string[] = [];
  for (let i = 0; i < g.length; i += 2) paras.push(g.slice(i, i + 2).join(" "));
  const lesson = `${kw.length ? `This lesson is about ${kw.map((k) => `**${k}**`).join(", ")}.\n\n` : ""}${paras.join("\n\n")}`;
  const prompts = (g.length > 1 ? topSentences(g.join(" "), 2) : g).slice(0, 2);
  const practice: PracticeQ[] = prompts.map((p) => ({
    q: `Explain in your own words: "${p.slice(0, 160)}${p.length > 160 ? "…" : ""}"`,
    hint: kw.length ? `Try to use these key terms: ${kw.join(", ")}.` : "Say it as if you were teaching a friend.",
    answer: p,
  }));
  const recap = (topSentences(g.join(" "), 4).length ? topSentences(g.join(" "), 4) : g.slice(0, 4)).map((x) => (x.length > 200 ? x.slice(0, 197) + "…" : x));
  return { lesson, practice: practice.length ? practice : undefined, recap };
}

/* ------------------------------------------------------------------ */
/* RAG chat (streaming, with citations)                                 */
/* ------------------------------------------------------------------ */

export type ChatResult = { text: string; sources: string[] };

export async function chat(s: Settings, source: string, notes: string, history: ChatMsg[], question: string, onText: (t: string) => void, o: Opt = {}): Promise<ChatResult> {
  const pool = [...chunk(source, 700), ...chunk(notes, 700)];
  const ctx = retrieve(question, pool, 5);
  if (hasLLM(s)) {
    const text = await stream(
      s,
      "smart",
      [
        {
          role: "system",
          content:
            "You are a patient, precise tutor. Answer using ONLY the numbered context passages from the student's own material. Cite passages like [1]. If the context doesn't contain the answer, say so plainly, then offer what general knowledge you can, clearly labelled as outside the material. Be concise; use Markdown and LaTeX ($...$) where helpful." + guide(s, o.subject ?? detectSubject("", `${notes}\n${source}`), "chat"),
        },
        { role: "user", content: `Context:\n${ctx.map((c, i) => `[${i + 1}] ${c}`).join("\n\n") || "(no relevant passages found)"}` },
        ...history.slice(-8).map((m) => ({ role: m.role, content: m.text })),
        { role: "user", content: question },
      ],
      onText,
      o,
    );
    return { text, sources: ctx };
  }
  if (!ctx.length) return { text: "I couldn't find anything about that in this document. Add an API key in Settings for fuller answers.", sources: [] };
  const q = new Set(contentWords(question));
  const best = ctx
    .flatMap((c) => sentences(c))
    .map((x) => ({ x, score: contentWords(x).filter((w) => q.has(w)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((a) => `- ${a.x}`)
    .join("\n");
  const text = `Here's the most relevant part of your material:\n\n${best || ctx[0]}\n\n*Offline mode: add an API key in Settings for real explanations.*`;
  onText(text);
  return { text, sources: ctx };
}

/* ------------------------------------------------------------------ */
/* Standalone chat with any number of attached sources                  */
/* ------------------------------------------------------------------ */

const FULL_CONTEXT = 24000; // below this, send every attached source whole instead of retrieved passages

export async function chatWithSources(s: Settings, atts: Attachment[], history: ChatMsg[], question: string, onText: (t: string) => void, o: Opt = {}): Promise<ChatResult> {
  const total = atts.reduce((n, a) => n + a.text.length, 0);
  let ctx: string[];
  if (!atts.length) ctx = [];
  else if (total <= FULL_CONTEXT) ctx = atts.map((a) => `(${a.name})\n${a.text.trim()}`);
  else {
    const pool = atts.flatMap((a) => chunk(a.text, 800).map((c) => `(${a.name}) ${c}`));
    const recent = history.filter((m) => m.role === "user").slice(-2).map((m) => m.text).join(" ");
    ctx = retrieve(`${question} ${recent}`, pool, 8);
  }

  if (hasLLM(s)) {
    const system = atts.length
      ? `You are a sharp, friendly study partner. The student attached ${atts.length} source${atts.length > 1 ? "s" : ""}: ${atts.map((a) => `"${a.name}"`).join(", ")}. Ground your answers in the numbered context passages and cite them like [1]. When sources disagree, say so and cite both. If the context doesn't cover the question, say that plainly, then answer from general knowledge and label it as such. Be concise; use Markdown and LaTeX ($...$) where helpful.`
      : "You are a sharp, friendly study partner. Explain clearly with concrete examples, check understanding when useful, and be concise. Use Markdown and LaTeX ($...$) where helpful.";
    const subject = o.subject ?? detectSubject(atts.map((a) => a.name).join(" "), `${question}\n${atts.map((a) => a.text.slice(0, 2500)).join("\n")}`);
    const text = await stream(
      s,
      "smart",
      [
        { role: "system", content: system + guide(s, subject, "chat") },
        ...(ctx.length ? [{ role: "user" as const, content: `Context:\n${ctx.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}` }] : []),
        ...history.slice(-10).map((m) => ({ role: m.role, content: m.text })),
        { role: "user", content: question },
      ],
      onText,
      o,
    );
    return { text, sources: ctx.map((c) => (c.length > 600 ? c.slice(0, 600) + "…" : c)) };
  }

  if (!atts.length) {
    const text = "Offline mode can only answer from attached sources. Attach a file, link or document, or add an API key in Settings.";
    onText(text);
    return { text, sources: [] };
  }
  const hits = retrieve(question, atts.flatMap((a) => chunk(a.text, 600).map((c) => `(${a.name}) ${c}`)), 3);
  const text = hits.length
    ? `Closest passages in your sources:\n\n${hits.map((h) => `- ${h}`).join("\n")}\n\n*Offline mode: add an API key in Settings for real explanations.*`
    : "I couldn't find anything about that in the attached sources.";
  onText(text);
  return { text, sources: hits };
}

/* ------------------------------------------------------------------ */
/* Live Assistant: non-destructive margin comments                      */
/* ------------------------------------------------------------------ */

export type Annotation = { text: string; note: string; kind: "gap" | "error" | "tip" };

export async function annotate(s: Settings, notes: string, source: string, o: Opt = {}): Promise<Annotation[]> {
  const j = await json<{ annotations: Annotation[] }>(
    s,
    "fast",
    'You are a writing and study coach reviewing a student\'s notes against their source. NEVER rewrite their text. Return margin comments only: "error" = a claim contradicting or unsupported by the source, "gap" = an important point from the source that is missing or thin, "tip" = a structural/clarity suggestion. "text" must be an exact short snippet copied from the notes (or "" for a gap). Max 8 comments, most important first. Schema: {"annotations":[{"kind":"error"|"gap"|"tip","text":string,"note":string}]}.',
    `Notes:\n${clip(notes, 8000)}\n\nSource:\n${clip(source, 12000)}`,
    o,
  );
  if (j?.annotations) return j.annotations.filter((a) => a?.note);

  const src = new Set(contentWords(source));
  const out: Annotation[] = [];
  for (const line of notes.split("\n")) {
    const plain = line.replace(/^[#>\-*\s]+/, "").trim();
    const cw = contentWords(plain);
    if (cw.length < 5) continue;
    const unsupported = cw.filter((w) => !src.has(w));
    if (unsupported.length / cw.length > 0.5) out.push({ kind: "error", text: plain.slice(0, 100), note: `Not found in your source (${unsupported.slice(0, 4).join(", ")}…). Verify this claim.` });
  }
  const covered = new Set(contentWords(notes));
  const missing = topKeywords(source, 12).filter((k) => !covered.has(k));
  if (missing.length) out.push({ kind: "gap", text: "", note: `Key source terms missing from your notes: ${missing.slice(0, 6).join(", ")}.` });
  return out;
}

/** Quick check that a typed answer matches a stored one (used by cloze). */
export const sameAnswer = (a: string, b: string) => {
  const x = normalizeAnswer(a);
  const y = normalizeAnswer(b);
  return !!x && (x === y || (y.length > 4 && x.includes(y)) || (x.length > 4 && y.includes(x)));
};
