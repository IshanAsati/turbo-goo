# Agent notes

## publik API
- Base URL: https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages)
- Models: publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Sign in with publik: optional. The first-launch choice is asked once and remembered (Settings → publik can change it). The gate runs in electron/main.ts, and only when the person chose to sign in
- Key: per-install `pk_` from POST /installs, stored at the publik credential path; env PUBLIK_API_KEY / PUBLIK_API_BASE_URL override
- App token: publik-app-token.txt (public by design, committed) or PUBLIK_APP_TOKEN
- The page only sends the placeholder key `publik-managed`; electron/main.ts adds the real key to requests to publik from the app's own page
- 402: show error.message + error.top_up_url only
- Show use: GET /wallet used_percent or prepaid_remaining_percent, never money
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md
