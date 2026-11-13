import { CalendarDays, ChevronRight, Flame, House, Layers, MessagesSquare, Moon, Search, Settings as Cog, Sun, Waves, Zap } from "lucide-react";
import { liveStreak, setSettings, useStore } from "../lib/store";
import { dueCount } from "../lib/srs";
import "../styles/shell.css";

const PILLS = [
  { path: "review", icon: Layers, label: "Review" },
  { path: "chat", icon: MessagesSquare, label: "Chat" },
  { path: "stream", icon: Waves, label: "Stream" },
] as const;

/** The bar across the top of every page: wordmark, breadcrumb on document pages, and the main destinations. */
export function TopBar({ section, docId, onSearch }: { section?: string; docId?: string; onSearch: () => void }) {
  const { docs, meta, settings } = useStore();
  const due = docs.reduce((n, d) => n + dueCount(d.cards), 0);
  const streak = liveStreak(meta);
  const dark = settings.theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : settings.theme === "dark";
  const doc = section === "doc" ? docs.find((d) => d.id === docId) : undefined;
  const onDoc = section === "doc" && !!docId;
  const top = () => window.scrollTo({ top: 0 });

  return (
    <header className={"topbar" + (onDoc ? " on-doc" : "")}>
      <a className="tb-brand" href="#/" onClick={top} aria-label="TurboGoo home">
        <span className="tb-mark" aria-hidden><Zap size={16} fill="currentColor" strokeWidth={1.5} /></span>
        <span className="tb-name">TurboGoo</span>
      </a>
      <a className={"tb-pill tb-plan" + (section === "schedule" ? " on" : "")} href="#/schedule" onClick={top} aria-current={section === "schedule" ? "page" : undefined} title="Study planner: build a schedule and a PDF">
        <CalendarDays size={16} aria-hidden />
        <span className="tb-label">Planner</span>
      </a>

      {onDoc && (
        <nav className="crumbs" aria-label="Breadcrumb">
          <a className="crumb-home" href="#/" onClick={top}><House size={14} aria-hidden /> <span>Home</span></a>
          <ChevronRight size={14} className="crumb-sep" aria-hidden />
          <span className="crumb-here" aria-current="page" title={doc?.title}>{doc?.title ?? "Document"}</span>
        </nav>
      )}

      <div className="tb-right">
        {streak > 0 && (
          <span className="tb-streak" title={`${streak}-day streak. Best: ${meta.streak.best} days`}>
            <Flame size={15} aria-hidden /> <b>{streak}</b><span className="sr-only"> day streak</span>
          </span>
        )}
        <button className="tb-pill tb-search" onClick={onSearch} aria-label="Search (Ctrl K)" title="Search (Ctrl K)">
          <Search size={16} aria-hidden />
          <kbd>Ctrl K</kbd>
        </button>
        {PILLS.map(({ path, icon: Icon, label }) => (
          <a key={path} href={`#/${path}`} onClick={top} className={"tb-pill" + (section === path ? " on" : "")} aria-current={section === path ? "page" : undefined} aria-label={path === "review" && due > 0 ? `${label}, ${due} due` : label} title={label}>
            <Icon size={16} aria-hidden />
            <span className="tb-label">{label}</span>
            {path === "review" && due > 0 && <span className="badge" aria-hidden>{due > 99 ? "99+" : due}</span>}
          </a>
        ))}
        <button className="tb-pill tb-icon" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"} onClick={() => setSettings({ theme: dark ? "light" : "dark" })}>
          {dark ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
        </button>
        <a className={"tb-pill tb-icon" + (section === "settings" ? " on" : "")} href="#/settings" onClick={top} aria-label="Settings" aria-current={section === "settings" ? "page" : undefined} title="Settings">
          <Cog size={17} aria-hidden />
        </a>
      </div>
    </header>
  );
}
