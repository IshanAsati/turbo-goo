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

export type Section = {
  id: string;
  title: string;
  lesson: string; // markdown micro-lesson
  check: CheckIn;
  done: boolean;
};

export type ChatMsg = { role: "user" | "assistant"; text: string; sources?: string[] };

export type DocKind = "blank" | "text" | "file" | "audio" | "youtube" | "topic" | "image";

export type Doc = {
  id: string;
  title: string;
  folderId: string | null;
  kind: DocKind;
  source: string; // raw text / transcript used for grounding
  sourceUrl?: string;
  hasAudio?: boolean; // audio blob stored under key audio:<id>
  notes: string; // markdown (+ $LaTeX$)
  cards: Card[];
  quiz: QuizQ[];
  quizHistory: { at: number; score: number; total: number }[];
  podcast: PodcastLine[];
  course: Section[];
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
  sttModel: string;
  ttsModel: string;
  theme: "system" | "light" | "dark";
  useHDVoices: boolean;
};

export type Meta = {
  folders: Folder[];
  streak: { lastDay: string; count: number; best: number };
  activity: Record<string, number>; // yyyy-mm-dd -> reviews/questions done
  onboarded: boolean;
};

export type AppState = { docs: Doc[]; meta: Meta; settings: Settings; ready: boolean };

export type Job = { step: string; error?: string; done?: boolean };
