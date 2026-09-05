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
npm test           # vitest run  (519 tests)
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
              disk.ts (the shared reset-disk confirmation),
              keystore.ts (sealed storage for the API key),
              transfer.ts (import/export between the host and the disk),
              basic/ (the BASIC engine), beanchallenge/ (the game's rules),
              draw/ (the vector document model and the SVG file format)
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

Adding an app to `src/store/fs.ts`'s `seed()` as an `app()` node is what puts it
in Tracker and in `ls /boot/apps`; `tests/shell.test.tsx` walks that folder.

## Bean Challenge

A tile puzzle in the spirit of *Chip's Challenge*: collect the beans, open the
socket, reach the exit before the clock runs out. Thirty levels in
`lib/beanchallenge/levels.ts`, and the folder is laid out so a **level editor**
can be added later without moving anything.

- **The rules are pure data with no DOM**, like `lib/basic/screen.ts`.
  `step(game, input)` advances one tick and returns a new `Game`; the only timer
  in the game is the interval in `apps/BeanChallenge.tsx`. Same division as Shut
  Down and the theme curtain — the store is synchronous, the view paces it.
- **`startLevel` takes a `Level`, never an index.** That one signature is what
  will let an editor playtest a board it has not saved.
- **Randomness is a seeded PRNG carried in `Game`**, not `Math.random`. Walkers
  and random force floors are therefore reproducible, which is the whole basis
  of the solution test below.
- **A tick is 100 ms; the player moves on odd ticks and monsters on even ones**,
  so both run at five squares a second and one recorded move is two ticks.
- **React never re-renders per tick.** The live `Game` sits in a ref, the
  interval advances it, and a `requestAnimationFrame` loop blits when `version`
  moves. Only the panel's handful of numbers are mirrored into state. The
  player's square is written straight onto the canvas element's dataset — it
  changes nothing visible in the chrome, and it is the only way a jsdom test can
  see the board at all.
- **Every level ends `#.#############` over `#...........SE#`.** The socket has
  to sit in the one square before the exit, at the end of a corridor with a
  single mouth. Anything else lets the player drop into the bottom row past the
  socket and walk out with the beans still on the floor — which is exactly what
  a solver did to eight of these on its first run.
- **Every level carries a recorded `solution`, and the suite replays all thirty.**
  A rule change that makes one unwinnable fails in CI rather than in front of
  someone on level 24. Most were found by a breadth-first search over `step`;
  the walker level needed a greedy rollout, because a walker's turn depends on
  the whole history of the seed and states that look alike are not.
- **A block a level never has to move is scenery, and reads as a puzzle.** The
  five block levels — 2, 4, 6, 8 and 10 — were each checked by freezing one
  block into a wall and re-running the search: if the level is still winnable,
  that block was decoration and the gate it stood in has a way around it. Every
  block in those five is load-bearing, and `tests/beanchallenge.test.ts` keeps
  the cheap half of the check by asserting the recorded run leaves none of them
  on its starting square. `firewalk` and `block-party` still carry blocks that
  fail this and are the obvious next levels to rework.
- **Ice and blocks barely interact, and the levels are drawn accordingly.** A
  block cannot be pushed while sliding, and sliding into one reverses you
  without moving you, so a block on ice is only ever a bounce — never a way to
  stop where you choose. `cold-comfort` and `skate-park` therefore gate their
  slides with blocks standing on solid floor rather than trying to build a
  puzzle out of the pair.
- **`parseLevel` and `formatLevel` are exact inverses**, and `validateLevel` is
  a function rather than a pile of assertions. Both exist for the editor: one is
  how it will save, the other is the warning list it will show while you draw.
  The suite is simply their first caller.
- **Force floors must never form a closed loop, and ice must never form a ring.**
  There is no override move, so a player who enters one never gets a turn back
  and the level becomes unwinnable. `slip-road` is a spiral for this reason.
- Deliberate simplifications, all so the board stays readable: monsters treat
  water and fire as walls rather than dying in them (a bug that read water as
  floor would drown on the first tick and empty the level), only the player
  presses buttons, and blocks do not slide on ice or force floors.

### Adding a level

Append one object to `LEVELS` with a fresh `id`, a `map`, and a `solution` you
have actually played. `id` is what progress is keyed by, so inserting or
reordering levels never disturbs a save. The legend is one table in `tiles.ts`
and both lookup directions are derived from it — add a tile there and the map
character, the palette label and the round-trip all follow.

## Draw

A vector illustration app in the shape of **CorelDRAW**: a toolbox down the left
edge, a fixed-width property panel on the right, a status line naming the
selection, and a page that is a *drawing* rather than a bitmap. Documents are
real `.svg` files in `/boot/home/drawings`.

`lib/draw/` is pure data with no DOM, like `lib/basic/screen.ts` and
`lib/beanchallenge/engine.ts` — which is what puts the entire geometry and file
layer inside the jsdom suite. `types.ts` is the model, `geom.ts` the
measurement and transforms, `ops.ts` every mutation as `(doc, …) => DrawDoc`,
and `svg.ts` the two directions of the file format.

- **The canvas is a live SVG DOM, not a `<canvas>`.** Objects are
  React-rendered `<svg>` children, so saving is serialising the same tree that
  is on screen and there is no second representation to drift. It also means
  **there is no hit-testing code in the app at all**: handles, path nodes and
  bezier grips are real elements carrying `data-handle` / `data-node`, and
  `pointerdown` plus `.closest()` does the whole job. That is the one part of a
  drawing program jsdom can actually test.
- **Rect and ellipse are not paths.** A rectangle has to save as `<rect>` or
  the file is unreadable to anything else and the round trip dies on the first
  save. The node tool therefore cannot touch one, and the answer is
  CorelDRAW's own: *Object → Convert to curves* (`toPath`), which is `Alt+Q`
  and is where an editable path comes from.
- **Geometry is baked; only rotation is a transform.** Moving a rect changes
  `x`/`y`. Rotation stays a `rotation` field emitted as `rotate(deg cx cy)`,
  because baking a rotation into a rect would force it to become a path. The
  parser recognises exactly that one form and restores the field, which is what
  keeps a rotated rect a rect through a save/open cycle.
- **`toSVG` and `parseSVG` are exact inverses**, the same contract
  `formatLevel`/`parseLevel` hold in `lib/beanchallenge/level.ts`. `toSVG` is a
  hand-rolled string emitter rather than `XMLSerializer` so element and
  attribute order are deterministic; every number goes through one 3-decimal
  formatter so a save is byte-stable.
- **A rectangle's `rx` is a corner radius, not a second shape.** The panel
  offers *Corners → Radius* whenever a rect is selected or the rect tool is up,
  and remembers it for the next rectangle drawn. `scaleShape` scales it with
  the shape and `toPath` clamps it to half the shorter side, so a radius larger
  than the rect converts to a stadium rather than a tangled path.
- **A gradient is always relative to the shape's own box**
  (`objectBoundingBox`), never to the page. That is the entire reason it can be
  modelled at all: a box-relative gradient follows its shape through every
  move, resize and rotate for free, so nothing in `geom.ts` knows gradients
  exist. A `LinearGradient` is one angle plus stops; a `RadialGradient` is just
  stops. Strokes are colour-only.
- **`parseSVG` adopts a gradient only if it could write it back identically** —
  box-relative, unit-length, centred on its own axis, two or more opaque stops,
  no `gradientTransform` or `href`. Anything else keeps its `url(#id)` fill and
  its definition in the preamble: it still paints, it still saves, it just
  cannot be edited, and `lossy` says so. Refusing is what keeps the round trip
  exact rather than approximate. The spec's default `(0,0)->(1,0)` *is*
  accepted — it is the same ramp as our own `(0,0.5)->(1,0.5)`, and only the
  direction and the midpoint's projection along it matter.
- **Two gradient traps, both with tests.** Gradient vectors are emitted at
  **six** decimals, not three: the angle is rebuilt with `atan2` on the way
  back in, and at three decimals 37° returns as 37.02 and the drawing drifts a
  little on every save. And an adopted gradient is **removed from the
  preamble**, because it is re-emitted from the model — keeping both would
  stack another copy into the file on every save.
- **Gradient element ids are numbered by position** (`bw-grad-0`, `bw-grad-1`),
  not derived from the shape id, because shape ids are regenerated on every
  parse and `toSVG(parseSVG(s)) === s` has to hold. `gradientDefs` produces the
  `<defs>` markup and **both** `toSVG` and the live `<svg>` render that same
  string, so what is on screen and what is in the file cannot drift.
- **The property panel shows the selection, not the tool.** Selecting a shape
  puts its own fill, outline and corner radius in the panel; the tool keeps
  whatever was last chosen and hands it to the next shape drawn. The properties
  scroll, and Duplicate/Delete are pinned below them — they are actions, not
  properties, and must never scroll out of reach.
- **Nothing a file contains is ever dropped.** What the parser cannot model
  becomes a `foreign` shape holding its own markup, re-emitted verbatim in its
  original place in the paint order; `<defs>`/`<style>` are hoisted to
  `doc.preamble` and written back first, so a `url(#gradient)` fill still
  resolves and still saves. Every approximation is named in `doc.lossy`, and
  the app raises one alert from that list when the file opens. Foreign markup
  is rendered into the page, so `sanitize()` runs first — and it works on the
  **parsed element, not on its serialisation**: it walks the DOM the parser
  already built, drops what executes (`<script>`, `<iframe>`, a SMIL `<set
  attributeName="onload">`), removes every `on*` attribute, and holds URL
  attributes to a scheme allowlist (`https:`, `mailto:`, a raster `data:`;
  never `javascript:`, `vbscript:` or `data:image/svg+xml`). A regex over
  markup has to re-implement the parser to know where a tag ends, and the
  one that used to live here only knew the literal string `javascript:`.
- **A live drag never re-renders.** Same rule as `useWindowGesture`: the
  gesture lives in a ref, a `requestAnimationFrame` writes one attribute, and
  React is touched once on `pointerup`. The rubber band is a single `<path>`
  the gesture mutates. For moving and resizing, the gesture writes `transform`
  on the very `<g data-id>` **React itself owns** — so an interfering render
  restores the correct value and the worst case is a visual jump, never a
  corrupted model. Do not mutate an attribute React does not also control.
- **Screen to document is arithmetic, never `getScreenCTM`.** The `<svg>` is
  sized `doc.width * zoom` over a viewBox of `doc.width`, so one CSS pixel is
  `1/zoom` document units and the scroll offset is already inside
  `getBoundingClientRect()`. jsdom has no `getScreenCTM`, no `getBBox`, no
  `createSVGPoint` and no `elementFromPoint`; under it the rect reads zeros at
  zoom 1, so `toDocPoint` degenerates to raw client coordinates and the tests
  drive the real gesture code with plain numbers. Do not "fix" this with a CTM.
- **Text bounds are estimated, not measured** (0.6 em per character), because
  `getBBox` does not exist under jsdom and a bounding box that depends on the
  environment is the same class of bug as trusting `offsetWidth`. Resizing text
  scales `fontSize` rather than a box, so the error never compounds.
- **`fitPage` runs inside `commit`, not at the call sites.** The page grows to
  hold whatever an edit put outside it, and doing that per call site is how
  move came to be missing it while draw and resize had it — a shape dragged
  past the right edge was clipped against a viewBox that never grew. It only
  grows right and down: the page origin is fixed at 0,0, so a shape dragged
  above or left of it is still clipped. A document arriving from disk goes
  through `adopt`, not `commit`, so opening a file never rewrites the page size
  it was saved with.
- **`dirty` is reference identity** — `doc !== savedDoc` — not a flag. Every op
  returns a new document, so undoing back past the save point clears the
  asterisk by itself. `savedDoc` is seeded with the initial doc, or an untitled
  drawing is born dirty and prompts on close. Undo is a 50-deep stack of
  snapshots in a ref; untouched shapes are shared by reference, so a snapshot
  costs an array.
- Selection is one object at a time, which is what the Arrange menu and the
  property panel are written against. Marquee and multiple selection are the
  obvious next step and nothing here is in their way.
- The drawing surface is **chrome, and is themed**: the page is `--document` on
  a `--panel-darken-2` pasteboard. Only the artwork keeps the user's own
  colours. This is the opposite of Terminal, Tetris and Bean Challenge, which
  are play surfaces with palettes of their own.

`.svg` opens in Draw from Tracker and from Terminal's `draw <file>`, the same
way `.bas` opens in BASIC. `lib/transfer.ts` grew `exportText(name, text, mime)`
so *File → Export SVG…* can hand the browser a drawing that is not on the disk;
`exportNode` is now just its filesystem-node caller.


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
- **Terminal, the BASIC console, the BASIC screen, Tetris and Bean Challenge
  are deliberately not themed.** They are screens and games, not chrome —
  emulated CGA/VGA attributes, a phosphor palette, tetromino colours, a tile
  set. So is `lib/icons.tsx`: R5 icons were full-colour artwork, and a page icon
  is white paper on any desktop.
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

- The key is **entered by the user** and lives in `store/settings.ts` under
  `beanweb.settings.v1`. Never hard-code one, never commit one, never write one
  into the virtual filesystem, and never log it.
- Render it only through `maskKey()`. It must not appear in full anywhere.
- **It is never written in clear text.** `lib/keystore.ts` seals it with AES-GCM
  under a **non-extractable** `CryptoKey` kept in IndexedDB — the browser will
  encrypt and decrypt with that key but will never hand out its bytes — and only
  the ciphertext goes to `localStorage`. The key cannot simply be hashed: every
  request sends it to the API, so it has to come back out.
- **Sealing failing means not persisting, never persisting plainly.** Outside a
  secure context there is no `crypto.subtle`, and some private modes have no
  IndexedDB; `seal()` returns null there and the key lasts the session only.
- **The key is the one setting that is not there on the first tick.** `load()`
  is synchronous, the unseal is not, so `keyReady` resolves once the key has
  been decrypted into the store — `send()` in `apps/Claude.tsx` awaits it before
  concluding there is no key and prompting. Model and theme stay plain text
  because `index.html` reads the theme back before React boots.
- A record still holding a plaintext `apiKey` is from before this and is
  migrated on the next boot: adopted synchronously, then rewritten sealed, which
  is what takes the clear text off the disk.
- The security tradeoff is still real: any script on the page can call `unseal`
  as easily as the store does. Sealing defeats the passive cases — a profile
  dump, a synced backup, the next person at the machine — not a hostile script.
  Acceptable for a local desktop toy, the case the Anthropic docs sanction, and
  **not** acceptable for a public deploy. If this is ever hosted, the app needs
  a server-side proxy first.
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
- `tests/keystore.test.ts` reaches the sealed path through `fake-indexeddb`,
  jsdom having none of its own, and boots a fresh copy of the store module for
  each case because `hydrateKey` runs once at import. It is the only cover for
  the migration.
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

**Draw's marquee and multiple selection.** One object is selected at a time
today. `unionBounds` and `containsBounds` in `lib/draw/geom.ts` are already the
predicates a marquee needs.

**Bean Challenge's level editor.** Not built, but everything it needs is:
`formatLevel` round-trips a board back to text, `formatLevelFile` /
`parseLevelFile` give a level a form StyledEdit can already open (`.bcl`, in the
empty `/boot/home/beanchallenge`), `validateLevel` is the warning list, `packs.ts`
is where a user pack joins the built-in one, `drawTile` is the palette's artwork,
and `replay` is the "verify solvable" button. It should be its own window, and it
will need a `useCloseGuard` — it is the first thing here that holds unsaved work.
