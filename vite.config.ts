import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { getTranscript } from "./server/youtube";

/** Serves /api/youtube in `vite dev` and `vite preview` (production uses api/youtube.ts on Vercel). */
function youtubeApi(): Plugin {
  const handler = async (req: any, res: any, next: () => void) => {
    if (!req.url?.startsWith("/api/youtube")) return next();
    const u = new URL(req.url, "http://localhost");
    res.setHeader("content-type", "application/json");
    try {
      const t = await getTranscript(u.searchParams.get("url") ?? "", u.searchParams.get("lang") ?? "en");
      res.end(JSON.stringify(t));
    } catch (e: any) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: e.message, title: e.title ?? "" }));
    }
  };
  return {
    name: "turbogoo-youtube-api",
    configureServer: (s) => void s.middlewares.use(handler),
    configurePreviewServer: (s) => void s.middlewares.use(handler),
  };
}

export default defineConfig({
  plugins: [react(), youtubeApi()],
  build: { chunkSizeWarningLimit: 900 },
});
