import { useSyncExternalStore } from "react";

/**
 * publik on the page side. It is optional. The desktop shell (electron/main.ts) decides whether publik is used, keeps the
 * install key, and adds that key to requests. This page only asks the shell, and never sees the key.
 * The browser build has no shell, so publik stays off there.
 */

/** Base URL of publik API. The page sends PUBLIK_KEY_PLACEHOLDER as its key; the shell swaps in the real key, only for requests to this base URL. */
export const PUBLIK_BASE_URL = "https://publikhq.com/api/v1";
export const PUBLIK_KEY_PLACEHOLDER = "publik-managed";

export type PublikStatus = {
  available: boolean; // true only in the desktop app
  mode: "unset" | "signed_in" | "skipped"; // unset: the first-launch choice has not been made yet
  signedIn: boolean; // signed in and connected in this run
  ai: boolean; // the "Use publik API for AI" switch; it applies only while signedIn
};
type Shared = Omit<PublikStatus, "available">;
type Api = {
  status(): Promise<Shared>;
  signIn(): Promise<Shared>;
  setAi(on: boolean): Promise<Shared>;
  turnOff(): Promise<unknown>;
};

const api = (): Api | undefined => (window as unknown as { turbogoo?: { publik?: Api } }).turbogoo?.publik;

let current: PublikStatus = { available: false, mode: "unset", signedIn: false, ai: false };
const listeners = new Set<() => void>();
const setCurrent = (next: PublikStatus) => {
  current = next;
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** True when AI requests should go to publik right now. */
export const publikAiOn = () => current.signedIn && current.ai;

export function usePublik(): PublikStatus {
  return useSyncExternalStore(subscribe, () => current);
}

/** Reads the shell's state once at start-up. Harmless in the browser (nothing happens). */
export async function loadPublik(): Promise<void> {
  const a = api();
  if (!a) return;
  try {
    setCurrent({ ...(await a.status()), available: true });
  } catch {
    setCurrent({ ...current, available: true });
  }
}

/** Runs publik's sign-in in the shell. Resolves when the shell reports back, which can take a few minutes. */
export async function signInPublik(): Promise<void> {
  const a = api();
  if (a) setCurrent({ ...(await a.signIn()), available: true });
}

/** Turns the "Use publik API for AI" switch on or off. Throws if the shell refuses (for example, not signed in). */
export async function setPublikAi(on: boolean): Promise<void> {
  const a = api();
  if (a) setCurrent({ ...(await a.setAi(on)), available: true });
}

/** Signs out of publik. The shell restarts TurboGoo, so this promise may never resolve on the page. */
export async function turnOffPublik(): Promise<void> {
  await api()?.turnOff();
}
