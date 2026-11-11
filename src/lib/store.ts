import { useSyncExternalStore } from "react";
import { del, get, getMany, keys, set } from "idb-keyval";
import type { AppState, Doc, Job, Meta, Settings } from "./types";

const META_KEY = "turbogoo:meta";
const SETTINGS_KEY = "turbogoo:settings";
const DOC_PREFIX = "doc:";

export const defaultSettings: Settings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
  fastModel: "gpt-4o-mini",
  sttModel: "whisper-1",
  ttsModel: "tts-1",
  theme: "system",
  useHDVoices: false,
};

const defaultMeta: Meta = {
  folders: [{ id: "f-general", name: "General" }],
  streak: { lastDay: "", count: 0, best: 0 },
  activity: {},
  onboarded: false,
};

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

let state: AppState = { docs: [], meta: readLS(META_KEY, defaultMeta), settings: readLS(SETTINGS_KEY, defaultSettings), ready: false };
const listeners = new Set<() => void>();
const saved = new Map<string, Doc>(); // last persisted object per doc id (identity check = dirty check)
let timer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  listeners.forEach((l) => l());
}

async function flush() {
  timer = undefined;
  try {
    localStorage.setItem(META_KEY, JSON.stringify(state.meta));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* storage disabled */
  }
  const ids = new Set(state.docs.map((d) => d.id));
  for (const d of state.docs) {
    if (saved.get(d.id) !== d) {
      await set(DOC_PREFIX + d.id, d);
      saved.set(d.id, d);
    }
  }
  for (const id of [...saved.keys()]) {
    if (!ids.has(id)) {
      await del(DOC_PREFIX + id);
      await del("audio:" + id);
      saved.delete(id);
    }
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), 400);
}

/** Persist immediately (used before navigation/unload). */
export const flushNow = () => flush();
if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flush());

export function setState(fn: (s: AppState) => AppState) {
  state = fn(state);
  schedule();
  emit();
}

export async function hydrate() {
  try {
    const ks = (await keys()).filter((k) => typeof k === "string" && k.startsWith(DOC_PREFIX)) as string[];
    const docs = (await getMany<Doc>(ks)).filter((d): d is Doc => !!d).map(normalizeDoc);
    docs.forEach((d) => saved.set(d.id, d));
    docs.sort((a, b) => b.updatedAt - a.updatedAt);
    state = { ...state, docs, ready: true };
  } catch (e) {
    console.error("hydrate failed", e);
    state = { ...state, ready: true };
  }
  applyTheme(state.settings.theme);
  emit();
}

/** Fill in fields added in later versions so old stored docs never crash the UI. */
function normalizeDoc(d: Doc): Doc {
  const defaults = { cards: [], quiz: [], quizHistory: [], podcast: [], course: [], chat: [], notes: "", source: "" };
  return { ...defaults, ...d };
}

export function useStore(): AppState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export const getState = () => state;
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

/* ---------------- docs ---------------- */

export function addDoc(d: Partial<Doc> & { title: string }): Doc {
  const now = Date.now();
  const doc: Doc = {
    id: uid(),
    folderId: "f-general",
    kind: "blank",
    source: "",
    notes: "",
    cards: [],
    quiz: [],
    quizHistory: [],
    podcast: [],
    course: [],
    chat: [],
    createdAt: now,
    updatedAt: now,
    ...d,
  };
  setState((s) => ({ ...s, docs: [doc, ...s.docs] }));
  return doc;
}

export function updateDoc(id: string, patch: Partial<Doc> | ((d: Doc) => Partial<Doc>)) {
  setState((s) => ({
    ...s,
    docs: s.docs.map((d) => (d.id === id ? { ...d, ...(typeof patch === "function" ? patch(d) : patch), updatedAt: Date.now() } : d)),
  }));
}

export function deleteDoc(id: string) {
  setState((s) => ({ ...s, docs: s.docs.filter((d) => d.id !== id) }));
}

export function setSettings(patch: Partial<Settings>) {
  setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  if (patch.theme) applyTheme(patch.theme);
}

export function setMeta(fn: (m: Meta) => Meta) {
  setState((s) => ({ ...s, meta: fn(s.meta) }));
}

export function applyTheme(t: Settings["theme"]) {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/* ---------------- streak + activity ---------------- */

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export { dayKey };

/** Call whenever the user does real study work (reviews a card, answers a question). */
export function recordActivity(n = 1) {
  setMeta((m) => {
    const today = dayKey();
    const yesterday = dayKey(new Date(Date.now() - 864e5));
    let { lastDay, count, best } = m.streak;
    if (lastDay !== today) {
      count = lastDay === yesterday ? count + 1 : 1;
      best = Math.max(best, count);
      lastDay = today;
    }
    return { ...m, streak: { lastDay, count, best }, activity: { ...m.activity, [today]: (m.activity[today] ?? 0) + n } };
  });
}

/** Streak shown to the user: broken if they missed yesterday. */
export function liveStreak(m: Meta) {
  const y = dayKey(new Date(Date.now() - 864e5));
  return m.streak.lastDay === dayKey() || m.streak.lastDay === y ? m.streak.count : 0;
}

/* ---------------- background jobs (generation progress) ---------------- */

const jobs = new Map<string, Job>();
const jobListeners = new Set<() => void>();
export function setJob(id: string, j: Job | null) {
  if (j) jobs.set(id, j);
  else jobs.delete(id);
  snapshot = new Map(jobs);
  jobListeners.forEach((l) => l());
}
let snapshot = new Map<string, Job>();
export function useJob(id: string): Job | undefined {
  return useSyncExternalStore(
    (cb) => {
      jobListeners.add(cb);
      return () => jobListeners.delete(cb);
    },
    () => snapshot.get(id),
  );
}

/* ---------------- binary blobs (lecture audio) ---------------- */

export const saveAudio = (id: string, blob: Blob) => set("audio:" + id, blob);
export const loadAudio = (id: string) => get<Blob>("audio:" + id);
