---
name: create-pkg
description: Scaffold a new BeanWeb package — an installable `.pkg` application — from a plain-language description of what it should do. Use when asked to create, scaffold, start, or write a new package/app for BeanWeb's Coffee Shop, or when invoked as /create-pkg <purpose>.
---

# Creating a BeanWeb package

The arguments are the **purpose** of the app in plain language — e.g. `/create-pkg
a scratchpad for quick sums, like Calculator but keeps a running list` or
`/create-pkg a todo list that saves to its own folder`. There is no other input;
everything below is derived from that sentence.

A package is not part of BeanWeb — nothing in `src/` imports `pkgs/`, and
`pkgs/build.mjs` imports nothing from `src/`. `docs/packages.md` is the format
and the `bw` API; `pkgs/README.md` is the build tool. Skim both if anything
below is ambiguous, they are short.

## 1. Turn the purpose into a scaffold call

Pick, from the purpose sentence:

- **slug** — kebab-case, lowercase letters/digits/dashes, becomes the directory
  under `pkgs/` and the default id's tail.
- **name** — a short application name, Title Case, ≤ 48 characters.
- **summary** — one sentence, what it does.
- **extensions** — only if the purpose is clearly about editing *a kind of
  document* (a todo list that saves files, a small drawing tool). A pure tool
  with no document of its own (a calculator, a dice roller, a color picker)
  gets none. Invent a short extension that reads as belonging to the app, e.g.
  `.todo`, `.jots` — never reuse `.bicon`, `.svg`, `.bas`, `.bcl`, which
  BeanWeb's own apps already claim.

Then run:

```bash
node pkgs/build.mjs init <slug> --name "<Name>" --summary "<summary>" \
  [--ext <.ext>]
```

This writes `pkgs/<slug>/manifest.json`, `main.js` and `icon.svg` — already
building, installing and running, not a stub. Leave `--id` and `--publisher`
at their defaults; the id is a placeholder (`com.example.<slug>`) on purpose,
and whoever actually ships this decides both later.

## 2. Read what it wrote

Read the generated `pkgs/<slug>/main.js` before changing anything — it is a
complete worked pattern for the `bw` bridge (ready/setTitle/fs/alert, the
CSS-in-JS chrome, the keydown handler) and the fastest way to see the shape
this format wants. You are about to gut its *content*, not its *structure*.

## 3. Replace the body with the actual purpose

Rewrite `main.js` to do what the purpose describes, keeping the file's own
constraints — they are load-bearing, not style:

- **Plain ES2020, one file, no build step, no imports.** The browser runs
  exactly what is in the zip.
- **Only `window.bw`** reaches outside the frame: `bw.ready()`, `bw.setTitle()`,
  `bw.close()`, `bw.alert(text, kind, buttons)`, and — only with the `fs`
  permission — `bw.fs.read/write/list/remove(path)`. Nothing else crosses the
  boundary.
- **No `alert()`, `confirm()`, `prompt()`.** The sandbox has no `allow-modals`.
  Any yes/no or text-entry moment the purpose needs has to be drawn by hand
  (`iconedit`'s name sheet and file list in `pkgs/iconedit/main.js` are the
  worked example) or asked through `bw.alert`, which only returns a button
  index.
- **No network.** `connect-src 'none'` means `fetch` never leaves the frame.
  If the purpose implies calling out anywhere, that part of it cannot be built
  as a package; say so rather than writing a `fetch` that will silently fail.
- **Draw its own chrome.** The frame has none of BeanWeb's CSS. A `<style>`
  block in the R5 panel-grey palette (`#d8d8d8` panel, `#979797` hairline,
  `#0000e5` focus) reads as native; anything wildly different reads as a
  stranger's app inside the desktop, which is a fine choice too if the purpose
  calls for it (a game, a colour tool).
- **Only touch storage the manifest asks for.** Keep `permissions: ["fs"]`
  only if the app actually persists something; drop it (and the `bw.fs` calls)
  for a pure tool that holds no state, or state that only needs to last the
  window's lifetime. A package is asked about its permissions before install,
  so don't request one for the sake of the scaffold's habit.
- **If `extensions` is set**, use `bw.ready().path` for the opened document —
  it is the one file outside the package folder this app may read and write,
  named by Tracker's double-click. `path` is `null` when launched from the
  Deskbar instead; both cases need to work.
- Update the manifest's `summary`, `window` sizing (a calculator wants small
  and fixed-feeling; an editor wants room) and `icon.svg` if the generic
  window-glyph placeholder doesn't fit — a distinct icon is cheap and it's how
  the app is told apart in Tracker and the Deskbar.

## 4. Verify

```bash
node --check pkgs/<slug>/main.js      # syntax
node pkgs/build.mjs <slug>            # rebuild after every edit
npx vitest run tests/pkgs.test.ts     # the format itself still holds
```

`tests/pkgs.test.ts` only exercises `iconedit` and the `init` scaffold, not
this specific package — passing it proves the *build tool*, not the new app.
For the app itself, install and drive it in a real browser: the `run-beanweb`
skill's driver can open Coffee Shop, feed it `pkgs/dist/<id>.pkg` through
*File → Install from This computer…*'s file chooser, launch the app from the
Deskbar, and drive `.sandbox-frame` with
`page.frameLocator(...)`. This matters more here than almost anywhere else in
the repo — jsdom never executes an iframe's scripts, so nothing about whether
the entry script actually runs can be caught any other way. Do this rather
than reporting the package done on `node --check` and a build alone.

## Don't

- Don't invent a second permission or bridge verb — `fs` is the only
  permission `PERMISSIONS` in `src/lib/packages/types.ts` grants today, and a
  package cannot ask its way to more (see `docs/packages.md` → Permissions).
- Don't reach into `src/` from the package, or the reverse. The whole point of
  `pkgs/` is that it doesn't need to.
- Don't ship the scaffold's placeholder id. Mention it in the summary you give
  back, the way `init` already prints as a reminder.
