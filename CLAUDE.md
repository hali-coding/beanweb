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
npm test           # vitest run  (325 tests)
npm run test:watch # vitest, watch mode
```

CI runs typecheck -> test -> build on every PR
(`.github/workflows/ci.yml`).

## Testing

`tests/` holds a Vitest + jsdom suite. `fs` and `desktop` are pure store tests;
`tetris` and `shell` render real components with Testing Library. `shell`
mounts the whole `<Desktop />` and drives it the way a user would. `graphics`
drives the BASIC screen through real BASIC source rather than calling `Screen`
directly — the bugs worth catching live in the seams between STEP, VIEW and
WINDOW, and a unit test on `Screen.pset` would miss every one.

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
position or overflow cannot be tested here and needs a real browser. jsdom has
no canvas either: `Screen` is pure data so its pixels test fine, but *that they
reach a canvas* does not, and the screen window's fit arithmetic cannot either.
Both have already been wrong while the suite was green — drive the browser.

## Architecture

```text
src/
  main.tsx    entry: CSS in cascade order, then `import './apps'`, then render
  styles/     tokens.css (R5 palette) + reset, widgets, wm, shell
  lib/        types.ts, icons.tsx (original 32-unit-grid SVGs), theme.ts,
              disk.ts (the shared reset-disk confirmation)
  store/      desktop.ts (windows, focus, modals), fs.ts (virtual FS),
              settings.ts (API key, model, theme)
  wm/         BWindow, WindowLayer, useWindowGesture, useViewport
  widgets/    controls.tsx (Button, CheckBox, …), Menu.tsx (MenuBar + MenuPanel)
  apps/       registry.ts + one file per app + index.ts
  shell/      Desktop, Deskbar, DesktopIcons, Alerts, SavePanel, Shutdown,
              ThemeCurtain, useShortcuts
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

## Shut Down

The Be menu ends with *Restart* and *Shut Down*, and both run one sequence:
confirm, quit every window front-most first, then park. Shut Down parks on a
window that says it is now safe to turn off your browser tab, with a **Reboot
System** button that Enter also triggers — R5's final dialog, which is where the
wording comes from. Restart skips the parked window and boots straight back up.

- **The sequence closes windows with `requestClose`, never `closeWindow`**, so
  an app holding unsaved work gets the same prompt its close box would give it.
  If the guard says no, the whole shutdown is abandoned rather than the window
  killed — what R5 did when an application refused to quit. This is the reason
  `--z-shutdown` (9850) sits *below* `--z-alert` (9900): the guard's prompt has
  to paint on top of the shutdown screen, not behind it.
- **The store is synchronous; the view paces it.** `beginShutdown` sets the
  state and `quitNext()` quits exactly one window, so a test can step the
  sequence a window at a time with no timers. Only `shell/Shutdown.tsx` owns the
  interval that calls it. `quitNext` keeps a module-level re-entry guard because
  the interval keeps ticking while one step is awaiting a close guard's alert.
- **The window is a replica, not a managed window.** It has no entry in the
  store, no drag, resize or close box, and it has to survive the store being
  emptied around it. It reuses the real `.b-window-*` classes so its tab and
  bevels cannot drift from every other window; only the R5-bold tab title and
  the static centred position are its own.
- `reboot()` clears windows, alerts and panels but **not** `fs` — a reboot keeps
  the disk. Relaunching the boot Tracker is left to the component, because
  `registry.ts` imports the store and the store must not import it back.

## BASIC graphics and the screen window

The BASIC editor and the program's screen are **two windows**. `apps/Basic.tsx`
holds the listing and a console transcript; `apps/BasicScreen.tsx` is the
program's actual display, text and pixels together, the way QBasic's output
screen was a separate thing from its editor.

- **The screen window opens by itself**, the first time a program draws and
  again on every SCREEN mode change. A program that only prints never opens
  one. *Run -> Show screen* opens it by hand.
- **F5 runs and Esc breaks, but only Esc is window-local.** The editor handles
  both on its app root, so they fire from the listing, the console and the
  INPUT box. The screen window handles F5 as well — pressed there it would
  otherwise reload the tab and take the desktop with it — and reaches the
  editor's controls through `session.run` / `session.stop`, mutable fields the
  editor installs in an effect. Esc is deliberately *not* stolen there:
  `inkeyFor` reports it as `CHR$(27)` and listings that quit on Escape need to
  see it. To stop such a program, press Esc in the editor window.
- **The two windows meet in `lib/basic/session.ts`**, a module-level Map keyed
  by the editor's window id — the same reasoning as `lib/closeGuards`. What
  passes between them is a `Screen` mutated thousands of times a second and a
  keyboard queue; a Zustand store would mean a store write per pixel.
  `createSession` runs during render but the teardown is an effect, so the
  effect must `attachSession` on the way in — React runs mount/cleanup/mount in
  development, and the throwaway pass's cleanup would otherwise unregister a
  session nothing creates again.
- **The screen never re-renders React.** The interpreter mutates `Screen` and
  bumps `version`; the window polls it on `requestAnimationFrame` and blits
  only when it moved. Same rule as window drags and the Claude token stream.

`lib/basic/screen.ts` is pure data — no canvas, no DOM — which is what lets the
whole graphics layer be tested under jsdom.

- **Colours are attribute indices, never RGB.** That is what makes PALETTE work
  (remapping an attribute recolours every pixel already drawn with it) and what
  lets POINT return the number the program passed to PSET.
- **Text is a second layer over the pixels, not written into them.** Hardware
  wrote glyphs straight to video memory, so a line drawn through text erased
  it. Here it does not. The trade buys exact LOCATE, exact scrolling, and text
  PAINT cannot flood through; a cell never written stays transparent, which is
  why the char code `0` means "empty" and a printed space does not.
- **Aspect is one formula, `pixelAspect(displayW, displayH)`.** The window
  stretches by it and CIRCLE's default aspect ratio is its reciprocal, so a
  circle comes out round in every mode without a per-mode constant.
- **The screen window sizes its canvas in JavaScript**, not with `aspect-ratio`.
  The ratio wanted is not the bitmap's — a 320x200 screen must be shown 320x240
  — and CSS cannot letterbox against both axes without the used width
  collapsing to the canvas's intrinsic size. Measure the stage's *content* box:
  `clientWidth` counts its padding, and flex then quietly shrinks the frame
  back, distorting the picture by exactly that much.
- **GET/PUT keep sprites beside the array, not packed into it.** The array gets
  the two header words a listing might read; the packed pixel body is the one
  thing not reproduced, so GET-then-PUT is exact and poking at the bytes is not
  supported.
- **PAINT is a scanline fill with an explicit stack.** The recursive version
  blows the JS stack about a third of the way across a 640x480 screen, which a
  program filling its background does on the first statement.
- `font.ts` is an original 8x8 face, like the icons. Modes with taller cells
  (8x14 in SCREEN 9, 8x16 in SCREEN 0/11/12) letterbox it rather than switching
  to a second face, so text there is airier than a real VGA drew it while still
  landing on the exact cell LOCATE names.

Implemented: SCREEN 0/1/2/7/8/9/11/12/13, PSET, PRESET, LINE (incl. STEP, B,
BF, style masks), CIRCLE (incl. arcs, pie slices, aspect), PAINT, DRAW, COLOR,
LOCATE, CLS 0/1/2, VIEW, VIEW PRINT, WINDOW, PALETTE, PALETTE USING, GET, PUT,
WIDTH, POINT, PMAP, CSRLIN, POS, SCREEN(), TAB, SPC, INKEY$, SLEEP.

Not implemented, deliberately: `DRAW "X"` (needs `VARPTR$`, and there is no
memory model to fake); PAINT's string tile patterns; video pages; SCREEN 3/4/10
(Hercules and mono EGA). BEEP, SOUND and PLAY parse and run so a listing is not
stopped by them, but nothing is heard.

`GORILLA.BAS` is the target `tests/gorilla.test.ts` measures against, and it
still does not compile. The graphics it needs are all here now; what is left is
language, not drawing — user-defined `TYPE`s first, then `DEFINT`, `STATIC`,
`ON ERROR`, `DEF SEG`/`PEEK`/`POKE` and `ERASE`.

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

Fixed values worth knowing (light): tab yellow `#ffc900`
(`B_WINDOW_TAB_COLOR`), keyboard focus `#0000e5`, desktop `#336698`, plain font
12px/15px.

CSS class names are prefixed `b-` and named after the BeOS class they imitate
(`b-menubar`, `b-statusbar`, `b-textcontrol`). Per-app CSS sits next to the app
in a lowercase file (`tracker.css`) and uses the app's own prefix.

### Dark mode

`tokens.css` holds two palettes, switched by `data-theme` on the **root
element**. Everything above them — metrics, the `--z-*` ladder, and
`--desktop-light`/`--desktop-dark` — is theme-invariant.

- **The attribute goes on `documentElement`, never on `.b-desktop`.** Menus
  render through a portal into `document.body`, so an attribute set on the
  desktop div would leave every open menu on the old palette. `lib/theme.ts` is
  the only thing that writes it, and it also updates the `theme-color` meta.
- **Dark is `tint_color()` from a base of 110 for the darken arm only.** The
  lighten arm is anchored to white, so from 110 it returns `#ffffff` for
  `--panel-lighten-max` — a 145-step jump where light mode takes 39, and a
  pure-white hairline on mid-grey reads as glare, not as a bevel. The dark
  lighten values mirror light mode's *proportional* steps upward instead. Both
  deviations are commented at the point of use.
- **The panel ramp means *bevel*. Text has its own tokens.** `--panel-text`,
  `-dim`, `-faint`, `-disabled` and `--mark`. The ramp used to double as a text
  ramp, which inverts in dark mode: disabled text has to come out *lighter* than
  the panel, not darker. Never write `color: var(--panel-darken-*)` again, and
  never a bare `#000`/`#fff`. Both light ladders are the exact values those
  sites rendered before, so the swap changed nothing in light mode.
- **Dark cannot reach light's contrast range**, and should not try. A `#6e6e6e`
  panel gives primary text a ratio of 4.6 against light mode's 14.7. The three
  levels are chosen so each one's *ratio* matches its light counterpart; check
  with a contrast calculation rather than by eye before adding a fourth.
- **Terminal, the BASIC console, the BASIC screen and Tetris are deliberately
  not themed.** They are screens and a game, not chrome — emulated CGA/VGA
  attributes, a phosphor palette, tetromino colours. So is `lib/icons.tsx`: R5
  icons were full-colour artwork, and a page icon is white paper on any desktop.
- **The four scrollbar arrows are `data:` URIs.** `var()` cannot be interpolated
  inside `url()`, so the dark theme re-declares those four `background-image`
  rules. Note that a Chrome using overlay scrollbars ignores
  `::-webkit-scrollbar` entirely, so the arrows may not render at all — that is
  the environment, not the rule.
- **`index.html` stamps the root before the first paint.** A small inline script
  reads `beanweb.settings.v1` so a persisted dark theme does not flash light
  while React boots. It is the only place the storage key is duplicated.
- **The curtain is view-paced, the store is not.** `store/settings.ts` flips
  `theme` synchronously and touches no DOM; `shell/ThemeCurtain.tsx` owns the
  timers, drops an opaque panel, repaints underneath it, and lifts. Same
  division as Shut Down. The timing is `setTimeout`, **not `animationend`** —
  jsdom never fires CSS animation events, and on the clock the whole sequence
  steps under `vi.useFakeTimers()`. It portals into `document.body`, because
  `.b-desktop` sets `isolation: isolate` and a menu portalled to the body would
  otherwise paint straight over a curtain rendered inside it. Reduced motion
  skips the curtain and swaps the palette outright.
- A new persisted setting must be added to `tests/setup.ts`'s reset literal, or
  it leaks between tests.

## Preferences

`apps/Preferences.tsx` is the settings panel: an **Appearance** box holding the
light/dark radios, and a **Disk** box holding the node count and *Reset disk…*.
R5 kept one preflet per setting in a Preferences folder; there is not enough
here for a folder, so this is one panel of labelled `Box`es — the shape a
preflet had, with more than one box in it.

- **Nothing is staged, so there is no OK or Revert.** Choosing Dark drops the
  curtain immediately and Reset asks for confirmation itself, which leaves a
  footer with nothing to commit. The close box is the way out.
- **This is the only place the theme changes.** The Be menu carried a *Dark
  Mode* item for a while and no longer does — the menu is applications and
  power, and a setting belongs in the settings panel. The radios are a view over
  `useSettings`, never their own state, so a theme restored from localStorage
  arrives already marked.
- **`lib/disk.ts` owns the reset confirmation**, because About offers it too and
  a destructive action's wording must not drift between the two places that
  offer it. It reads the stores through `getState()` for the same reason
  `launchApp` does: it is an action, not a subscription.
- The radio `name` comes from `useId()`. The app is a singleton today, but a
  second window would otherwise share the first one's radio group.

## Responsive strategy

One breakpoint at **768px**. Above it, a real floating window manager. Below it,
`wm.css` forces every window full-bleed and hides all but the front-most
(`.b-window--front`, computed in `WindowLayer`); drag and resize are disabled and
the Deskbar becomes a bottom dock with a safe-area inset. `@media (pointer:
coarse)` separately grows hit targets — scrollbars, tab height, list rows —
without changing the desktop metrics. Touch works because everything is Pointer
Events, not mouse events.

## The Claude app and its API key

`apps/Claude.tsx` is the only thing here that touches the network. It calls the
Anthropic API **directly from the browser** with `dangerouslyAllowBrowser: true`,
because the project has no backend to proxy through.

- The key lives in `store/settings.ts` under `beanweb.settings.v1` and is
  **entered by the user**. Never hard-code one, never commit one, never write one
  into the virtual filesystem, and never log it.
- Render it only through `maskKey()`. It must not appear in full anywhere.
- The security tradeoff is real: any script on the page can read it. That is
  acceptable for a local desktop toy — the Anthropic docs sanction exactly this
  "internal tool / development" case — and **not** acceptable for a public
  deploy. If this is ever hosted, the app needs a server-side proxy first.
- Stream (`client.messages.stream`) and resend the **full**
  `Anthropic.MessageParam[]` history every turn — the API is stateless. Do not
  use assistant prefill; it returns 400 on the 4.6+ family.
- **The model is the user's choice, not a constant.** `lib/models.ts` holds the
  catalogue; `store/settings.ts` persists the selection. The default is
  `DEFAULT_MODEL` — the cheapest model we hold a price for — because the user
  asked for that, not because cheap is the right default in general.
- **Never hard-code request shape per model.** `requestShape()` derives
  `max_tokens` from the model's reported cap and only sends
  `thinking: {type:'adaptive'}` when `capabilities.thinking.types.adaptive`
  says so. Haiku 4.5 predates adaptive thinking and 400s if it is sent.
- Prices are **not** in the Models API. `PRICES` in `lib/models.ts` is a cached
  table and will drift; unpriced models still work, they just sort last.
- **Price is never shown to the user.** It orders the picker cheapest first and
  pins `DEFAULT_MODEL`, and that is all it is for — the menu and the status bar
  carry the model's name and nothing else. A cached table drifting is a
  cosmetic problem only as long as it stays off screen; do not put it back.
- `pollModels` keeps its in-flight guard in a **ref**, not state. Depending on a
  flag the callback also sets would re-fire the effect that calls it — the same
  infinite-loop shape as the `useShallow` rule above.
- Stream deltas are buffered in a ref and flushed on `requestAnimationFrame`,
  the same rule as window drag: never one render per token.
- Tests must mock `@anthropic-ai/sdk`. No test may make a network call. Copy the
  real error classes onto the mock so `instanceof` branches still work — see
  `tests/claude.test.tsx`.

## Conventions

- R5 used **Alt** for shortcuts where other systems use Ctrl. Keep it that way
  (`Alt+W` close, `Alt+O` open, `Alt+S` save, `Alt+Tab` cycle); leave Ctrl to
  the browser. BASIC's `F5` and `Esc` are the deliberate exception — they are
  QBasic's keys, and the app is imitating QBasic, not the Tracker.
- **A menu `shortcut:` label is only a label.** Nothing binds it; the app still
  needs the key in its own `onKeyDown`. BASIC advertised `Alt+S` for a while
  without handling it.
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
  button pressed, and `showSavePanel(title, directory, name)` /
  `showOpenPanel(title, directory)` resolve to the chosen path or `null` if
  cancelled. `SavePanel` renders before `Alerts` in `Desktop`, so its own
  overwrite confirmation paints above it.
- **One file panel serves both modes.** Save and open share a queue, a
  component and a `SavePanelState`; `mode` picks the confirm rule (save asks
  before replacing, open refuses a name that is not a document and treats a
  folder name as a navigation) and the labels. Do not fork a second component
  for it — R5 had one `BFilePanel` too.
- **A cancelled save must cancel the close.** `save()` returns `string | null`;
  StyledEdit's close guard returns `false` when it gets `null`, otherwise
  backing out of the save panel would still throw the document away.
- All icon artwork is original SVG. Do not add Be Inc. or Haiku assets — this is
  an homage, and `About` says so on screen.

## Not built yet

Replicants, the 3×3 Workspaces switcher, Pulse, DeskCalc, NetPositive, and media
apps. Window stacking/tiling (dragging one tab onto another) is not implemented;
tab *sliding* along the top edge is, via Shift-drag.
