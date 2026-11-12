import { lazy, Suspense, useEffect, useState } from "react";
import { Compass, Layers, Library, MessagesSquare, Moon, Search, Settings as Cog, Sun, Waves } from "lucide-react";
import { go, useRoute } from "./lib/nav";
import { liveStreak, setSettings, useStore } from "./lib/store";
import { dueCount } from "./lib/srs";
import { DialogHost, Toaster } from "./components/feedback";
import { Palette } from "./components/Palette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Home } from "./views/Home";

const DocView = lazy(() => import("./views/DocView").then((m) => ({ default: m.DocView })));
const ChatPage = lazy(() => import("./views/ChatPage").then((m) => ({ default: m.ChatPage })));
const LearnHome = lazy(() => import("./views/Learn").then((m) => ({ default: m.LearnHome })));
const Stream = lazy(() => import("./views/Stream").then((m) => ({ default: m.Stream })));
const Review = lazy(() => import("./views/Review").then((m) => ({ default: m.Review })));
const SettingsView = lazy(() => import("./views/SettingsView").then((m) => ({ default: m.SettingsView })));

const NAV = [
  { path: "/", icon: Library, label: "Library" },
  { path: "/chat", icon: MessagesSquare, label: "Chat" },
  { path: "/review", icon: Layers, label: "Review" },
  { path: "/learn", icon: Compass, label: "Learn" },
  { path: "/stream", icon: Waves, label: "Stream" },
  { path: "/settings", icon: Cog, label: "Settings" },
];

export function App() {
  const route = useRoute();
  const { meta, docs, ready } = useStore();
  const [palette, setPalette] = useState(false);
  const [, a, rest] = route.split("/");
  const [id, query] = (rest ?? "").split("?");
  const tabParam = new URLSearchParams(query ?? "").get("tab");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="splash"><span className="wordmark">TurboGoo</span></div>;

  const due = docs.reduce((n, d) => n + dueCount(d.cards), 0);
  let view;
  if (a === "doc" && id) view = <DocView key={id} id={id} initialTab={tabParam ?? undefined} />;
  else if (a === "chat") view = <ChatPage id={id || undefined} />;
  else if (a === "learn") view = <LearnHome />;
  else if (a === "stream") view = <Stream />;
  else if (a === "review") view = <Review />;
  else if (a === "settings") view = <SettingsView />;
  else view = <Home />;

  const active = "/" + (a === "doc" || !a ? "" : a);
  const streak = liveStreak(meta);
  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  return (
    <div className={"shell" + (a === "chat" ? " full" : "")}>
      <aside className="sidebar">
        <button className="brand" onClick={() => go("/")} aria-label="TurboGoo home">
          <span className="wordmark">Turbo<em>Goo</em></span>
        </button>
        <button className="search-btn" onClick={() => setPalette(true)}>
          <Search size={14} /> <span>Find anything</span> <kbd>Ctrl K</kbd>
        </button>
        <nav aria-label="Main">
          {NAV.map(({ path, icon: Icon, label }, i) => (
            <button key={path} className={"nav" + (active === path ? " on" : "")} onClick={() => go(path)} aria-current={active === path ? "page" : undefined}>
              <span className="nav-n" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
              <Icon size={16} /> <span>{label}</span>
              {path === "/review" && due > 0 && <span className="badge">{due}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className="streak" title={`Best streak: ${meta.streak.best} days`}>
            <b>{streak}</b> day streak
          </span>
          <button className="icon-btn" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setSettings({ theme: dark ? "light" : "dark" })}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="page muted">Loading…</div>}><ErrorBoundary resetKey={`${a}/${id ?? ""}`}>{view}</ErrorBoundary></Suspense>
      </main>
      <Palette open={palette} onClose={() => setPalette(false)} />
      <Toaster />
      <DialogHost />
    </div>
  );
}
