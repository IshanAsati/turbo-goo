import { useEffect, useState } from "react";

export const go = (path: string) => {
  window.location.hash = path;
  window.scrollTo({ top: 0 });
};

export function useRoute() {
  const [h, setH] = useState(window.location.hash.slice(1) || "/");
  useEffect(() => {
    const f = () => setH(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return h;
}
