import { getTranscript } from "../server/youtube";

// Vercel serverless function. NOTE: YouTube blocks many datacenter IPs, so this can fail in production
// even though it works locally; the UI falls back to pasting from "Show transcript".
export default async function handler(req: any, res: any) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "s-maxage=3600");
  try {
    const url = String(req.query?.url ?? "");
    res.status(200).send(JSON.stringify(await getTranscript(url, String(req.query?.lang ?? "en"))));
  } catch (e: any) {
    res.status(502).send(JSON.stringify({ error: e.message, title: e.title ?? "" }));
  }
}
