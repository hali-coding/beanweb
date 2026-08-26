---
name: run-beanweb
description: Build, run, screenshot and drive BeanWeb — the BeOS R5 tribute desktop. Use when asked to run, start, launch, screenshot, smoke-test, or interactively drive the app; to verify a UI change in a real browser; or to check that an app (Tracker, Terminal, StyledEdit, BASIC, Tetris, Claude) actually works end to end.
---

# Running BeanWeb

BeanWeb is a static Vite + React app — a BeOS R5 desktop that runs entirely in
one browser tab. No backend, no database, no services.

**Drive it with the committed driver**, not by starting a dev server and
looking at a window:

```
.claude/skills/run-beanweb/driver.mjs
```

It boots the dev server, drives real Chrome via `playwright-core`, and writes
PNGs. All paths below are relative to the repo root.

## Prerequisites

Node 24 and Google Chrome. Chrome is already installed at
`C:\Program Files\Google\Chrome\Application\chrome.exe`; the driver uses it via
Playwright's `channel: 'chrome'`, so **no browser download is needed** and
`npx playwright install` is not required.

```bash
npm install          # includes playwright-core, the driver's only extra dep
```

## Verify the code before driving it

```bash
npm run typecheck    # tsc -b
npm test             # vitest, 275 tests
npm run build        # tsc -b && vite build -> dist/
```

## Run — agent path (use this)

### Full smoke flow + screenshots

```bash
node .claude/skills/run-beanweb/driver.mjs smoke
```

Boots the desktop, opens Terminal / BASIC / Tetris, runs a program, drags a
window, and writes six PNGs to `.claude/skills/run-beanweb/shots/`. Prints a
PASS/FAIL line per check and exits non-zero if any fail. Takes ~25s.

Verified output:

```
PASS  desktop icons — 4 icons
PASS  deskbar clock — 16:29
PASS  boots a Tracker window — home
PASS  terminal runs a command — hello beanweb
PASS  BASIC runs a program — 1 squared 1
PASS  infinite loop keeps running — running
PASS  Stop interrupts it — done
PASS  Tetris renders a 10x20 well — 200 cells
PASS  window drags — dx=122
PASS  no console errors
ALL PASSED
```

### One screenshot

```bash
node .claude/skills/run-beanweb/driver.mjs shot boot-check
# shot -> .claude/skills/run-beanweb/shots/boot-check.png
```

### Interactive — pipe commands to the REPL

This is the flexible path. Commands are read from stdin, one per line:

```bash
node .claude/skills/run-beanweb/driver.mjs repl <<'EOF'
open Terminal
type .term-input tree /boot/home/basic
key .term-input Enter
sleep 400
eval [...document.querySelectorAll('.term-line')].at(-1).textContent
ss terminal-tree
errors
quit
EOF
```

Verified to print:

```
"+ basic\n  - guess.bas\n  - hello.bas\n+ config\n+ Desktop\n..."
```

| Command | Effect |
|---|---|
| `open <AppName>` | launch via the Deskbar menu — `Tracker`, `Terminal`, `StyledEdit`, `BASIC`, `Tetris`, `Claude` |
| `click <sel>` / `dblclick <sel>` | mouse |
| `type <sel> <text>` | fill an input/textarea |
| `key <sel> <Key>` | e.g. `key .term-input Enter` |
| `text <sel>` / `count <sel>` | read the DOM |
| `eval <js>` | run JS in the page, print the JSON result |
| `ss [name]` | screenshot into `shots/` |
| `sleep <ms>` | wait |
| `errors` | console errors and failed requests seen so far |
| `quit` | close browser + dev server |

**Always `quit`** — otherwise the Chrome and Vite processes survive the script.

## Useful selectors

| What | Selector |
|---|---|
| A window / its title / active one | `.b-window`, `.b-window-title`, `.b-window--active` |
| Window tab, close box, zoom box | `.b-window-tab`, `.b-window-close`, `.b-window-zoom` |
| Deskbar logo (opens the app menu) | `.b-deskbar-logo` |
| Menu popup and its items | `.b-menu`, `.b-menu-item` |
| Alert text and buttons | `.b-alert-text`, `.b-alert-buttons .b-button` |
| Terminal input / output lines | `.term-input`, `.term-line` |
| BASIC source / console / status | `.basic-source`, `.basic-output`, `.basic-state` |
| BASIC Run/Stop buttons | `.basic-bar button` |
| BASIC screen window / its canvas | `.bscreen`, `.bscreen-canvas` |
| Tetris cells | `.tetris-field .tetris-cell` |

## Run — human path

```bash
npm run dev          # http://localhost:5173/
```

Opens nothing on its own; you browse to it. Useless for an agent — there is no
way to observe or click from the shell, which is why the driver exists.

## Gotchas

- **There is no `chromium-cli` on this machine, and this is Windows, not a
  Linux container.** The driver uses `playwright-core` with
  `channel: 'chrome'` against the installed Chrome. Do not reach for
  `xvfb-run`, `apt-get`, or `npx playwright install`.
- **Vite silently moves to the next free port.** If 5173 is taken it starts on
  5174 with no error, and a driver hard-coded to 5173 attaches to whatever
  *else* is serving. The driver pins `--port 5199 --strictPort` so a busy port
  is a loud failure instead of a wrong one. Stale dev servers from earlier
  sessions are common here — check before blaming the app.
- **`spawn('npm', …)` needs `shell: true` on Windows**, or it fails with
  ENOENT. That is why the driver sets it.
- **Running the driver can kill a dev server you already had open.** Observed:
  a `npm run dev` server on 5174 died with a bare `exit code 1` and no error
  text during a driver run. The driver starts its own Vite, and both share
  `node_modules/.vite` — the second one logs "Re-optimizing dependencies" and
  rewrites that cache underneath the first. Different ports do not save you.
  Either stop your dev server before running the driver, or expect to restart
  it afterwards.
- **Chrome requests `/favicon.ico` on its own and the project ships none**, so
  every run logs a 404 console error. It is not an app defect; the driver
  filters it and says so. Don't chase it.
- **A console error's text has no URL** — Chrome's message is just "Failed to
  load resource: … 404". The URL is on `msg.location().url`, and without it the
  message is unactionable. The driver joins them.
- **`.basic button` also matches the menu bar.** `.b-menubar-item` elements are
  `<button>`s, so a selector like `.basic button` finds the *Run menu title*,
  not the Run button — clicking it does nothing (the menu opens on
  `pointerdown`). Scope to `.basic-bar button`. The same trap applies in
  `.tracker`, `.sedit` and `.claude`.
- **Playwright's 30s default timeout makes a typo'd selector feel like a hang.**
  The driver sets 5s; this app renders instantly, so anything slower is a bad
  selector.
- **A multi-line BASIC program cannot be typed with `type`**, which joins its
  arguments with spaces. Set `.basic-source` through `eval` with the native
  value setter plus an `input` event, or React never sees the change. Mind the
  double escaping: a `\` in the heredoc reaches JS as an escape and vanishes,
  so integer division needs `\\\\` — or use `INT(a / b)` and avoid it.
- **The screen window only exists once a program draws.** `.bscreen-canvas`
  returns nothing for a program that merely prints; that is correct, not a
  failure to render.
- **Apps retitle themselves on mount**, so don't wait on a window title after
  launching: StyledEdit becomes `Untitled`, BASIC `Untitled.bas`, Tracker the
  folder name. Wait on `.b-window` count instead.
- **The virtual filesystem persists in `localStorage`.** A fresh browser context
  each run means a clean disk; if you reuse a profile, earlier edits survive.
  *About BeanWeb → Reset disk* restores the seeded contents.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `dev server exited (1)` with `Port 5199 is already in use` | A previous driver run leaked a Vite process. Kill it, or the port is genuinely taken. |
| `browserType.launch: Chromium distribution 'chrome' is not found` | Chrome isn't installed where Playwright looks. Install Chrome, or edit `driver.mjs` to pass `executablePath` instead of `channel`. |
| `locator.* Timeout 5000ms exceeded` | Wrong selector (usually). Check the table above; `count <sel>` returning `0` confirms it. |
| Smoke fails only on `no console errors` | Run `errors` in the REPL to see the URL. A bare favicon 404 is filtered already, so anything reported is real. |
| Chrome/node processes left running | The script didn't reach `quit` or its `finally`. Kill them by hand. |

## The driver

`.claude/skills/run-beanweb/driver.mjs` — ~250 lines, no build step. Screenshots
land in `.claude/skills/run-beanweb/shots/` (gitignored). If it grows into
something the test suite wants to share, move it to `scripts/` or `e2e/` and
update this file.
