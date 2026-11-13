/** "just now", "5 minutes ago", "yesterday", "2 days ago", "3 weeks ago", or a short date for anything older. */
export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const w = Math.round(d / 7);
  if (d < 30) return w === 1 ? "a week ago" : `${w} weeks ago`;
  const mo = Math.round(d / 30);
  if (d < 330) return mo === 1 ? "a month ago" : `${mo} months ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
