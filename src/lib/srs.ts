import type { Card } from "./types";

export type Grade = 1 | 3 | 4 | 5; // Again, Hard, Good, Easy
const DAY = 864e5;
const MIN = 6e4;

export const newCard = (id: string, front: string, back: string, manual = false): Card => ({
  id,
  front,
  back,
  ease: 2.5,
  interval: 0,
  reps: 0,
  lapses: 0,
  due: 0,
  mastery: 0,
  manual,
});

export const isDue = (c: Card, now = Date.now()) => c.due <= now;

/** SM-2 with a short relearning step on failure. */
export function review(card: Card, q: Grade, now = Date.now()): Card {
  let { ease, interval, reps, lapses } = card;
  let due: number;
  if (q < 3) {
    reps = 0;
    lapses += 1;
    interval = 0;
    due = now + 10 * MIN;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    reps += 1;
    interval = reps === 1 ? (q === 5 ? 3 : 1) : reps === 2 ? (q === 5 ? 8 : 6) : Math.round(interval * ease * (q === 3 ? 0.8 : q === 5 ? 1.3 : 1));
    interval = Math.max(1, interval);
    ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    due = now + interval * DAY;
  }
  const mastery = Math.max(0, Math.min(100, card.mastery + (q === 5 ? 25 : q === 4 ? 18 : q === 3 ? 6 : -30)));
  return { ...card, ease, interval, reps, lapses, due, mastery };
}

/** Human label for the next interval if graded `q` (shown on the grade buttons). */
export function preview(card: Card, q: Grade): string {
  const next = review(card, q, 0);
  if (q < 3) return "10m";
  return next.interval < 30 ? `${next.interval}d` : next.interval < 365 ? `${Math.round(next.interval / 30)}mo` : `${(next.interval / 365).toFixed(1)}y`;
}

export const dueCount = (cards: Card[]) => cards.filter((c) => isDue(c)).length;
