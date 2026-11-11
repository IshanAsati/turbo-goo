# TurboGoo ⚡

A local-first AI study workspace inspired by Turbo AI. Turn lectures, PDFs, slides, videos and topics into notes, flashcards, quizzes, a two-host podcast and a guided course. Everything is stored on your device; there is no TurboGoo server and no paywall.

![Home](docs/home.png)

| Notes with typeset math | Spaced-repetition flashcards | Learn Mode course |
| --- | --- | --- |
| ![Notes](docs/notes.png) | ![Flashcards](docs/flashcards.png) | ![Course](docs/course.png) |

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

It works immediately in **offline mode** (a basic built-in engine). For real quality, open **Settings** and connect any OpenAI-compatible provider (OpenAI, OpenRouter, Groq, Gemini, Together, or local Ollama). Your key stays in your browser and is sent only to the Base URL you set.

## Desktop app (Windows / macOS / Linux)

The desktop app is the same UI in an Electron shell, and it fixes the two main limits of the website:

- **YouTube import works reliably.** Captions are fetched from *your* connection instead of a cloud server, which YouTube blocks.
- **Any AI provider works** (Groq, OpenRouter, local Ollama or LM Studio) without CORS or `OLLAMA_ORIGINS` setup.

```bash
npm run desktop       # build and launch the app
npm run dist:win      # installer in release/  (TurboGoo-Setup-x.y.z.exe)
npm run dist:mac      # .dmg   (build on a Mac)
npm run dist:linux    # .AppImage   (build on Linux)
```

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`, which builds all three installers and attaches them to a GitHub Release. Builds are **unsigned**: Windows shows a one-time SmartScreen warning ("More info → Run anyway") and macOS needs right-click → Open the first time. Add signing certificates as repository secrets to remove those warnings.

Security model: the app is served from a custom `turbogoo://` origin (no network port is opened), the renderer is sandboxed with no Node access, a strict Content-Security-Policy applies, only the microphone permission is granted, and links open in your normal browser. Your API key stays in the app's local storage and goes only to the provider you configure.

## Features

**Capture**
- Paste text; upload PDF, Word (.docx), PowerPoint (.pptx), .txt/.md, .srt/.vtt, images (OCR) or audio/video
- YouTube import by link (server route; falls back to pasting from "Show transcript")
- Live lecture recording: live transcript, mic level meter, pause/resume, "flag ?" for confusing moments, screen wake lock, audio saved to disk every 5 s with **crash recovery**, original audio kept next to the notes

**Study materials**
- Notes streamed in as they're written, Markdown + KaTeX math, tables, split editor with formatting toolbar, `.md` and PDF export
- Live Assistant: non-destructive margin comments (errors, gaps, tips) checked against your source; click one to jump to the text
- Flashcards: atomic cards, SM-2 spaced repetition with interval previews, relearning steps, keyboard shortcuts (Space, 1-4), manual add/edit/delete, Anki-importable export
- Quizzes: multiple choice, fill-in-the-blank and open-ended (AI-graded), timed mode, endless "more questions", turn mistakes into flashcards
- Chat with notes: retrieval-grounded streaming answers with sources, "Add to notes", and shortcuts for the moments you flagged while recording
- Podcast: two-host script, browser voices or HD voices (provider TTS) with mp3 download
- Learn Mode: topic, file or YouTube link → 12-section gated course with a check-in after each lesson
- Study Stream (interleaved cards, questions, snippets) with Pomodoro timer; global Review queue; streak and activity heatmap

**Platform**
- Light/dark themes, responsive mobile layout, Ctrl+K command palette, keyboard-accessible
- Smart model routing: a "smart" model for notes/tutoring/courses, a "fast" one for cards/quizzes/grading
- Long sources are split and processed in segments; failed AI calls retry, then show a Retry button

## AI providers

| Capability | Needs |
| --- | --- |
| Notes, cards, quiz, chat, podcast script, course | any OpenAI-compatible chat model |
| Transcribing uploaded audio/video and recordings | provider with `/audio/transcriptions` (OpenAI, Groq) |
| HD podcast voices | provider with `/audio/speech` (OpenAI) |
| Photo/handwriting OCR | vision-capable chat model, otherwise in-browser Tesseract |

Providers must allow browser (CORS) requests. For Ollama start it with `OLLAMA_ORIGINS=*`.

## YouTube

`/api/youtube` fetches captions using several methods in order (transcript panel, caption tracks, Android client). In the **desktop app** it runs on your own connection and works. On a **hosted website** it usually fails, because YouTube blocks cloud IP ranges (confirmed by many reports; the only fixes are paid residential proxies or a paid transcript API). The website then shows the "paste from Show transcript" fallback and suggests the desktop app.

## Known limits (honest list)

- **Not built:** accounts, cross-device sync, real-time co-editing and sharing (data is local; use Settings → Backup), native iOS/Android/desktop apps, 3D anatomy explorer, pre-made AP/book libraries, Anki `.apkg` (TSV import works).
- Offline mode is a heuristic fallback. Its notes and cards are much weaker than any LLM's, and topic-only courses need an API key.
- Audio files over 25 MB can't be transcribed (provider limit); live browser transcription needs Chrome/Edge/Safari and sends audio to the browser vendor's speech service.
- Data lives in IndexedDB; clearing site data deletes it. Back up from Settings.
- Not yet tested on real iOS Safari, Firefox, or with real provider keys (tested against a mock OpenAI-compatible server and real YouTube/PDF/DOCX/PPTX inputs in Chromium and Electron).
- The Windows installer was built and tested here. The macOS and Linux builds come from the CI workflow and have **not** been run.
- Desktop auto-update is not set up; install new versions manually.
