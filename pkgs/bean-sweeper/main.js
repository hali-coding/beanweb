/*
 * Bean Sweeper -- a BeanWeb package.
 *
 * Minesweeper, with beans under the squares. A number is how many of the
 * eight squares around it hide a bean; a flag is a bean you are sure of; the
 * game is won when every square that is *not* a bean has been turned over,
 * which is why the flags are a note to yourself and never the win condition.
 *
 * Plain ES2020 in one file with no build step: a package is whatever is in
 * the zip, and the browser runs this as it stands. Everything it can reach
 * goes through `window.bw`; docs/packages.md is the whole API.
 *
 * Two things this frame cannot do, both on purpose:
 *
 *   - `alert()`, `confirm()` and `prompt()` are blocked. The iframe is
 *     sandboxed with `allow-scripts` and nothing else, so there is no
 *     `allow-modals`. Nothing here needs to ask a question mid-game; the one
 *     thing worth saying out loud -- a best time that could not be written --
 *     goes through `bw.alert`, which resolves the index of a button.
 *   - `fetch()` never leaves. The document carries `connect-src 'none'`, so
 *     the best times are this machine's and there is no board to post them to.
 *
 * The only thing it persists is those times, one small text file in its own
 * folder. That is the whole of what the `fs` permission is asked for.
 */

/** Inside /boot/home/packages/<id>/, the only place we may write. */
const STORE = 'scores.txt'

/*
 * The three classic fields, at their original dimensions and bean counts.
 * `id` is what a best time is keyed by in the file, so it is fixed even if a
 * label changes -- the same reasoning as a Bean Challenge level's id.
 */
const LEVELS = [
  { id: 'beginner', name: 'Beginner', w: 9, h: 9, mines: 10 },
  { id: 'intermediate', name: 'Intermediate', w: 16, h: 16, mines: 40 },
  { id: 'expert', name: 'Expert', w: 30, h: 16, mines: 99 },
]

const HIDDEN = 0
const SHOWN = 1
const FLAG = 2

/*
 * The board is a play surface rather than chrome, so like Tetris and Bean
 * Challenge in BeanWeb proper it keeps a palette of its own. The numbers are
 * the 1990 set -- blue, green, red, navy, maroon, teal, black, grey -- because
 * anyone who has played this reads them without looking at a legend. The bar
 * around the board *is* chrome, and is the R5 panel ramp.
 */
const NUMBER = [
  '',
  '#0000d7',
  '#1a7a1a',
  '#d4382f',
  '#00007a',
  '#7a1a1a',
  '#0e7a7a',
  '#1a1a1a',
  '#6a6a6a',
]

/* --- glyphs -------------------------------------------------------------
 *
 * Drawn rather than typed: an emoji bean is the host font's opinion and is a
 * different picture on every machine, where these are the same square
 * everywhere and sit on the same 32-unit grid habit as the package icon.
 */

const BEAN = `<svg viewBox="0 0 16 16" aria-hidden="true">
  <g transform="rotate(-30 8 8)">
    <ellipse cx="8" cy="8" rx="5.4" ry="4" fill="#8a5a2b" stroke="#3a2410" stroke-width="1"/>
    <path d="M4.2 9.6c1.4-1.7 2.3-3.6 6.6-4.4" fill="none" stroke="#e8dfc6"
          stroke-width="1.2" stroke-linecap="round"/>
  </g>
</svg>`

const FLAGGED = `<svg viewBox="0 0 16 16" aria-hidden="true">
  <path d="M11.6 2.4l-8 3.1 8 3.1z" fill="#d4382f"/>
  <path d="M11.6 2v11.2M7.2 13.4h7.4" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>
</svg>`

const CROSS = `<svg viewBox="0 0 16 16" class="cross" aria-hidden="true">
  <path d="M2.6 2.6l10.8 10.8M13.4 2.6L2.6 13.4" stroke="#d4382f" stroke-width="1.6"
        stroke-linecap="round"/>
</svg>`

/** The reset button's face. It is the only status line the board itself has. */
function faceSvg(kind) {
  const eyes =
    kind === 'lost'
      ? '<path d="M6.5 8.5l3.5 3.5M10 8.5l-3.5 3.5M14 8.5l3.5 3.5M17.5 8.5L14 12" stroke="#3a2410" stroke-width="1.5" stroke-linecap="round" fill="none"/>'
      : kind === 'won'
        ? '<path d="M4.8 9.4h14.4v1.4a3.2 3.2 0 0 1-6.4.4 3.2 3.2 0 0 1-6.4 0 3.2 3.2 0 0 1-1.6-1.8z" fill="#2b2b2b"/>'
        : '<g fill="#3a2410"><circle cx="9" cy="10.4" r="1.4"/><circle cx="15" cy="10.4" r="1.4"/></g>'
  const mouth =
    kind === 'press'
      ? '<circle cx="12" cy="16.2" r="2.1" fill="#3a2410"/>'
      : kind === 'lost'
        ? '<path d="M9 17.6a3.2 3.2 0 0 1 6 0" fill="none" stroke="#3a2410" stroke-width="1.5" stroke-linecap="round"/>'
        : '<path d="M8.8 15.2a3.4 3.4 0 0 0 6.4 0" fill="none" stroke="#3a2410" stroke-width="1.5" stroke-linecap="round"/>'
  return `<svg viewBox="0 0 24 24" aria-hidden="true">
    <ellipse cx="12" cy="12" rx="9.6" ry="8.2" fill="#e0b76e" stroke="#3a2410" stroke-width="1.4"/>
    ${eyes}${mouth}</svg>`
}

/* --- markup and style ---------------------------------------------------
 *
 * The frame is a bare document with none of BeanWeb's CSS in it, so a package
 * draws its own chrome. These greys are the R5 panel ramp; the real ones and
 * the tint_color() arithmetic behind them are in src/styles/tokens.css.
 */

document.body.innerHTML = [
  '<div class="bar">',
  '  <select id="level" title="Field size"></select>',
  '  <button id="mark" aria-pressed="false" title="Mark squares instead of turning them over">Flag</button>',
  '  <span class="spacer"></span>',
  '  <span class="best">Best <b id="best">--</b></span>',
  '</div>',
  '<div class="stage">',
  '  <div class="frame">',
  '    <div class="head">',
  '      <span class="led" id="beans">010</span>',
  '      <button class="face" id="face" title="New game"></button>',
  '      <span class="led" id="clock">000</span>',
  '    </div>',
  '    <div class="grid" id="grid" tabindex="0"></div>',
  '  </div>',
  '</div>',
].join('')

const style = document.createElement('style')
style.textContent = `
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; overflow: hidden;
       font: 12px/15px system-ui, sans-serif; color: #000; background: #d8d8d8;
       -webkit-user-select: none; user-select: none; }

.bar { display: flex; align-items: center; gap: 8px; padding: 5px 8px; flex: none;
       border-bottom: 1px solid #979797; }
.spacer { margin-left: auto; }
.best { color: #565656; white-space: nowrap; }
.best b { color: #000; font-variant-numeric: tabular-nums; }

button, select { font: inherit; padding: 2px 10px; background: #d8d8d8; color: #000;
                 border: 1px solid #979797; border-radius: 3px;
                 box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #b0b0b0; }
button:active { box-shadow: inset 1px 1px 0 #b0b0b0; }
button[aria-pressed="true"] { background: #c6c6c6;
                              box-shadow: inset 1px 1px 0 #b0b0b0, inset -1px -1px 0 #fff; }
button:focus-visible, select:focus-visible { outline: 2px solid #0000e5; outline-offset: 1px; }

/* The board is centred and the stage scrolls: an Expert field is 30 squares
   across and there is no bridge verb for resizing our own window. */
.stage { flex: 1; min-height: 0; overflow: auto; padding: 10px; display: flex; }
/* An auto margin rather than align-items: center, which on a board bigger
   than the stage would push the top out of reach of the scrollbar. */
.frame { margin: auto; padding: 5px; background: #d8d8d8; flex: none;
         box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #979797; }

.head { display: flex; align-items: center; justify-content: space-between;
        padding: 4px 5px; margin-bottom: 5px;
        box-shadow: inset 1px 1px 0 #979797, inset -1px -1px 0 #fff; }
.led { font: bold 15px/17px ui-monospace, monospace; letter-spacing: 1px;
       padding: 1px 4px; color: #ff3b30; background: #1a1a1a;
       font-variant-numeric: tabular-nums; }
.face { width: 28px; height: 28px; padding: 0; display: grid; place-items: center; }
.face svg { width: 22px; height: 22px; display: block; }

/* The board takes focus, and that is not decoration: the host does not focus
   a package's frame, so until something in here holds focus a keystroke goes
   to the desktop and F2 never arrives. The tabindex is the whole mechanism --
   the browser's own mousedown default focuses it, where BeanWeb's Terminal
   needs an explicit focus() because its own root is not focusable. */
.grid:focus { outline: none; }
.grid:focus-visible { outline: 2px solid #0000e5; outline-offset: 2px; }

/* --cell is the one place a square's size is written, so (pointer: coarse)
   grows the whole board the way BeanWeb's own media query grows its hit
   targets. The column count is the only thing set from JavaScript. */
.grid { --cell: 18px; display: grid; gap: 0;
        box-shadow: inset 1px 1px 0 #979797, inset -1px -1px 0 #fff; padding: 3px; }
@media (pointer: coarse) { .grid { --cell: 24px; } }

/* The bevel is 2px where every widget in BeanWeb proper is one device pixel:
   raised-against-flat is what a player scans a board by, and at a hairline it
   disappears into the numbers. A game keeps its own metrics for the same
   reason it keeps its own palette. */
.cell { width: var(--cell); height: var(--cell); padding: 0; margin: 0;
        display: grid; place-items: center; background: #d8d8d8;
        font: bold calc(var(--cell) * 0.62)/1 ui-monospace, monospace;
        box-shadow: inset 2px 2px 0 #fff, inset -2px -2px 0 #9d9d9d; }
/* All in one grid area: a wrong flag is crossed where it stands, which means
   the flag and the cross are two glyphs in the same square. */
.cell svg { width: 92%; height: 92%; display: block; grid-area: 1 / 1; }
.cell.shown { background: #cfcfcf; box-shadow: inset 1px 1px 0 #a4a4a4; }
.cell.boom { background: #d4382f; }
.cell .cross { width: 100%; height: 100%; }
`
document.head.appendChild(style)

const el = (id) => document.getElementById(id)
const gridEl = el('grid')

/* --- the game -----------------------------------------------------------
 *
 * One plain object rebuilt by `newGame`, mutated by the click handlers, read
 * by `paintCell`. No state lives anywhere else, so starting over is one
 * assignment and there is nothing to leak between games.
 */

let level = LEVELS[0]
let game = null
let marking = false
let best = {}
let timer = 0

function newGame() {
  const n = level.w * level.h
  game = {
    bean: new Uint8Array(n),
    adj: new Uint8Array(n),
    state: new Uint8Array(n),
    cells: [],
    laid: false, // beans are placed on the first click, not before it
    over: false,
    won: false,
    boom: -1,
    shown: 0,
    flags: 0,
    t0: 0,
    elapsed: 0,
  }

  gridEl.style.gridTemplateColumns = `repeat(${level.w}, var(--cell))`
  gridEl.replaceChildren()
  const frag = document.createDocumentFragment()
  for (let i = 0; i < n; i++) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    cell.dataset.i = String(i)
    game.cells.push(cell)
    frag.appendChild(cell)
  }
  gridEl.appendChild(frag)

  stopClock()
  setFace('idle')
  paintHead()
}

/** The eight squares around `i`, bounds-checked. */
function around(i) {
  const x = i % level.w
  const y = (i / level.w) | 0
  const out = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) continue
      out.push(ny * level.w + nx)
    }
  }
  return out
}

/*
 * Beans are laid after the first click, never before it, which is what makes
 * that click safe. The square itself *and its eight neighbours* are kept
 * clear so the first turn always opens a region rather than a lone `1` --
 * unless the field is too crowded to allow it, which no built-in level is.
 */
function layBeans(first) {
  const n = level.w * level.h
  const safe = new Set([first])
  if (level.mines <= n - 9) for (const j of around(first)) safe.add(j)

  let left = level.mines
  while (left > 0) {
    const i = Math.floor(Math.random() * n)
    if (game.bean[i] || safe.has(i)) continue
    game.bean[i] = 1
    left--
  }
  for (let i = 0; i < n; i++) {
    let count = 0
    for (const j of around(i)) count += game.bean[j]
    game.adj[i] = count
  }
  game.laid = true
}

/*
 * A queue rather than recursion, for the reason BeanWeb's own PAINT keeps an
 * explicit stack: an Expert field opened on its first click is a thousand
 * squares deep and the browser is under no obligation to have the frames.
 */
function reveal(start) {
  const queue = [start]
  while (queue.length) {
    const i = queue.pop()
    if (game.state[i] !== HIDDEN) continue
    game.state[i] = SHOWN
    if (!game.bean[i]) game.shown++
    paintCell(i)
    if (!game.bean[i] && game.adj[i] === 0) {
      for (const j of around(i)) if (game.state[j] === HIDDEN) queue.push(j)
    }
  }
}

/*
 * Not named `open`: a top-level function declaration in a classic script
 * becomes a property of the global object, and this entry *is* a classic
 * script -- `open` would replace `window.open` for the life of the frame.
 */
function openCell(i) {
  if (game.over || game.state[i] !== HIDDEN) return
  if (!game.laid) {
    layBeans(i)
    startClock()
  }
  if (game.bean[i]) {
    game.boom = i
    return lose()
  }
  reveal(i)
  paintHead()
  checkWin()
}

/** Classic chording: a satisfied number opens everything it is not flagging. */
function chord(i) {
  if (game.over || game.state[i] !== SHOWN || !game.adj[i]) return
  const neighbours = around(i)
  let flags = 0
  for (const j of neighbours) if (game.state[j] === FLAG) flags++
  if (flags !== game.adj[i]) return
  for (const j of neighbours) {
    if (game.state[j] !== HIDDEN) continue
    // A wrong flag loses the game here, exactly as it did in 1990: the chord
    // is trusting the flags, and trusting a wrong one is the mistake.
    if (game.bean[j]) {
      game.boom = j
      game.state[j] = SHOWN
      return lose()
    }
    reveal(j)
  }
  paintHead()
  checkWin()
}

function flag(i) {
  if (game.over || game.state[i] === SHOWN) return
  if (game.state[i] === FLAG) {
    game.state[i] = HIDDEN
    game.flags--
  } else {
    game.state[i] = FLAG
    game.flags++
  }
  paintCell(i)
  paintHead()
}

function checkWin() {
  if (game.over || game.shown !== level.w * level.h - level.mines) return
  game.over = true
  game.won = true
  stopClock()
  // Flag whatever is left, so the counter reads zero and the board is tidy.
  for (let i = 0; i < game.bean.length; i++) {
    if (game.bean[i] && game.state[i] !== FLAG) {
      game.state[i] = FLAG
      game.flags++
      paintCell(i)
    }
  }
  setFace('won')
  paintHead()
  recordBest(game.elapsed)
}

function lose() {
  game.over = true
  stopClock()
  for (let i = 0; i < game.bean.length; i++) {
    if (game.bean[i] && game.state[i] !== FLAG) game.state[i] = SHOWN
    paintCell(i)
  }
  setFace('lost')
  paintHead()
}

/* --- painting -------------------------------------------------------------
 *
 * One square at a time. A whole-board repaint on every click would be 480
 * elements rewritten to change one of them, which is the same waste as
 * re-rendering React on a window drag.
 */

function paintCell(i) {
  const cell = game.cells[i]
  const state = game.state[i]

  if (state === FLAG) {
    // A flag left on a square that held no bean is crossed out once the game
    // is lost -- the board's own account of where the reading went wrong.
    const wrong = game.over && !game.won && !game.bean[i]
    cell.className = wrong ? 'cell shown' : 'cell'
    cell.style.color = ''
    cell.innerHTML = FLAGGED + (wrong ? CROSS : '')
    return
  }
  if (state === HIDDEN) {
    cell.className = 'cell'
    cell.style.color = ''
    cell.innerHTML = ''
    return
  }
  if (game.bean[i]) {
    cell.className = i === game.boom ? 'cell shown boom' : 'cell shown'
    cell.style.color = ''
    cell.innerHTML = BEAN
    return
  }
  cell.className = 'cell shown'
  cell.style.color = NUMBER[game.adj[i]]
  cell.textContent = game.adj[i] ? String(game.adj[i]) : ''
}

/** Three digits, the way the original's counters were, and negative-aware. */
function led(n) {
  if (n < 0) return '-' + String(Math.min(99, -n)).padStart(2, '0')
  return String(Math.min(999, n)).padStart(3, '0')
}

function paintHead() {
  el('beans').textContent = led(level.mines - game.flags)
  el('clock').textContent = led(game.elapsed)
  const time = best[level.id]
  el('best').textContent = time ? `${time}s` : '--'
}

function setFace(kind) {
  el('face').innerHTML = faceSvg(kind)
}

/* --- the clock ----------------------------------------------------------
 *
 * Started by the first click and stopped by the end of the game, so a board
 * sitting untouched is not being timed. It ticks faster than it displays and
 * repaints only when the whole second moves.
 */

function startClock() {
  game.t0 = Date.now()
  timer = setInterval(() => {
    const now = Math.min(999, Math.floor((Date.now() - game.t0) / 1000))
    if (now === game.elapsed) return
    game.elapsed = now
    el('clock').textContent = led(now)
  }, 200)
}

function stopClock() {
  if (timer) clearInterval(timer)
  timer = 0
}

/* --- input --------------------------------------------------------------
 *
 * Delegated to the grid: one listener rather than one per square, which for
 * an Expert field is 480 handlers saved.
 */

function indexOfEvent(ev) {
  const cell = ev.target.closest ? ev.target.closest('.cell') : null
  return cell ? Number(cell.dataset.i) : -1
}

gridEl.addEventListener('click', (ev) => {
  const i = indexOfEvent(ev)
  if (i < 0) return
  if (marking) return flag(i)
  if (game.state[i] === SHOWN) return chord(i)
  openCell(i)
})

/*
 * Right-click flags. The event never leaves this frame -- the desktop's own
 * context menus are wired in the host document, not in here -- so the default
 * to suppress is the browser's, and suppressing it is what lets the second
 * button mean something in a game that has always used it.
 */
gridEl.addEventListener('contextmenu', (ev) => {
  ev.preventDefault()
  const i = indexOfEvent(ev)
  if (i >= 0) flag(i)
})

/* Middle-click is the other way to chord, for anyone who learned it there. */
gridEl.addEventListener('auxclick', (ev) => {
  if (ev.button !== 1) return
  ev.preventDefault()
  const i = indexOfEvent(ev)
  if (i >= 0) chord(i)
})

/* The face reacts while a square is held down, which is the only feedback
   the original ever gave and is most of why it felt alive. */
gridEl.addEventListener('pointerdown', (ev) => {
  if (!game || game.over || ev.button !== 0 || marking) return
  setFace('press')
})
window.addEventListener('pointerup', () => {
  if (game && !game.over) setFace('idle')
})

el('face').addEventListener('click', () => newGame())

el('mark').addEventListener('click', () => {
  marking = !marking
  el('mark').setAttribute('aria-pressed', String(marking))
})

el('level').addEventListener('change', () => {
  level = LEVELS[Number(el('level').value)] || LEVELS[0]
  newGame()
})

/* On `window`, so it hears the board, the toolbar and the level menu alike --
   what it cannot hear is a keystroke sent while this frame has no focus. */
window.addEventListener('keydown', (ev) => {
  // R5 used Alt where other systems use Ctrl, and BeanWeb keeps that. F2 is
  // here as well for the same reason BASIC keeps F5: it is this game's own
  // key, and the app is imitating the game rather than the Tracker.
  if (ev.key === 'F2' || (ev.altKey && ev.key.toLowerCase() === 'n')) {
    ev.preventDefault()
    newGame()
  }
  // Holding a modifier-free F toggles marking, so a trackpad with no second
  // button can still play without reaching for the toolbar.
  const onMenu = ev.target && ev.target.tagName === 'SELECT'
  if (!onMenu && !ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === 'f') {
    ev.preventDefault()
    el('mark').click()
  }
})

/* --- the best times -------------------------------------------------------
 *
 * A relative path is resolved inside the package folder and refused if it
 * lands anywhere else, so `../` buys nothing here. Written as text rather
 * than JSON so the file reads as itself in StyledEdit.
 */

async function loadBest() {
  try {
    const text = await bw.fs.read(STORE)
    if (!text) return
    for (const line of text.split('\n')) {
      const found = /^([a-z]+)\s+(\d+)/.exec(line.trim())
      if (found && LEVELS.some((l) => l.id === found[1])) best[found[1]] = Number(found[2])
    }
  } catch (err) {
    // A missing file reads as null; anything else is not worth refusing to
    // start a game over.
    best = {}
  }
}

async function recordBest(seconds) {
  /*
   * Floored at a second rather than refused at zero: a first click that opens
   * the whole board wins a Beginner field outright, and that game is a real
   * win with a real time -- dropping it because the clock had not moved yet
   * is the same reading of `0` as "nothing happened" that the counter avoids.
   */
  const time = Math.max(1, seconds)
  if (best[level.id] && best[level.id] <= time) return
  best[level.id] = time
  paintHead()
  const body = LEVELS.filter((l) => best[l.id]).map((l) => `${l.id} ${best[l.id]}`)
  try {
    await bw.fs.write(STORE, `Bean Sweeper\n${body.join('\n')}\n`)
  } catch (err) {
    await bw.alert(`Could not save the best time.\n\n${(err && err.message) || err}`, 'stop')
  }
}

/* --- boot ---------------------------------------------------------------- */

async function boot() {
  /*
   * `ready` is the first call every package makes. It names the package, the
   * folder it may write to, and the document it was opened on -- null here,
   * since this one claims no file type.
   */
  await bw.ready()
  await bw.setTitle('Bean Sweeper')

  el('level').replaceChildren()
  LEVELS.forEach((l, i) => {
    const option = document.createElement('option')
    option.value = String(i)
    option.textContent = `${l.name}  ${l.w}x${l.h}, ${l.mines} beans`
    el('level').appendChild(option)
  })

  await loadBest()
  newGame()
}

boot().catch((err) => {
  document.body.textContent = String((err && err.message) || err)
})
