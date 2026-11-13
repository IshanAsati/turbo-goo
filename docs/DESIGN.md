# TurboGoo design system

The UI follows a set of reference screenshots of a dark, violet, lesson-first study app. We copy the **layout, structure and feel**, not its artwork or branding: TurboGoo has its own wordmark and its own mascot (`src/components/Mascot.tsx`, "Goo").

## Principles
- **Dark by default** (`:root`), with a full light theme (`:root[data-theme="light"]`). Both must look finished.
- **Calm and focused.** One thing per screen, generous spacing, large friendly headings, few borders.
- **Chunky violet primary buttons** with a darker bottom edge that squashes when pressed (`button.primary` in `src/styles/theme.css`).
- **Rounded everything**: cards 18px, controls 12-14px, pills fully round.
- **Key terms are violet**, not highlighted: `.md strong` uses `--link`.
- **Lessons are paged**, not scrolled walls of text. Locked steps show a lock; completed steps a tick.

## Tokens (`src/styles.css`, top of file)
| Token | Dark | Use |
| --- | --- | --- |
| `--bg` | `#161514` | page background |
| `--panel` / `--panel2` / `--panel3` | `#211f1d` / `#2b2826` / `#35312e` | cards, raised cards, tracks |
| `--ink` / `--muted` | `#f4f1ec` / `#a3a09a` | text |
| `--line` | `#3a3633` | borders (1.5px) |
| `--brand` / `--brand-edge` / `--brand-ink` | `#7f58ea` / `#5d3bc4` / `#fff` | primary fill, its bottom edge, text on it |
| `--brand-soft` | violet at 16% | selected backgrounds, focus halo |
| `--link` | `#b6a0ff` | links, key terms, active icons |
| `--ok` `--bad` `--warn` | green / red / amber | status (all AA on `--bg` and `--panel`) |
| `--r` `--r-sm` | 18px / 12px | radii |

Fonts: `--f-body` and `--f-display` are Plus Jakarta Sans (bundled); `--f-mono` is JetBrains Mono for small technical labels only. **Never hard-code colours**: use the tokens so both themes work. Any new text/background pair must reach WCAG AA (4.5:1) in both themes.

## Shared primitives (`src/styles/theme.css`)
`button`, `button.primary`, `.ghost-btn`, `.icon-btn`, `.chip`, `.seg`, inputs, `.panel`, `.dialog`, `.menu`, `.toast`, `.md` (rendered Markdown), `.bar` / `.progress-line`, `.badge`.

## Screens and where their styles live
Each screen imports its own stylesheet from its component (so it loads after the globals):
`src/styles/shell.css` (top bar, app shell), `home.css`, `doc.css` (doc layout, rail, chat panel, source), `notes.css`, `learn.css`, `study.css` (flashcards, quiz, podcast, review), `settings.css`.
Old rules in `src/styles.css` still exist for components that have not been restyled yet; override them from the screen stylesheet rather than editing `styles.css`.

## Layout map
```
Top bar (all pages): wordmark · breadcrumb (Home › Document title)            Review(badge) Chat Stream  ☾  ⚙
Home:      mascot · "What do you want to learn?" · composer · "Jump back in" bar · Lessons list
Document:  [rail 84px: Learn / Notes / Quiz / Flashcards / Podcast / Source] [content] [right panel: Chat or Lesson tutor]
Lesson:    full-screen player, one page at a time, progress bar, Continue, tutor panel on the right
```
