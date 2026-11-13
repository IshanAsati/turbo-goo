export type Card = {
  id: string;
  front: string;
  back: string;
  ease: number; // SM-2 easiness factor
  interval: number; // days
  reps: number;
  lapses: number;
  due: number; // epoch ms
  mastery: number; // 0..100 knowledge score
  manual?: boolean;
};

export type QuizQ =
  | { id: string; kind: "mc"; q: string; options: string[]; answer: number; explanation: string }
  | { id: string; kind: "cloze"; q: string; answer: string }
  | { id: string; kind: "open"; q: string; reference: string };

export type PodcastLine = { host: "Goo" | "Turbo"; text: string };

export type CheckIn = { q: string; options: string[]; answer: number; explain: string };

export type PracticeQ = { q: string; hint: string; answer: string };
export type LessonStatus = "pending" | "writing" | "ready" | "failed";

/**
 * One lesson of a course. Old saved courses only have {id, title, lesson, check, done}; every other field is
 * optional so they still render (a missing status means "ready", and `check` becomes an optional Quick check).
 */
export type Section = {
  id: string;
  title: string;
  lesson: string; // markdown lesson body (the "## Lesson" part)
  check?: CheckIn; // legacy multiple-choice check-in, only on courses made before the rework
  done: boolean;
  module?: string; // group heading in the outline
  objectives?: string[];
  minutes?: number; // estimated reading + practice time
  example?: string; // markdown worked example
  practice?: PracticeQ[];
  recap?: string[];
  status?: LessonStatus;
  error?: string;
};

export type CourseInfo = { summary: string; outcomes: string[] };

export type ChatMsg = { role: "user" | "assistant"; text: string; sources?: string[]; attached?: string[] };

/** A source attached to a prompt: a file, link, pasted text or an existing library document. */
export type Attachment = { id: string; name: string; kind: DocKind | "doc"; text: string; docId?: string; url?: string };

/** A standalone chat conversation (not tied to one document). */
export type Thread = { id: string; title: string; messages: ChatMsg[]; attachments: Attachment[]; createdAt: number; updatedAt: number };

export type DocKind = "blank" | "text" | "file" | "audio" | "youtube" | "topic" | "image";

export type Subject = "maths" | "science" | "sst" | "english" | "hindi" | "cs" | "general";

export type Doc = {
  id: string;
  title: string;
  folderId: string | null;
  kind: DocKind;
  subject?: Subject; // picked by the user, or detected from the content on first generation
  openedAt?: number; // last time the user opened it (drives Jump back in and Opened x ago)
  source: string; // raw text / transcript used for grounding
  sourceUrl?: string;
  hasAudio?: boolean; // audio blob stored under key audio:<id>
  notes: string; // markdown (+ $LaTeX$)
  cards: Card[];
  quiz: QuizQ[];
  quizHistory: { at: number; score: number; total: number }[];
  podcast: PodcastLine[];
  course: Section[];
  courseInfo?: CourseInfo; // summary + "what you will be able to do" for the course landing page
  chat: ChatMsg[];
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type Folder = { id: string; name: string };

export type Settings = {
  baseUrl: string;
  apiKey: string;
  model: string; // "smart" tier: notes, podcast, tutoring, courses
  fastModel: string; // "fast" tier: cards, quizzes, grading, annotations
  reasoning: "auto" | "none" | "low" | "medium" | "high"; // how long reasoning models think first; "auto" = don't send
  curriculum: "cbse10" | "general"; // adds CBSE Class 10 (NCERT) guidance to prompts
  sttBaseUrl: string; // speech-to-text provider; empty = use the AI provider above
  sttApiKey: string;
  sttModel: string;
  ttsBaseUrl: string; // text-to-speech provider for podcasts; empty = use the AI provider above
  ttsApiKey: string;
  ttsModel: string;
  ttsVoiceA: string; // Goo
  ttsVoiceB: string; // Turbo
  theme: "system" | "light" | "dark";
  useHDVoices: boolean;
};

export type Meta = {
  folders: Folder[];
  streak: { lastDay: string; count: number; best: number };
  activity: Record<string, number>; // yyyy-mm-dd -> reviews/questions done
  onboarded: boolean;
};

export type AppState = { docs: Doc[]; threads: Thread[]; meta: Meta; settings: Settings; ready: boolean };

export type Job = { step: string; error?: string; done?: boolean };
