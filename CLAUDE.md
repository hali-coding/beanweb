# BeanWeb

A browser-resident tribute to the **BeOS R5** desktop: yellow partial-width window
tabs, grey beveled widgets, a Deskbar in the top-right corner. No backend — the
filesystem, shell, and window manager all run in the tab.

## Commands

```bash
npm run dev        # Vite dev server with HMR
npm run build      # tsc -b && vite build  -> dist/
npm run preview    # serve the production build
npm run typecheck  # types only
npm test           # vitest run  (65 tests)
npm run test:watch # vitest, watch mode
```

CI runs typecheck -> test -> build on every PR
(`.github/workflows/ci.yml`).

## Testing

`tests/` holds a Vitest + jsdom suite. `fs` and `desktop` are pure store tests;
`tetris` and `shell` render real components with Testing Library. `shell`
mounts the whole `<Desktop />` and drives it the way a user would.

Five things bite repeatedly here, all learned the hard way:

- **Both Zustand stores are module singletons.** `tests/setup.ts` resets them
  and `localStorage` before every test, otherwise state leaks between tests.
- **Use `fireEvent.change` / `fireEvent.click`, never assign `.value` or
  `.checked` yourself.** React keeps a value tracker; writing the property
  first makes React see no change and silently skip `onChange`, so the
  component looks broken when it is fine.
- **Tetris needs `vi.useFakeTimers()`.** Gravity is an interval; on real timers
  the piece falls mid-assertion and tests race.
- **A tetromino does not always render four cells.** An I-piece spawns at
  `y = -1`, so rotating it at spawn puts one cell in the vanish zone above the
  field, which is legal and deliberately not drawn. Drop clear of the spawn row
  before asserting on cell counts.
- **Do not wait on a window title after launching an app.** Apps retitle
  themselves on mount (StyledEdit becomes "Untitled", Tracker the folder name).
  Wait on the window count instead.

jsdom has no layout engine, so `offsetWidth` is always 0. Anything about size,
position or overflow cannot be tested here and needs a real browser.

## Architecture

```text
src/
  main.tsx    entry: CSS in cascade order, then `import './apps'`, then render
  styles/     tokens.css (R5 palette) + reset, widgets, wm, shell
  lib/        types.ts, icons.tsx (original 32-unit-grid SVGs)
  store/      desktop.ts (windows, focus, alerts), fs.ts (virtual FS)
  wm/         BWindow, WindowLayer, useWindowGesture, useViewport
  widgets/    controls.tsx (Button, CheckBox, …), Menu.tsx (MenuBar + MenuPanel)
  apps/       registry.ts + one file per app + index.ts
  shell/      Desktop, Deskbar, DesktopIcons, Alerts, SavePanel, useShortcuts
tests/        vitest + jsdom; setup.ts resets the stores between tests
```

The CSS import order in `main.tsx` is load-bearing — `tokens` must come first,
and `shell`/`wm` override `widgets`. Do not reorder them.

State lives in two Zustand stores. `desktop.ts` owns windows, z-order, focus and
the alert queue. `fs.ts` owns a flat path-keyed node map persisted to
`localStorage` under `beanweb.fs.v1` (writes are debounced 250 ms).

## Invariants

**A live drag must never re-render.** `useWindowGesture` snapshots the rect on
`pointerdown`, writes `transform`/`width`/`height` straight to the DOM node
inside a `requestAnimationFrame`, and calls `commitRect()` only on `pointerup`.
Dragging a window costs one style write per frame and zero reconciliation.
`DesktopIcons` uses the same pattern. If you move geometry into React state
during a gesture, you have broken the thing that makes this feel native.

**Never build fresh objects inside a `useShallow` selector.** `useShallow`
compares elements with `Object.is`, so a selector that `.map()`s into new object
literals allocates new elements every call, never matches, and spins into
"Maximum update depth exceeded". Select the raw slices and derive with `useMemo`
in the component — see `shell/Deskbar.tsx`, which was written the wrong way
first.

**Apps self-register.** Each app module ends with `registerApp({...})` and is
imported for side effects by `apps/index.ts`. `registry.ts` imports no app
components, so an app can call `launchApp()` on any other app without a cycle.

**Close goes through `requestClose`, never `closeWindow`.** An app holding
unsaved state registers a guard with `useCloseGuard(windowId, fn)`; the guard
returns `false` to cancel. `requestClose` consults it, so the tab's close box,
`Alt+W` and *File → Close* all get the same prompt — a per-app close handler
would only cover one of the three. `closeWindow` is the unguarded escape hatch
and should stay that way. Guards live in a module-level Map (`lib/closeGuards`)
rather than the store because they are functions nothing renders, and are read
through a ref so they never see a stale `dirty` flag.

### Adding an app

1. `src/apps/MyApp.tsx` exporting a component that takes `AppProps`
   (`{ windowId, args }`), plus `src/apps/myapp.css` if it needs styles.
2. End the file with `registerApp({ id, name, component, icon, defaultW,
   defaultH, minW, minH })`. Add `singleton: true` to reuse one window,
   `hidden: true` to keep it out of the Deskbar menu.
3. Add `import './MyApp'` to `src/apps/index.ts`.
4. Draw an icon in `lib/icons.tsx` on the same 32-unit grid.

The window chrome, focus, drag, resize and menu bar all come for free — an app
renders only its own content into `.b-window-content`. If it holds unsaved
state, add a `useCloseGuard`.

## Design system

Greys are **derived, not picked**. R5 computes every shade from the panel colour
(216,216,216) via `tint_color()`:

```text
tint <  1.0 -> 255 - (255 - c) * tint    (lighten)
tint >= 1.0 -> c * (2 - tint)            (darken)
```

`styles/tokens.css` has the resulting ramp with the real `B_*_TINT` constants in
comments. Use `var(--panel-darken-2)` etc.; do not hardcode a hex grey.

Bevels are inset `box-shadow`s, never borders — they cost nothing to composite
and do not affect layout. Every edge is `var(--hairline)` thick, which shrinks
from `1px` to `0.5px`/`0.34px` as `min-resolution` rises so widgets stay exactly
one *device* pixel crisp instead of getting fat and soft on retina. Reach for
`.bevel-raised` / `.bevel-sunken` before writing new shadow stacks.

Fixed values worth knowing: tab yellow `#ffc900` (`B_WINDOW_TAB_COLOR`),
keyboard focus `#0000e5`, desktop `#336698`, plain font 12px/15px.

CSS class names are prefixed `b-` and named after the BeOS class they imitate
(`b-menubar`, `b-statusbar`, `b-textcontrol`). Per-app CSS sits next to the app
in a lowercase file (`tracker.css`) and uses the app's own prefix.

## Responsive strategy

One breakpoint at **768px**. Above it, a real floating window manager. Below it,
`wm.css` forces every window full-bleed and hides all but the front-most
(`.b-window--front`, computed in `WindowLayer`); drag and resize are disabled and
the Deskbar becomes a bottom dock with a safe-area inset. `@media (pointer:
coarse)` separately grows hit targets — scrollbars, tab height, list rows —
without changing the desktop metrics. Touch works because everything is Pointer
Events, not mouse events.

## Conventions

- R5 used **Alt** for shortcuts where other systems use Ctrl. Keep it that way
  (`Alt+W` close, `Alt+Tab` cycle); leave Ctrl to the browser.
- Menus render through a portal into `document.body` so window `overflow:
  hidden` cannot clip them.
- **Click-to-focus needs `preventDefault()`.** Calling `.focus()` from a
  `pointerdown` handler on a non-focusable element is not enough: the browser's
  default `mousedown` action then moves focus to the body and undoes it. The
  Terminal focuses its prompt this way, and skips both the call and the
  `preventDefault` when the click lands on output text so selection still
  works. jsdom does not implement that default blur, so this class of bug
  passes a headless test and only shows up in a real browser.
- **Stacking is a fixed ladder** of `--z-*` tokens (icons 10, windows 100,
  Deskbar 9500, menu 9800, alert 9900). `.b-window-layer` establishes a stacking
  context at 100, so per-window z values compete only with each other and can
  never climb over the Deskbar.
- **Two layering rules that are easy to reintroduce:** `.b-window-frame` must
  keep `position: relative` or its absolute resize handles anchor to the wrong
  box and the north handle turns a window drag into a resize; and
  `.b-window-tabrow` must stay `pointer-events: none` (with `auto` on the tab)
  or the transparent strip beside the tab silently eats clicks.
- Modals are promise-based and queue in the store, newest on top:
  `showAlert(kind, title, text, buttons, default)` resolves to the index of the
  button pressed, and `showSavePanel(title, directory, name)` resolves to the
  chosen path or `null` if cancelled. `SavePanel` renders before `Alerts` in
  `Desktop`, so its own overwrite confirmation paints above it.
- **A cancelled save must cancel the close.** `save()` returns `string | null`;
  StyledEdit's close guard returns `false` when it gets `null`, otherwise
  backing out of the save panel would still throw the document away.
- All icon artwork is original SVG. Do not add Be Inc. or Haiku assets — this is
  an homage, and `About` says so on screen.

## Not built yet

Replicants, the 3×3 Workspaces switcher, Pulse, DeskCalc, NetPositive, and media
apps. Window stacking/tiling (dragging one tab onto another) is not implemented;
tab *sliding* along the top edge is, via Shift-drag.
