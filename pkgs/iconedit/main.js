/*
 * IconEdit -- a pixel editor for BeanWeb icons, and the worked example of a
 * BeanWeb package.
 *
 * Plain ES2020 in one file. There is no build step and no framework on
 * purpose: a package is whatever you put in the zip, and the smallest honest
 * demonstration of that is a file the browser can run as it stands.
 *
 * Everything it touches goes through `window.bw`. It has no access to the
 * desktop's storage, cannot reach the network, and cannot open a native
 * `alert()` or `prompt()` -- an iframe sandboxed with `allow-scripts` alone
 * has no `allow-modals`, which is why the name prompt and the file list below
 * are drawn by hand and confirmations go through `bw.alert`.
 */

const SIZE_DEFAULT = 32
const TRANSPARENT = 255
const UNDO_DEPTH = 40

/*
 * The palette is part of the file format: a `.bicon` stores an index per
 * pixel, so these sixteen entries are what the digits mean. Appending is safe;
 * reordering silently recolours every icon ever saved.
 */
const PALETTE = [
  '#000000', '#ffffff', '#808080', '#c0c0c0',
  '#404040', '#e2504a', '#ff9c00', '#ffc900',
  '#6fae5a', '#2f7d32', '#4a7fd4', '#29487d',
  '#8f5fbf', '#d47fa8', '#8a6642', '#336698',
]

const DIGITS = '0123456789abcdef'
const TOOLS = ['pencil', 'eraser', 'fill', 'pick']

/* --- the document ------------------------------------------------------- */

const doc = {
  size: SIZE_DEFAULT,
  pixels: new Uint8Array(SIZE_DEFAULT * SIZE_DEFAULT).fill(TRANSPARENT),
  path: null,
  name: 'Untitled.bicon',
  dirty: false,
}

let tool = 'pencil'
let colour = 0
let undo = []

const clone = () => ({ size: doc.size, pixels: doc.pixels.slice() })

function pushUndo() {
  undo.push(clone())
  if (undo.length > UNDO_DEPTH) undo.shift()
}

function markDirty(value) {
  doc.dirty = value
  paintStatus()
}

/* --- the file format ----------------------------------------------------
 * `beanicon 1 <size>` then one line per row, one character per pixel: a hex
 * digit indexes the palette and `.` is transparent. Text, so a `.bicon` opens
 * in StyledEdit and reads as a picture of itself.
 */

function serialise() {
  const lines = [`beanicon 1 ${doc.size}`]
  for (let y = 0; y < doc.size; y++) {
    let row = ''
    for (let x = 0; x < doc.size; x++) {
      const v = doc.pixels[y * doc.size + x]
      row += v === TRANSPARENT ? '.' : DIGITS[v]
    }
    lines.push(row)
  }
  return lines.join('\n') + '\n'
}

function parse(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const header = /^beanicon\s+1\s+(\d+)$/.exec(lines[0] || '')
  if (!header) throw new Error('That is not a .bicon file.')

  const size = Number(header[1])
  if (size < 4 || size > 64) throw new Error(`A ${size}-pixel icon is out of range.`)

  const pixels = new Uint8Array(size * size).fill(TRANSPARENT)
  for (let y = 0; y < size; y++) {
    const row = lines[y + 1] || ''
    for (let x = 0; x < size; x++) {
      const ch = row[x]
      if (!ch || ch === '.') continue
      const index = DIGITS.indexOf(ch.toLowerCase())
      if (index >= 0) pixels[y * size + x] = index
    }
  }
  return { size, pixels }
}

/** The icon as an SVG of one rect per opaque pixel, for opening it in Draw. */
function toSvg() {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.size} ${doc.size}" width="${doc.size * 8}" height="${doc.size * 8}">`,
  ]
  for (let y = 0; y < doc.size; y++) {
    for (let x = 0; x < doc.size; x++) {
      const v = doc.pixels[y * doc.size + x]
      if (v === TRANSPARENT) continue
      parts.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${PALETTE[v]}"/>`)
    }
  }
  parts.push('</svg>')
  return parts.join('\n') + '\n'
}

/* --- chrome ------------------------------------------------------------- */

document.body.innerHTML = `
<div class="ie">
  <div class="ie-bar">
    <button data-act="new">New</button>
    <button data-act="open">Open…</button>
    <button data-act="save">Save</button>
    <button data-act="saveas">Save As…</button>
    <button data-act="svg">Export SVG</button>
    <span class="ie-gap"></span>
    <button data-act="undo">Undo</button>
    <select data-act="size"><option value="16">16×16</option><option value="32" selected>32×32</option></select>
  </div>
  <div class="ie-main">
    <div class="ie-tools">
      ${TOOLS.map((t) => `<button data-tool="${t}">${t}</button>`).join('')}
    </div>
    <div class="ie-stage"><canvas class="ie-canvas"></canvas></div>
    <div class="ie-side">
      <div class="ie-palette">
        <button class="ie-swatch" data-colour="t" title="transparent"></button>
        ${PALETTE.map((c, i) => `<button class="ie-swatch" data-colour="${i}" style="background:${c}" title="${c}"></button>`).join('')}
      </div>
      <div class="ie-previews">
        <canvas class="ie-preview" width="32" height="32"></canvas>
        <canvas class="ie-preview ie-preview--small" width="16" height="16"></canvas>
      </div>
    </div>
  </div>
  <div class="ie-status"></div>
</div>
<div class="ie-modal" hidden><div class="ie-sheet"></div></div>`

const style = document.createElement('style')
style.textContent = `
* { box-sizing: border-box; }
body { margin: 0; height: 100%; background: #d8d8d8; color: #000;
       font: 12px/15px "Segoe UI", system-ui, sans-serif; user-select: none; }
.ie { display: flex; flex-direction: column; height: 100%; }
.ie-bar { display: flex; align-items: center; gap: 4px; padding: 6px;
          background: #d8d8d8; box-shadow: inset 0 -1px 0 #a8a8a8; }
.ie-gap { flex: 1 1 auto; }
button, select { font: inherit; padding: 2px 8px; background: #d8d8d8; color: #000;
  border: 1px solid #6e6e6e; border-radius: 3px;
  box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #a8a8a8; }
button:active { box-shadow: inset 1px 1px 0 #a8a8a8, inset -1px -1px 0 #fff; }
button[aria-pressed="true"] { background: #c0c0c0;
  box-shadow: inset 1px 1px 0 #a8a8a8, inset -1px -1px 0 #fff; }
button:disabled { color: #8a8a8a; }
.ie-main { flex: 1 1 auto; min-height: 0; display: flex; gap: 8px; padding: 8px; }
.ie-tools { display: flex; flex-direction: column; gap: 4px; }
.ie-tools button { text-transform: capitalize; }
.ie-stage { flex: 1 1 auto; min-width: 0; display: flex; align-items: center;
            justify-content: center; background: #b0b0b0;
            box-shadow: inset 1px 1px 0 #a8a8a8, inset -1px -1px 0 #fff; }
.ie-canvas { image-rendering: pixelated; cursor: crosshair; touch-action: none; }
.ie-side { width: 104px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.ie-palette { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; }
.ie-swatch { height: 22px; padding: 0; border: 1px solid #6e6e6e; box-shadow: none; }
.ie-swatch[data-colour="t"] {
  background-image: linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%),
                    linear-gradient(45deg,#bbb 25%,#fff 25%,#fff 75%,#bbb 75%);
  background-size: 8px 8px; background-position: 0 0, 4px 4px; }
.ie-swatch[aria-pressed="true"] { outline: 2px solid #0000e5; outline-offset: 1px; }
.ie-previews { display: flex; align-items: flex-end; gap: 8px; }
.ie-preview { image-rendering: pixelated; width: 32px; height: 32px; background: #fff;
              border: 1px solid #a8a8a8; }
.ie-preview--small { width: 16px; height: 16px; }
.ie-status { flex: none; padding: 4px 8px; background: #d8d8d8;
             box-shadow: inset 0 1px 0 #a8a8a8; color: #4a4a4a;
             font-family: Consolas, "DejaVu Sans Mono", monospace; }
.ie-modal { position: fixed; inset: 0; background: rgba(0,0,0,.3);
            display: flex; align-items: center; justify-content: center; }
.ie-modal[hidden] { display: none; }
.ie-sheet { min-width: 260px; max-width: 90%; max-height: 80%; overflow: auto;
            padding: 12px; background: #d8d8d8; border: 1px solid #6e6e6e;
            box-shadow: inset 1px 1px 0 #fff, 2px 2px 6px rgba(0,0,0,.3); }
.ie-sheet h2 { margin: 0 0 8px; font-size: 12px; }
.ie-sheet input { width: 100%; font: inherit; padding: 3px 5px; margin-bottom: 10px;
  border: 1px solid #6e6e6e; box-shadow: inset 1px 1px 0 #a8a8a8; background: #fff; }
.ie-sheet ul { list-style: none; margin: 0 0 10px; padding: 0; background: #fff;
               border: 1px solid #6e6e6e; max-height: 180px; overflow: auto; }
.ie-sheet li { padding: 3px 6px; cursor: default; }
.ie-sheet li[aria-selected="true"] { background: #aab8d6; }
.ie-sheet-buttons { display: flex; justify-content: flex-end; gap: 6px; }`
document.head.appendChild(style)

const $ = (sel) => document.querySelector(sel)
const canvas = $('.ie-canvas')
const ctx = canvas.getContext('2d')
const stage = $('.ie-stage')
const modal = $('.ie-modal')
const sheet = $('.ie-sheet')

/* --- painting ------------------------------------------------------------ */

let cell = 8

function layout() {
  const pad = 8
  const w = Math.max(stage.clientWidth - pad, 32)
  const h = Math.max(stage.clientHeight - pad, 32)
  cell = Math.max(2, Math.floor(Math.min(w, h) / doc.size))
  canvas.width = canvas.height = doc.size * cell
  paint()
}

function paint() {
  const px = doc.size * cell
  // The chequerboard shows through wherever a pixel is transparent.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = '#e0e0e0'
  const check = Math.max(cell, 4)
  for (let y = 0; y * check < px; y++) {
    for (let x = 0; x * check < px; x++) {
      if ((x + y) % 2) ctx.fillRect(x * check, y * check, check, check)
    }
  }

  for (let y = 0; y < doc.size; y++) {
    for (let x = 0; x < doc.size; x++) {
      const v = doc.pixels[y * doc.size + x]
      if (v === TRANSPARENT) continue
      ctx.fillStyle = PALETTE[v]
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }

  // Grid lines only when a cell is big enough for them not to be the picture.
  if (cell >= 6) {
    ctx.strokeStyle = 'rgba(0,0,0,.12)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 1; i < doc.size; i++) {
      ctx.moveTo(i * cell + 0.5, 0)
      ctx.lineTo(i * cell + 0.5, px)
      ctx.moveTo(0, i * cell + 0.5)
      ctx.lineTo(px, i * cell + 0.5)
    }
    ctx.stroke()
  }

  paintPreviews()
}

function paintPreviews() {
  for (const el of document.querySelectorAll('.ie-preview')) {
    const c = el.getContext('2d')
    c.clearRect(0, 0, el.width, el.height)
    const s = el.width / doc.size
    for (let y = 0; y < doc.size; y++) {
      for (let x = 0; x < doc.size; x++) {
        const v = doc.pixels[y * doc.size + x]
        if (v === TRANSPARENT) continue
        c.fillStyle = PALETTE[v]
        c.fillRect(x * s, y * s, Math.ceil(s), Math.ceil(s))
      }
    }
  }
}

function paintStatus() {
  $('.ie-status').textContent =
    `${doc.dirty ? '*' : ''}${doc.name}  ·  ${doc.size}×${doc.size}  ·  ${tool}` +
    `  ·  ${colour === 't' ? 'transparent' : PALETTE[colour]}`
}

/* --- editing -------------------------------------------------------------- */

function setPixel(x, y, value) {
  if (x < 0 || y < 0 || x >= doc.size || y >= doc.size) return false
  const at = y * doc.size + x
  if (doc.pixels[at] === value) return false
  doc.pixels[at] = value
  return true
}

/** Flood fill with an explicit stack -- the recursive one overflows on 32×32. */
function flood(x, y, value) {
  const target = doc.pixels[y * doc.size + x]
  if (target === value) return
  const stack = [[x, y]]
  while (stack.length) {
    const [cx, cy] = stack.pop()
    if (cx < 0 || cy < 0 || cx >= doc.size || cy >= doc.size) continue
    const at = cy * doc.size + cx
    if (doc.pixels[at] !== target) continue
    doc.pixels[at] = value
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
  }
}

function apply(x, y, first) {
  if (tool === 'pick') {
    const v = doc.pixels[y * doc.size + x]
    selectColour(v === TRANSPARENT ? 't' : v)
    return
  }
  if (tool === 'fill') {
    if (!first) return
    pushUndo()
    flood(x, y, colour === 't' ? TRANSPARENT : colour)
    markDirty(true)
    paint()
    return
  }
  const value = tool === 'eraser' || colour === 't' ? TRANSPARENT : colour
  if (first) pushUndo()
  if (setPixel(x, y, value)) {
    markDirty(true)
    paint()
  }
}

let drawing = false

function cellAt(event) {
  const rect = canvas.getBoundingClientRect()
  return [
    Math.floor((event.clientX - rect.left) / cell),
    Math.floor((event.clientY - rect.top) / cell),
  ]
}

canvas.addEventListener('pointerdown', (e) => {
  drawing = true
  canvas.setPointerCapture(e.pointerId)
  const [x, y] = cellAt(e)
  apply(x, y, true)
})
canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return
  const [x, y] = cellAt(e)
  apply(x, y, false)
})
canvas.addEventListener('pointerup', () => {
  drawing = false
})

/* --- controls ------------------------------------------------------------ */

function selectTool(next) {
  tool = next
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === next))
  }
  paintStatus()
}

function selectColour(next) {
  colour = next === 't' ? 't' : Number(next)
  for (const b of document.querySelectorAll('[data-colour]')) {
    b.setAttribute('aria-pressed', String(b.dataset.colour === String(next)))
  }
  paintStatus()
}

for (const b of document.querySelectorAll('[data-tool]')) {
  b.addEventListener('click', () => selectTool(b.dataset.tool))
}
for (const b of document.querySelectorAll('[data-colour]')) {
  b.addEventListener('click', () => selectColour(b.dataset.colour))
}

$('[data-act="size"]').addEventListener('change', (e) => {
  const size = Number(e.target.value)
  if (size === doc.size) return
  pushUndo()
  // Resizing keeps the top-left corner rather than scaling: an icon is drawn
  // pixel by pixel, and interpolating one is never what you meant.
  const next = new Uint8Array(size * size).fill(TRANSPARENT)
  const n = Math.min(size, doc.size)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) next[y * size + x] = doc.pixels[y * doc.size + x]
  }
  doc.size = size
  doc.pixels = next
  markDirty(true)
  layout()
})

/* --- the modal sheets ----------------------------------------------------
 * A sandboxed frame has no `allow-modals`, so `prompt()` and `confirm()` are
 * blocked outright. Anything that needs an answer is drawn here, and anything
 * that needs the *desktop's* attention goes through `bw.alert`.
 */

function sheetPrompt(title, value) {
  return new Promise((resolve) => {
    sheet.innerHTML = `<h2></h2><input type="text"><div class="ie-sheet-buttons">
      <button data-x="cancel">Cancel</button><button data-x="ok">OK</button></div>`
    sheet.querySelector('h2').textContent = title
    const input = sheet.querySelector('input')
    input.value = value
    modal.hidden = false
    input.focus()
    input.select()

    const done = (result) => {
      modal.hidden = true
      resolve(result)
    }
    sheet.querySelector('[data-x="ok"]').onclick = () => done(input.value.trim() || null)
    sheet.querySelector('[data-x="cancel"]').onclick = () => done(null)
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null)
      if (e.key === 'Escape') done(null)
    }
  })
}

function sheetPick(title, names) {
  return new Promise((resolve) => {
    sheet.innerHTML = `<h2></h2><ul></ul><div class="ie-sheet-buttons">
      <button data-x="cancel">Cancel</button><button data-x="ok">Open</button></div>`
    sheet.querySelector('h2').textContent = title
    const list = sheet.querySelector('ul')
    let chosen = names[0] ?? null

    for (const name of names) {
      const li = document.createElement('li')
      li.textContent = name
      li.setAttribute('aria-selected', String(name === chosen))
      li.onclick = () => {
        chosen = name
        for (const other of list.children) {
          other.setAttribute('aria-selected', String(other === li))
        }
      }
      li.ondblclick = () => done(name)
      list.appendChild(li)
    }

    modal.hidden = false
    const done = (result) => {
      modal.hidden = true
      resolve(result)
    }
    sheet.querySelector('[data-x="ok"]').onclick = () => done(chosen)
    sheet.querySelector('[data-x="cancel"]').onclick = () => done(null)
  })
}

/* --- files ---------------------------------------------------------------- */

/** Ask before throwing away unsaved work. `bw.alert` resolves a button index. */
async function confirmDiscard() {
  if (!doc.dirty) return true
  const answer = await bw.alert(`Discard the changes to ${doc.name}?`, 'warn', ['Cancel', 'Discard'])
  return answer === 1
}

async function actNew() {
  if (!(await confirmDiscard())) return
  pushUndo()
  doc.pixels = new Uint8Array(doc.size * doc.size).fill(TRANSPARENT)
  doc.path = null
  doc.name = 'Untitled.bicon'
  markDirty(false)
  paint()
}

async function actOpen() {
  if (!(await confirmDiscard())) return
  const names = (await bw.fs.list('.')).filter((n) => n.toLowerCase().endsWith('.bicon')).sort()
  if (!names.length) {
    await bw.alert('There are no .bicon files saved yet.', 'info')
    return
  }
  const name = await sheetPick('Open icon', names)
  if (!name) return
  await load(name, name)
}

async function load(path, name) {
  try {
    const text = await bw.fs.read(path)
    if (text === null) throw new Error(`${name} is not there any more.`)
    const parsed = parse(text)
    doc.size = parsed.size
    doc.pixels = parsed.pixels
    doc.path = path
    doc.name = name
    undo = []
    $('[data-act="size"]').value = String(doc.size === 16 ? 16 : 32)
    markDirty(false)
    layout()
  } catch (err) {
    await bw.alert(`Could not open ${name}.\n\n${err.message}`, 'stop')
  }
}

async function actSave(forceName) {
  let path = doc.path
  let name = doc.name
  if (!path || forceName) {
    const typed = await sheetPrompt('Save icon as', doc.name)
    if (!typed) return false
    name = typed.toLowerCase().endsWith('.bicon') ? typed : `${typed}.bicon`
    path = name
  }
  try {
    await bw.fs.write(path, serialise())
    doc.path = path
    doc.name = name
    markDirty(false)
    return true
  } catch (err) {
    await bw.alert(`Could not save.\n\n${err.message}`, 'stop')
    return false
  }
}

async function actExportSvg() {
  const base = doc.name.replace(/\.bicon$/i, '') || 'icon'
  try {
    await bw.fs.write(`${base}.svg`, toSvg())
    await bw.alert(`Wrote ${base}.svg beside the icon. Open it from Tracker to edit it in Draw.`, 'info')
  } catch (err) {
    await bw.alert(`Could not export.\n\n${err.message}`, 'stop')
  }
}

const ACTIONS = {
  new: actNew,
  open: actOpen,
  save: () => actSave(false),
  saveas: () => actSave(true),
  svg: actExportSvg,
  undo: () => {
    const previous = undo.pop()
    if (!previous) return
    doc.size = previous.size
    doc.pixels = previous.pixels
    markDirty(true)
    layout()
  },
}

for (const b of document.querySelectorAll('[data-act]')) {
  const act = ACTIONS[b.dataset.act]
  if (act) b.addEventListener('click', () => void act())
}

/* --- boot ----------------------------------------------------------------- */

window.addEventListener('resize', layout)

void (async () => {
  selectTool('pencil')
  selectColour(0)
  layout()

  // `ready` reports the document the window was launched on, when Tracker
  // opened a .bicon with this app. It is the one path outside the package's
  // own folder the host will let it read.
  const info = await bw.ready()
  if (info && info.path) {
    await load(info.path, info.path.split('/').pop())
  }
  await bw.setTitle(doc.name)
})()
