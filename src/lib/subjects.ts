import type { Settings, Subject } from "./types";

/**
 * Subject-specific instructions for the AI prompts, tuned for CBSE Class 10 (NCERT-based).
 * Each subject has a general version (used when Settings → Study focus is "General") and a CBSE version that is
 * added on top. Guidance is about *shape and style* (what a good note, card or question looks like in that subject);
 * length and quality rules live in the main prompts in ai.ts.
 */

type Kind = "notes" | "cards" | "quiz" | "chat";
type Guide = { label: string; short: string; base: Record<Kind, string>; cbse: Record<Kind, string> };

const AR =
  'Include one or two Assertion-Reason items as multiple choice: put "Assertion (A): ..." and "Reason (R): ..." in the question, and use exactly these four options in this order: "Both A and R are true and R is the correct explanation of A", "Both A and R are true but R is not the correct explanation of A", "A is true but R is false", "A is false but R is true".';

export const SUBJECT_GUIDE: Record<Subject, Guide> = {
  maths: {
    label: "Mathematics",
    short: "Maths",
    base: {
      notes:
        "Subject: Mathematics. For each concept give the rule or formula in LaTeX, one line on when to use it, and one tiny worked example showing only the key steps. Keep related formulas together. Add one bullet on the usual slip (sign errors, units, forgetting a condition).",
      cards:
        'Subject: Mathematics. Good cards: a formula ("State the formula for ..."), the condition for a result ("When does a quadratic have real and equal roots?"), a theorem statement, and "what is the first step to ..." prompts. A numeric card gives the final answer plus the one-line method.',
      quiz: "Subject: Mathematics. Mostly short calculation questions with a single numerical or algebraic answer. Wrong options come from typical mistakes (wrong formula, sign slip, forgetting to simplify). Cloze blanks a number, a formula term or a condition.",
      chat: "Subject: Mathematics. Show the working step by step in LaTeX, name the formula or theorem used, state the final answer clearly, and end with a quick check of the result.",
    },
    cbse: {
      notes:
        "Use NCERT Class 10 terminology and notation (for example zeroes of a polynomial, common difference, discriminant). Name results as NCERT does (Euclid's Division Lemma, Fundamental Theorem of Arithmetic, Basic Proportionality Theorem). Write worked steps in board-answer style: Given, To find, Solution, Hence.",
      cards: "Use NCERT Class 10 terminology. Include the standard results students are expected to state or use in board questions.",
      quiz: `Pitch difficulty at CBSE Class 10 board level (1-mark MCQ to 3-mark style problems). ${AR}`,
      chat: "Answer the way a Class 10 CBSE tutor would: NCERT method and notation, and board-style presentation of steps.",
    },
  },
  science: {
    label: "Science",
    short: "Science",
    base: {
      notes:
        "Subject: Science (Physics, Chemistry, Biology). Capture definitions, laws with formula and SI unit, balanced chemical equations, the reason behind each phenomenon (the 'why'), and differences between similar ideas in a compact table. Describe a diagram in words by listing its labelled parts in order. Biology processes are listed as ordered steps.",
      cards:
        'Subject: Science. Good cards: a law or formula with its unit, a definition, a balanced equation ("Write the balanced equation for ..."), a "give reason" prompt, a one-line difference between two things, and the function of a named part.',
      quiz: "Subject: Science. Include reason-based and 'what happens when ...' questions, numericals with units, identify-the-part or process questions, and questions on balanced equations. Wrong options are common misconceptions.",
      chat: "Subject: Science. Explain the idea with its reason, use the correct unit and formula where relevant, and give an everyday example when it helps.",
    },
    cbse: {
      notes:
        "Use NCERT Class 10 wording and the standard terms examiners expect. Give every chemical equation balanced. For physics list the formula, what each symbol means and its unit. Keep 'reason' style points because board answers are marked on them.",
      cards: "Use NCERT Class 10 terms. Prefer facts that board papers ask as definitions, reasons and equations.",
      quiz: `Pitch difficulty at CBSE Class 10 board level (MCQ, very short, short and case-based style). ${AR}`,
      chat: "Answer in NCERT Class 10 style: the key term, the reason, and the unit or equation the examiner would look for.",
    },
  },
  sst: {
    label: "Social Science",
    short: "SST",
    base: {
      notes:
        "Subject: Social Science (History, Geography, Political Science, Economics). History: cause, then event, then effect, with dates, people and places exactly as given. Geography: types, features, factors, examples and where they are found. Political science and economics: definition, features, significance. Never guess a date, name or figure.",
      cards:
        'Subject: Social Science. Good cards: a key term and its definition, who/what/when for an important event, a cause or effect, a classification ("Name the types of ..."), features of something, and place-to-fact pairs.',
      quiz: "Subject: Social Science. MCQs on terms, dates and causes; cause-and-effect and 'why' questions; and a source-based item (a short quoted extract followed by a question) when the notes contain a usable passage. Wrong options come from the same chapter, so they are plausible.",
      chat: "Subject: Social Science. Answer in clear points with the key terms in bold, give dates and examples from the topic, and separate causes from effects.",
    },
    cbse: {
      notes:
        "Follow the NCERT Class 10 chapters and key terms: keep textbook definitions close to the original wording because they are asked as definition questions. For history list the key dates, people and movements; for geography keep the examples and distributions the textbook names; add a 'places to know' bullet when places are mentioned.",
      cards: "Use NCERT Class 10 terms and keep definitions close to the textbook wording.",
      quiz: "Pitch difficulty at CBSE Class 10 board level, including source-based and case-based style items where the notes allow. Test map-linked facts as place-to-fact questions, not as drawing tasks.",
      chat: "Answer the way a Class 10 CBSE Social Science answer is written: point-wise, keyword-rich, with dates and examples from the NCERT chapter.",
    },
  },
  english: {
    label: "English",
    short: "English",
    base: {
      notes:
        "Subject: English (literature and language). For a prose or poetry piece capture the central idea, a summary in order, the characters with one trait and one supporting detail each, the tone, and the literary devices with one short exact quote each. For grammar or writing topics capture the rule, one correct and one incorrect example, and the format. Quote the source exactly; never paraphrase a line and present it as a quote.",
      cards:
        'Subject: English. Good cards: character and trait with evidence, literary device and a quoted example, the theme or message of a piece, the poet\'s or author\'s intention, a word meaning in context, and a grammar rule with an example. Quote exactly.',
      quiz: "Subject: English. Extract-based questions (a short exact quote, then ask for the meaning, the device, the speaker or the tone), vocabulary in context, grammar correction or gap-filling, and short 'why did ... ' questions about the text.",
      chat: "Subject: English. Support points with short exact quotes from the text, name the literary device or grammar rule, and keep the explanation simple.",
    },
    cbse: {
      notes:
        "Follow the CBSE Class 10 English (Language and Literature) approach: the textbook pieces, and writing and grammar tasks such as formal letters, analytical paragraphs, gap filling, editing and sentence reordering. For a writing format list its parts in order.",
      cards: "Fit the CBSE Class 10 English syllabus: lesson and poem facts, and the grammar and writing formats used in the board paper.",
      quiz: "Pitch questions at the CBSE Class 10 board paper style: extract-based literature questions, grammar tasks and short-answer questions.",
      chat: "Answer like a CBSE Class 10 English tutor: point-wise, textual evidence in short quotes, and the board answer format for writing tasks.",
    },
  },
  hindi: {
    label: "Hindi",
    short: "Hindi",
    base: {
      notes:
        "Subject: Hindi. Write in the same language as the source (Hindi in Devanagari). Capture the पाठ/कविता का सार, मुख्य भाव, पात्र या कवि/लेखक का परिचय, कठिन शब्दों के अर्थ, and व्याकरण rules with one example each. Quote lines from the source exactly.",
      cards: "Subject: Hindi. Write cards in Hindi. Good cards: शब्दार्थ, कवि/लेखक और रचना, पात्र और उसकी विशेषता, मुख्य भाव, and a व्याकरण rule with an example.",
      quiz: "Subject: Hindi. Write questions in Hindi: पंक्तियों पर आधारित प्रश्न, शब्दार्थ, मुख्य भाव, and व्याकरण (for example मुहावरे, समास, अलंकार) questions.",
      chat: "Subject: Hindi. Reply in Hindi unless the student writes in English, and support points with short exact lines from the text.",
    },
    cbse: {
      notes: "Follow the CBSE Class 10 Hindi approach: पाठ का सार, मुख्य भाव, शब्दार्थ and board-style short answers.",
      cards: "Fit the CBSE Class 10 Hindi syllabus.",
      quiz: "Pitch questions at CBSE Class 10 Hindi board paper style (अपठित, पाठ-आधारित and व्याकरण).",
      chat: "Answer like a CBSE Class 10 Hindi tutor: short, point-wise, with lines from the text.",
    },
  },
  cs: {
    label: "IT / Computer",
    short: "IT",
    base: {
      notes:
        "Subject: Information Technology / Computer Applications. For each concept give a definition, how it works in ordered steps, the syntax or command with one minimal working example in a code block, and the common error. Keep code exactly as in the source.",
      cards: "Subject: IT / Computer. Good cards: a term and its definition, a command, function or tag and what it does with a tiny example, and 'which tool or step is used to ...' prompts.",
      quiz: "Subject: IT / Computer. Short 'what does this do' or output questions on a code line, formula or tag; MCQs on terms and tools; cloze on syntax.",
      chat: "Subject: IT / Computer. Explain step by step, show a short code or formula example, and mention the common mistake.",
    },
    cbse: {
      notes: "Fit the scope and terminology of the CBSE Class 10 IT / Computer Applications syllabus (for example spreadsheets, databases, HTML and web basics, cyber safety).",
      cards: "Fit the CBSE Class 10 IT / Computer Applications syllabus.",
      quiz: "Pitch questions at CBSE Class 10 board level: MCQs, very short answers and practical-style questions.",
      chat: "Answer like a CBSE Class 10 IT tutor: the term, the steps, and a short example.",
    },
  },
  general: {
    label: "General",
    short: "General",
    base: { notes: "", cards: "", quiz: "", chat: "" },
    cbse: { notes: "", cards: "", quiz: "", chat: "" },
  },
};

export const SUBJECT_LIST = (Object.keys(SUBJECT_GUIDE) as Subject[]).map((id) => ({ id, label: SUBJECT_GUIDE[id].label }));

const CBSE_OVERLAY =
  "The student is preparing for the CBSE Class 10 board exam (NCERT-based). Keep everything at Class 10 level, use NCERT terminology, and prioritise what the board paper asks.";

/** The extra instruction block for a prompt, or "" when there is nothing to add. */
export function guide(s: Settings, subject: Subject | undefined, kind: Kind): string {
  const cbse = (s.curriculum ?? "cbse10") === "cbse10";
  const g = SUBJECT_GUIDE[subject ?? "general"] ?? SUBJECT_GUIDE.general;
  const parts = [cbse ? CBSE_OVERLAY : "", g.base[kind], cbse ? g.cbse[kind] : ""].filter(Boolean);
  return parts.length ? `\n\nSUBJECT GUIDANCE:\n${parts.join("\n")}` : "";
}

/* ---------------- detection ---------------- */

const KEYWORDS: Record<Exclude<Subject, "general">, RegExp[]> = {
  maths: [
    /\b(polynomial|quadratic|discriminant|arithmetic progression|common difference|trigonometr\w*|sin|cos|tan|theorem|euclid|lcm|hcf|real numbers?|irrational|coordinate geometry|mean|median|mode|probability|surface area|volume|sector|tangent|chord|linear equations?|simultaneous|algebra|geometry|similar triangles?|pythagoras)\b/gi,
    /[=±√∑∫]|\bx\^?2\b|\bfind the value\b/gi,
  ],
  science: [
    /\b(acid|base|salt|ph|metal|non-?metal|carbon|reaction|equation|oxidation|reduction|electric\w*|current|resistance|ohm|magnet\w*|lens|mirror|refraction|reflection|photosynthesis|respiration|nutrition|neuron|hormone|heredity|gene|chromosome|reproduction|ecosystem|food chain|cell|atom|molecule|enzyme|physics|chemistry|biology)\b/gi,
  ],
  sst: [
    /\b(nationalism|revolution|empire|colonial\w*|industrialis\w*|constitution|democracy|federalism|parliament|election|sector|gdp|economy|development|globali[sz]ation|resource|agriculture|soil|crop|forest|industry|minerals?|water resources?|trade|movement|treaty|partition|history|geography|civics|political|economics|consumer)\b/gi,
  ],
  english: [
    /\b(poem|poet|stanza|poetry|prose|author|character|theme|metaphor|simile|alliteration|imagery|tone|mood|extract|paragraph|essay|letter|grammar|tense|passive|narration|reported speech|synonym|antonym|first flight|footprints without feet|summary of the)\b/gi,
  ],
  hindi: [/[\u0900-\u097F]{3,}/g],
  cs: [
    /\b(html|tag|spreadsheet|cell reference|formula|database|table|query|record|field|network|internet|cyber|software|hardware|operating system|web browser|worksheet|word processor|email|presentation|code|program)\b/gi,
  ],
};

/** Best guess of the subject from a title and a sample of the text. Returns "general" when nothing stands out. */
export function detectSubject(title: string, text: string): Subject {
  const sample = `${title}\n${title}\n${title}\n${text.slice(0, 6000)}`;
  const scores = (Object.keys(KEYWORDS) as (keyof typeof KEYWORDS)[]).map((id) => {
    let score = 0;
    for (const re of KEYWORDS[id]) score += (sample.match(re) ?? []).length;
    return { id, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const [top, next] = scores;
  // Hindi is decided by script: a lot of Devanagari means Hindi whatever else matched.
  const devanagari = (sample.match(/[\u0900-\u097F]/g) ?? []).length;
  if (devanagari > Math.max(40, sample.length * 0.25)) return "hindi";
  if (top.id === "hindi") return "general";
  if (top.score < 4 || top.score < next.score * 1.3) return top.score >= 8 && top.score >= next.score * 1.15 ? top.id : "general";
  return top.id;
}
