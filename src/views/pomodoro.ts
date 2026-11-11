import { useEffect, useState } from "react";

const FOCUS = 25 * 60;
const BREAK = 5 * 60;

/** 25/5 Pomodoro timer. Uses wall-clock time so it stays accurate when the tab is throttled. */
export function usePomodoro() {
  const [mode, setMode] = useState<"focus" | "break">("focus");
  const [left, setLeft] = useState(FOCUS);
  const [running, setRunning] = useState(false);
  const [endAt, setEndAt] = useState(0);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      const rem = Math.max(0, Math.round((endAt - Date.now()) / 1000));
      setLeft(rem);
      if (rem === 0) {
        const next = mode === "focus" ? "break" : "focus";
        const dur = next === "focus" ? FOCUS : BREAK;
        setMode(next);
        setLeft(dur);
        setEndAt(Date.now() + dur * 1000);
        if ("Notification" in window && Notification.permission === "granted") new Notification(next === "break" ? "Break time" : "Back to focus");
      }
    }, 500);
    return () => clearInterval(t);
  }, [running, endAt, mode]);

  const toggle = () => {
    if (!running) {
      setEndAt(Date.now() + left * 1000);
      if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    }
    setRunning(!running);
  };
  const reset = () => (setRunning(false), setMode("focus"), setLeft(FOCUS));
  const label = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  return { mode, running, label, toggle, reset };
}
