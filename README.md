# BeanWeb

A BeOS R5 desktop that runs in a browser tab — yellow partial-width window tabs,
grey beveled widgets, and the Deskbar in the top-right corner. No backend: the
window manager, the filesystem and the shell all run client-side.

Built with React 19, TypeScript, Vite and Zustand. ~73 KB of gzipped JS.

![Tracker browsing /boot/home beside a game of Tetris, with the Deskbar top-right](docs/screenshot1.png)

![StyledEdit over an unsaved beanweb.txt, the Terminal listing ~/documents, and the About BeanWeb window](docs/screenshot2.png)

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest + jsdom
```

`npm run build` produces a static `dist/` you can host anywhere.

## What's in it

- **Window manager** — drag by the yellow tab, resize from the hatched corner or
  any edge, double-click the tab to zoom. Shift-drag slides the tab along the
  window's top edge, the way R5 does it.
- **Tracker** — file manager over a virtual disk, with icon and list views.
- **Terminal** — `help ls cd pwd cat edit open apps mkdir touch rm echo tree date
  uname fortune clear`, with command history on ↑/↓.
- **StyledEdit** — text editor with save, save-as through a browsable file
  panel, a dirty-title marker, a font menu, and a prompt before closing unsaved
  work.
- **Tetris** — 7-bag randomiser, wall kicks, a landing shadow you can switch
  off, and the classic tetromino palette muted a shade to sit against R5 grey.
  Touch pad on phones.
- **Claude** — a bare-bones chat client: streaming replies, stop mid-answer,
  multi-turn history, and a **Model** menu listing what your key can actually
  reach, priced and sorted cheapest first. Defaults to the cheapest model.
  Needs your own Anthropic API key (see below).
- **Deskbar** — application menu, live clock, and one entry per open window.

Files you create or edit persist in `localStorage`. *About BeanWeb → Reset disk*
restores the original contents.

### About the Claude app and your API key

![The Claude app answering a question about BeOS, running on claude-haiku-4-5 with token usage in the status bar, Tracker open on /boot/home behind it](docs/screenshot_claude.png)

Everything else here is backend-free, and the Claude app keeps it that way by
calling the Anthropic API straight from the browser. That means **your API key
is stored in this browser** (`localStorage`) and is readable by anything running
on the page. The Anthropic SDK requires you to opt into this explicitly, and it
is only appropriate for a local tool you run yourself.

Use a key you are willing to rotate, and **never deploy a build with a key set**.
No key ships with this repo, and none is ever written to the virtual disk.

The **Model** menu polls the Models API for what your key can reach and shows
each model's price. Pricing comes from a table in `src/lib/models.ts` rather
than the API, which does not report it — so it is a cached snapshot and may
drift. Models it has no price for still work; they just sort last.

## Keyboard

R5 used Alt where most systems use Ctrl, so this does too.

| Key | Action |
| --- | --- |
| `Alt+W` | Close the active window |
| `Alt+Tab` | Cycle windows |
| `Alt+S` | Save (StyledEdit) |
| `Esc` | Dismiss a menu or alert |
| `←` `→` `↓` | Move / soft drop (Tetris) |
| `↑` `X` / `Z` | Rotate / rotate back (Tetris) |
| `Space` / `P` | Hard drop / pause (Tetris) |

## Browsers

Works on phones, tablets and desktops — below 768px windows go full-screen and
the Deskbar becomes a bottom dock. Everything uses Pointer Events, so touch and
mouse behave the same.

The R5 scrollbars (beveled trough, stippled knob, arrow ends) need
`::-webkit-scrollbar`, so they render fully in Chrome, Edge and Safari. Firefox
falls back to `scrollbar-color`, which is correctly coloured but plainer.

## Notes

All artwork is original SVG. This is an affectionate homage and is not
affiliated with Be Incorporated or the Haiku project.

Architecture, design-system rules and contributor conventions are in
[CLAUDE.md](CLAUDE.md).

## Maintainers: bean-bot

`bean-bot` is a PR comment workflow that helps maintain docs updates in PRs.

When a PR is opened or reopened, bean-bot posts an introduction comment with
the command quick start.

- Trigger preview on a PR comment: `@bean-bot update docs`.
- Optional intent is supported: `@bean-bot update docs mention changes to BASIC screen behavior`.
- Apply a preview with: `@bean-bot apply <token>`.
- Only collaborators with write access can run commands.
- Current write scope is limited to `README.md` and `docs/`.
- Fork PRs get fallback guidance instead of a commit; the token cannot write to
  a fork branch.

The workflow lives in `.github/workflows/bean-bot.yml` and the runtime script
is `.github/scripts/bean-bot.mjs`.

The job is privileged — `issue_comment` runs with the base repository's token
and `contents: write` — so it **never checks out the PR head**. Only the base
ref is on disk, and the docs file is read and written through the GitHub
Contents API on the head branch. Keep it that way: a checkout of the head would
put attacker-controlled code beside a write-scoped token.
