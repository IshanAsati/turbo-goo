/** One-shot message handed from another page (e.g. the Home composer) to the chat page, sent on arrival. */
let pending: { threadId: string; text: string } | null = null;

export const handOff = (threadId: string, text: string) => void (pending = { threadId, text });

export function takeHandOff(threadId: string): string | null {
  if (pending?.threadId !== threadId) return null;
  const t = pending.text;
  pending = null;
  return t;
}
