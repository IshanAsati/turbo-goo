import { lazy, Suspense, useEffect, useState } from "react";
import { Compass, Flame, Layers, Library, Search, Settings as Cog, Waves, Zap } from "lucide-react";
import { go, useRoute } from "./lib/nav";
import { liveStreak, useStore } from "./lib/store";
import { dueCount } from "./lib/srs";
import { DialogHost, Toaster } from "./components/feedback";
import { Palette } from "./components/Palette";
import { Home } from "./views/Home";

const DocView = lazy(() => import("./views/DocView").then((m) => ({ default: m.DocView })));
const LearnHome = lazy(() => import("./views/Learn").then((m) => ({ default: m.LearnHome })));
const Stream = lazy(() => import("./views/Stream").then((m) => ({ default: m.Stream })));
const Review = lazy(() => import("./views/Review").then((m) => ({ default: m.Review })));
const SettingsView = lazy(() => import("./views/SettingsView").then((m) => ({ default: m.SettingsView })));

const NAV = [
  { path: "/", icon: Library, label: "Library" },
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

  if (!ready) return <div className="splash"><Zap size={32} /></div>;

  const due = docs.reduce((n, d) => n + dueCount(d.cards), 0);
  let view;
  if (a === "doc" && id) view = <DocView key={id} id={id} initialTab={tabParam ?? undefined} />;
  else if (a === "learn") view = <LearnHome />;
  else if (a === "stream") view = <Stream />;
  else if (a === "review") view = <Review />;
  else if (a === "settings") view = <SettingsView />;
  else view = <Home />;

  const active = "/" + (a === "doc" || !a ? "" : a);
  const streak = liveStreak(meta);
  return (
    <div className="shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => go("/")} aria-label="TurboGoo home">
          <span className="logo"><Zap size={18} fill="currentColor" /></span> TurboGoo
        </button>
        <button className="search-btn" onClick={() => setPalette(true)}>
          <Search size={15} /> Search <kbd>Ctrl K</kbd>
        </button>
        <nav aria-label="Main">
          {NAV.map(({ path, icon: Icon, label }) => (
            <button key={path} className={"nav" + (active === path ? " on" : "")} onClick={() => go(path)} aria-current={active === path ? "page" : undefined}>
              <Icon size={18} /> <span>{label}</span>
              {path === "/review" && due > 0 && <span className="badge">{due}</span>}
            </button>
          ))}
        </nav>
        <div className="streak" title={`Best streak: ${meta.streak.best} days`}>
          <Flame size={18} className={streak ? "hot" : ""} /> <b>{streak}</b> day streak
        </div>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="page muted">Loading…</div>}>{view}</Suspense>
      </main>
      <Palette open={palette} onClose={() => setPalette(false)} />
      <Toaster />
      <DialogHost />
    </div>
  );
}
