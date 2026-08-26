import { BasicError } from './errors'
import { GLYPH_H, GLYPH_W, glyph } from './font'
import { EGA16, MODES, dacToRgb, defaultPalette, pixelAspect } from './modes'
import type { ModeInfo } from './modes'

/**
 * The BASIC screen: a palette-indexed pixel buffer, a character grid over it,
 * and the coordinate machinery QBasic put between a program's numbers and a
 * pixel.
 *
 * This is deliberately pure data — no canvas, no DOM. The runtime draws into
 * it, `renderInto()` turns it into RGBA once per displayed frame, and tests can
 * assert on `point()` and `charAt()` under jsdom, which has no canvas at all.
 *
 * Two layers, not one. Hardware wrote glyphs straight into video memory, so a
 * line drawn across text erased it; here text lives in its own grid and
 * composites on top. It is the one deliberate departure, and it buys exact
 * LOCATE, exact scrolling, and text that PAINT cannot flood through.
 */

/** A rectangle of captured pixels, as GET produces and PUT consumes. */
export interface Sprite {
  w: number
  h: number
  /** Attribute per pixel, row-major. */
  data: Uint8Array
}

export type PutAction = 'PSET' | 'PRESET' | 'AND' | 'OR' | 'XOR'
export type LineShape = 'line' | 'box' | 'boxfill'

interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Rows of text scrolled by PRINT. VIEW PRINT narrows it. */
interface TextView {
  top: number
  bottom: number
}

/** Nothing has been written to a cell that still holds this code. */
const EMPTY_CELL = 0

/** PRINT's comma zones. */
const PRINT_ZONE = 14

export class Screen {
  info: ModeInfo
  /** Attribute per pixel. Empty in SCREEN 0, which addresses no pixels. */
  pixels: Uint8Array
  palette: Uint32Array

  /** Character codes; `EMPTY_CELL` means the cell shows whatever is behind it. */
  chars: Uint16Array
  /** Packed `fg | bg << 8` per cell. */
  cellAttrs: Uint16Array

  cols: number
  rows: number

  /** 1-based, as LOCATE counts. */
  cursorRow = 1
  cursorCol = 1
  cursorVisible = false

  foreground: number
  background = 0
  /** SCREEN 1's palette selector, set by COLOR's second argument. */
  cgaPalette = 1

  /** The graphics cursor, in whatever coordinates the program is using. */
  lastX = 0
  lastY = 0

  /** Clipping rectangle in physical pixels. */
  view: Box
  /** VIEW without SCREEN makes coordinates relative to the viewport's corner. */
  viewRelative = false
  /** Set by WINDOW; null means coordinates are already pixels. */
  world: Box | null = null
  /** WINDOW SCREEN keeps y increasing downwards. */
  worldTopDown = false

  textView: TextView

  /**
   * Bumped by every mutation. The screen window polls it once per frame and
   * re-blits only when it moved, so a program that draws nothing costs nothing.
   */
  version = 0

  constructor(mode = 0) {
    this.info = MODES[mode]
    this.cols = this.info.cols
    this.rows = this.info.rows
    this.foreground = defaultForeground(this.info)
    this.pixels = new Uint8Array(this.info.width * this.info.height)
    this.palette = defaultPalette(this.info)
    this.chars = new Uint16Array(this.cols * this.rows)
    this.cellAttrs = new Uint16Array(this.cols * this.rows)
    this.view = { x1: 0, y1: 0, x2: Math.max(0, this.info.width - 1), y2: Math.max(0, this.info.height - 1) }
    this.textView = { top: 1, bottom: this.rows }
  }

  /* ------------------------------------------------------------ geometry */

  /** Width of the image `renderInto` produces. */
  get displayW(): number {
    return this.info.graphics ? this.info.width : this.cols * this.info.cellW
  }

  get displayH(): number {
    return this.info.graphics ? this.info.height : this.rows * this.info.cellH
  }

  /** How much the window must stretch the image vertically to look right. */
  get aspect(): number {
    return pixelAspect(this.displayW, this.displayH)
  }

  /** CIRCLE's default aspect ratio: whatever makes a circle come out round. */
  get circleAspect(): number {
    return 1 / this.aspect
  }

  private touch(): void {
    this.version += 1
  }

  private requireGraphics(line: number): void {
    if (!this.info.graphics) throw new BasicError('?Illegal function call', line)
  }

  /* ---------------------------------------------------------------- mode */

  /**
   * SCREEN. Re-selecting the mode already showing is not a no-op in QBasic —
   * it clears the screen — and several listings rely on that to wipe.
   */
  setMode(mode: number, line: number): void {
    const info = MODES[mode]
    if (!info) throw new BasicError('?Illegal function call', line)
    this.info = info
    this.cols = info.cols
    this.rows = info.rows
    this.pixels = new Uint8Array(info.width * info.height)
    this.palette = defaultPalette(info)
    this.chars = new Uint16Array(this.cols * this.rows)
    this.cellAttrs = new Uint16Array(this.cols * this.rows)
    this.foreground = defaultForeground(info)
    this.background = 0
    this.cgaPalette = 1
    this.resetView()
    this.world = null
    this.worldTopDown = false
    this.textView = { top: 1, bottom: this.rows }
    this.cursorRow = 1
    this.cursorCol = 1
    this.lastX = 0
    this.lastY = 0
    this.touch()
  }

  /** WIDTH. Only the text grid changes; the pixel grid belongs to the mode. */
  setWidth(cols: number | null, rows: number | null, line: number): void {
    const c = cols ?? this.cols
    const r = rows ?? this.rows
    if (this.info.graphics) {
      // In a graphics mode the character grid is the pixel grid divided by the
      // cell, so only the widths the mode can actually show are legal.
      if (cols !== null && cols !== this.info.cols) throw new BasicError('?Illegal function call', line)
      if (rows !== null && rows !== this.info.rows) throw new BasicError('?Illegal function call', line)
      return
    }
    if (![40, 80].includes(c) || ![25, 43, 50].includes(r)) {
      throw new BasicError('?Illegal function call', line)
    }
    this.cols = c
    this.rows = r
    // A 43- or 50-row text screen came from a shorter character cell, not a
    // taller display: the pixel height stays put and the glyphs get tighter.
    this.info = { ...this.info, cols: c, rows: r, cellH: Math.round(400 / r) }
    this.chars = new Uint16Array(c * r)
    this.cellAttrs = new Uint16Array(c * r)
    this.textView = { top: 1, bottom: r }
    this.cursorRow = 1
    this.cursorCol = 1
    this.touch()
  }

  /**
   * COLOR. Its arguments mean different things per mode: a foreground and
   * background in the EGA/VGA modes, but a *border* and a palette number in
   * SCREEN 1, which is why this cannot be one shared code path.
   */
  setColor(a: number | null, b: number | null, line: number): void {
    if (this.info.mode === 1) {
      if (a !== null) this.background = clampAttr(a, 16, line)
      if (b !== null) this.cgaPalette = b & 1
      this.palette = Uint32Array.from(cgaPalette(this.cgaPalette, this.background))
      this.touch()
      return
    }
    if (this.info.mode === 2 || this.info.mode === 11) {
      // Two-colour modes have nothing to choose.
      throw new BasicError('?Illegal function call', line)
    }
    if (a !== null) {
      // SCREEN 0 allows 16..31 to mean "blinking"; the blink bit is dropped.
      const fg = this.info.mode === 0 ? clampAttr(a, 32, line) % 16 : clampAttr(a, this.info.colors, line)
      this.foreground = fg
    }
    if (b !== null) {
      const max = this.info.mode === 0 ? 8 : this.info.colors
      this.background = clampAttr(b, max, line)
    }
    this.touch()
  }

  /** PALETTE attr, colour — remaps one attribute without touching a pixel. */
  setPalette(attr: number, dac: number, line: number): void {
    const i = Math.trunc(attr)
    if (i < 0 || i >= this.palette.length) throw new BasicError('?Illegal function call', line)
    this.palette[i] = dacToRgb(dac, this.info.paletteSize > 64)
    this.touch()
  }

  /** PALETTE with no arguments: back to the mode's power-on colours. */
  resetPalette(): void {
    this.palette = defaultPalette(this.info)
    this.touch()
  }

  /** PALETTE USING array — a whole palette at once; -1 leaves an entry alone. */
  paletteUsing(values: number[]): void {
    const n = Math.min(values.length, this.palette.length)
    for (let i = 0; i < n; i += 1) {
      if (values[i] < 0) continue
      this.palette[i] = dacToRgb(values[i], this.info.paletteSize > 64)
    }
    this.touch()
  }

  /* ------------------------------------------------------------ clearing */

  /**
   * CLS. With no argument it clears everything; `CLS 1` clears only the
   * graphics viewport and `CLS 2` only the text viewport, which is how a
   * program keeps a status line while wiping the picture under it.
   */
  cls(target: number | null = null): void {
    const wipeGraphics = target === null || target === 1
    const wipeText = target === null || target === 2

    if (wipeGraphics && this.info.graphics) {
      this.fillBox(this.view, this.background)
    }
    if (wipeText) {
      const from = target === 2 ? this.textView.top : 1
      const to = target === 2 ? this.textView.bottom : this.rows
      for (let r = from; r <= to; r += 1) this.clearRow(r)
      this.cursorRow = from
      this.cursorCol = 1
    }
    if (target === null) {
      this.lastX = 0
      this.lastY = 0
    }
    this.touch()
  }

  private clearRow(row: number): void {
    const start = (row - 1) * this.cols
    this.chars.fill(EMPTY_CELL, start, start + this.cols)
    this.cellAttrs.fill(0, start, start + this.cols)
  }

  /* ---------------------------------------------------------------- text */

  /** VIEW PRINT top TO bottom — the rows PRINT scrolls within. */
  setTextView(top: number | null, bottom: number | null, line: number): void {
    if (top === null || bottom === null) {
      this.textView = { top: 1, bottom: this.rows }
    } else {
      const t = Math.trunc(top)
      const b = Math.trunc(bottom)
      if (t < 1 || b > this.rows || t > b) throw new BasicError('?Illegal function call', line)
      this.textView = { top: t, bottom: b }
    }
    this.cursorRow = this.textView.top
    this.cursorCol = 1
    this.touch()
  }

  locate(row: number | null, col: number | null, visible: boolean | null, line: number): void {
    if (row !== null) {
      const r = Math.trunc(row)
      if (r < 1 || r > this.rows) throw new BasicError('?Illegal function call', line)
      this.cursorRow = r
    }
    if (col !== null) {
      const c = Math.trunc(col)
      if (c < 1 || c > this.cols) throw new BasicError('?Illegal function call', line)
      this.cursorCol = c
    }
    if (visible !== null) this.cursorVisible = visible
    this.touch()
  }

  /** The column PRINT would write next — what POS(0) reports. */
  get column(): number {
    return this.cursorCol
  }

  /** Advance to the next comma zone, the width PRINT's `,` steps by. */
  tabToZone(): void {
    const pad = PRINT_ZONE - ((this.cursorCol - 1) % PRINT_ZONE)
    this.write(' '.repeat(pad))
  }

  /** PRINT TAB(n): move to column n, wrapping to the next row if already past. */
  tabTo(col: number): void {
    const target = Math.max(1, Math.trunc(col))
    if (target > this.cols) {
      this.newline()
      return
    }
    if (target < this.cursorCol) this.newline()
    while (this.cursorCol < target) this.write(' ')
  }

  /** Write text at the cursor, wrapping and scrolling exactly as PRINT does. */
  write(text: string): void {
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      if (code === 10) {
        this.newline()
        continue
      }
      if (code === 13) {
        this.cursorCol = 1
        continue
      }
      this.putChar(code)
    }
    this.touch()
  }

  private putChar(code: number): void {
    const i = (this.cursorRow - 1) * this.cols + (this.cursorCol - 1)
    if (i >= 0 && i < this.chars.length) {
      this.chars[i] = code === 32 ? 32 : code
      this.cellAttrs[i] = this.foreground | (this.background << 8)
    }
    this.cursorCol += 1
    if (this.cursorCol > this.cols) {
      this.cursorCol = 1
      this.advanceRow()
    }
  }

  private newline(): void {
    this.cursorCol = 1
    this.advanceRow()
  }

  private advanceRow(): void {
    if (this.cursorRow < this.textView.bottom) {
      this.cursorRow += 1
      return
    }
    this.scrollText()
  }

  /** Roll the text viewport up one row, leaving a blank row at the bottom. */
  private scrollText(): void {
    const { top, bottom } = this.textView
    for (let r = top; r < bottom; r += 1) {
      const dst = (r - 1) * this.cols
      const src = r * this.cols
      this.chars.copyWithin(dst, src, src + this.cols)
      this.cellAttrs.copyWithin(dst, src, src + this.cols)
    }
    this.clearRow(bottom)
    this.cursorRow = bottom
  }

  /** The character in a cell, 1-based. Tests read the screen through this. */
  charAt(row: number, col: number): string {
    const i = (row - 1) * this.cols + (col - 1)
    const code = this.chars[i]
    return code === EMPTY_CELL ? ' ' : String.fromCharCode(code)
  }

  /** A whole row as text, trailing blanks trimmed. */
  rowText(row: number): string {
    let out = ''
    for (let c = 1; c <= this.cols; c += 1) out += this.charAt(row, c)
    return out.replace(/\s+$/, '')
  }

  /* --------------------------------------------------- coordinate mapping */

  /**
   * Turn a coordinate pair the program wrote into a physical pixel.
   *
   * Three transforms stack here, and the order is the whole game: STEP is
   * relative to the graphics cursor in the program's own units, WINDOW maps
   * those units onto the viewport, and VIEW offsets the result into the
   * viewport unless VIEW SCREEN said otherwise.
   */
  toPhysical(x: number, y: number): { x: number; y: number } {
    if (this.world) {
      const { x1, y1, x2, y2 } = this.world
      const vw = this.view.x2 - this.view.x1
      const vh = this.view.y2 - this.view.y1
      const sx = x2 === x1 ? 0 : (x - x1) / (x2 - x1)
      const sy = y2 === y1 ? 0 : (y - y1) / (y2 - y1)
      return {
        x: Math.round(this.view.x1 + sx * vw),
        // Without SCREEN, WINDOW puts the first corner at the *bottom*: y grows
        // upwards, the way graph paper does and video memory does not.
        y: Math.round(this.worldTopDown ? this.view.y1 + sy * vh : this.view.y2 - sy * vh),
      }
    }
    const px = Math.round(x)
    const py = Math.round(y)
    if (this.viewRelative) return { x: this.view.x1 + px, y: this.view.y1 + py }
    return { x: px, y: py }
  }

  /** The inverse, for PMAP and for reporting where the graphics cursor sits. */
  toLogical(px: number, py: number): { x: number; y: number } {
    if (this.world) {
      const { x1, y1, x2, y2 } = this.world
      const vw = this.view.x2 - this.view.x1
      const vh = this.view.y2 - this.view.y1
      const sx = vw === 0 ? 0 : (px - this.view.x1) / vw
      const sy = vh === 0 ? 0 : (this.worldTopDown ? py - this.view.y1 : this.view.y2 - py) / vh
      return { x: x1 + sx * (x2 - x1), y: y1 + sy * (y2 - y1) }
    }
    if (this.viewRelative) return { x: px - this.view.x1, y: py - this.view.y1 }
    return { x: px, y: py }
  }

  /** VIEW (x1,y1)-(x2,y2) — the clipping rectangle, and optionally its paint. */
  setView(
    box: Box | null,
    screenRelative: boolean,
    fill: number | null,
    border: number | null,
    line: number,
  ): void {
    this.requireGraphics(line)
    if (!box) {
      this.resetView()
      this.touch()
      return
    }
    const x1 = clampInt(Math.min(box.x1, box.x2), 0, this.info.width - 1)
    const x2 = clampInt(Math.max(box.x1, box.x2), 0, this.info.width - 1)
    const y1 = clampInt(Math.min(box.y1, box.y2), 0, this.info.height - 1)
    const y2 = clampInt(Math.max(box.y1, box.y2), 0, this.info.height - 1)
    this.view = { x1, y1, x2, y2 }
    this.viewRelative = !screenRelative
    if (fill !== null) this.fillBox(this.view, fill)
    if (border !== null) this.strokeBox(this.expandForBorder(this.view), border)
    this.lastX = 0
    this.lastY = 0
    this.touch()
  }

  /** VIEW's border is drawn just outside the viewport, where there is room. */
  private expandForBorder(box: Box): Box {
    return {
      x1: Math.max(0, box.x1 - 1),
      y1: Math.max(0, box.y1 - 1),
      x2: Math.min(this.info.width - 1, box.x2 + 1),
      y2: Math.min(this.info.height - 1, box.y2 + 1),
    }
  }

  resetView(): void {
    this.view = {
      x1: 0,
      y1: 0,
      x2: Math.max(0, this.info.width - 1),
      y2: Math.max(0, this.info.height - 1),
    }
    this.viewRelative = false
  }

  /** WINDOW (x1,y1)-(x2,y2) — world coordinates over the viewport. */
  setWindow(box: Box | null, screenCoords: boolean, line: number): void {
    this.requireGraphics(line)
    if (!box) {
      this.world = null
      this.worldTopDown = false
    } else {
      if (box.x1 === box.x2 || box.y1 === box.y2) throw new BasicError('?Illegal function call', line)
      this.world = { ...box }
      this.worldTopDown = screenCoords
    }
    this.lastX = 0
    this.lastY = 0
    this.touch()
  }

  /* ------------------------------------------------------------- drawing */

  private inView(x: number, y: number): boolean {
    return x >= this.view.x1 && x <= this.view.x2 && y >= this.view.y1 && y <= this.view.y2
  }

  /** Set one physical pixel, clipped to the viewport. */
  plot(x: number, y: number, attr: number): void {
    if (!this.inView(x, y)) return
    this.pixels[y * this.info.width + x] = attr
  }

  /** PSET / PRESET. Coordinates are the program's; `attr` is already resolved. */
  pset(x: number, y: number, attr: number, line: number): void {
    this.requireGraphics(line)
    const p = this.toPhysical(x, y)
    this.plot(p.x, p.y, attr)
    this.lastX = x
    this.lastY = y
    this.touch()
  }

  /** POINT(x,y) — the attribute at a coordinate, or -1 outside the screen. */
  point(x: number, y: number, line: number): number {
    this.requireGraphics(line)
    const p = this.toPhysical(x, y)
    if (p.x < 0 || p.y < 0 || p.x >= this.info.width || p.y >= this.info.height) return -1
    return this.pixels[p.y * this.info.width + p.x]
  }

  /**
   * LINE, in all four of its shapes: a segment, a box outline, a filled box,
   * and any of them through a 16-bit style mask.
   */
  line(
    from: { x: number; y: number },
    to: { x: number; y: number },
    attr: number,
    shape: LineShape,
    style: number | null,
    lineNo: number,
  ): void {
    this.requireGraphics(lineNo)
    const a = this.toPhysical(from.x, from.y)
    const b = this.toPhysical(to.x, to.y)

    if (shape === 'boxfill') {
      this.fillBox(normalize(a.x, a.y, b.x, b.y), attr)
    } else if (shape === 'box') {
      this.strokeBox(normalize(a.x, a.y, b.x, b.y), attr, style)
    } else {
      this.segment(a.x, a.y, b.x, b.y, attr, style)
    }

    this.lastX = to.x
    this.lastY = to.y
    this.touch()
  }

  /** Bresenham, with the style mask consumed one bit per pixel stepped. */
  private segment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    attr: number,
    style: number | null,
    mask = { bit: 0 },
  ): void {
    let x = x0
    let y = y0
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy

    for (;;) {
      // A zero bit in the mask skips the pixel but still advances the pattern,
      // which is what makes a dashed line keep its rhythm around a corner.
      if (style === null || (style >> (mask.bit & 15)) & 1) this.plot(x, y, attr)
      mask.bit += 1
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        if (x === x1) break
        err += dy
        x += sx
      }
      if (e2 <= dx) {
        if (y === y1) break
        err += dx
        y += sy
      }
    }
  }

  private fillBox(box: Box, attr: number): void {
    const x1 = Math.max(box.x1, this.view.x1)
    const x2 = Math.min(box.x2, this.view.x2)
    const y1 = Math.max(box.y1, this.view.y1)
    const y2 = Math.min(box.y2, this.view.y2)
    for (let y = y1; y <= y2; y += 1) {
      this.pixels.fill(attr, y * this.info.width + x1, y * this.info.width + x2 + 1)
    }
  }

  private strokeBox(box: Box, attr: number, style: number | null = null): void {
    const mask = { bit: 0 }
    this.segment(box.x1, box.y1, box.x2, box.y1, attr, style, mask)
    this.segment(box.x2, box.y1, box.x2, box.y2, attr, style, mask)
    this.segment(box.x2, box.y2, box.x1, box.y2, attr, style, mask)
    this.segment(box.x1, box.y2, box.x1, box.y1, attr, style, mask)
  }

  /**
   * CIRCLE — an ellipse, really, and an arc of one when given angles.
   *
   * The radius is measured along whichever axis the aspect ratio does not
   * squash, matching QBasic: below 1 the radius is horizontal, above it the
   * radius is vertical. A negative angle also draws the radius line to that
   * end point, which is how a listing draws a pie slice.
   */
  circle(
    centre: { x: number; y: number },
    radius: number,
    attr: number,
    start: number | null,
    end: number | null,
    aspect: number | null,
    lineNo: number,
  ): void {
    this.requireGraphics(lineNo)
    if (radius < 0) throw new BasicError('?Illegal function call', lineNo)

    const c = this.toPhysical(centre.x, centre.y)
    const ratio = aspect ?? this.worldCircleAspect()
    // The radius arrives in the program's units; scale it the same way a
    // coordinate would be, so a circle under WINDOW comes out the right size.
    const r = this.radiusInPixels(radius)
    const rx = ratio <= 1 ? r : r / ratio
    const ry = ratio <= 1 ? r * ratio : r

    const drawRadius = (angle: number) => {
      const x = Math.round(c.x + rx * Math.cos(angle))
      const y = Math.round(c.y - ry * Math.sin(angle))
      this.segment(c.x, c.y, x, y, attr, null)
    }

    // A negative angle means "and join this end to the centre". Zero can only
    // be spelled negative as -0, which is why this tests the sign bit.
    const startNegative = start !== null && (start < 0 || Object.is(start, -0))
    const endNegative = end !== null && (end < 0 || Object.is(end, -0))

    let from = start === null ? 0 : Math.abs(start)
    let to = end === null ? Math.PI * 2 : Math.abs(end)
    if (start === null && end === null) {
      from = 0
      to = Math.PI * 2
    }
    // Arcs run counter-clockwise from `from` to `to`, wrapping through zero.
    if (to <= from) to += Math.PI * 2

    const steps = Math.max(8, Math.ceil((to - from) * Math.max(rx, ry) * 2))
    let px = Number.NaN
    let py = Number.NaN
    for (let i = 0; i <= steps; i += 1) {
      const angle = from + ((to - from) * i) / steps
      const x = Math.round(c.x + rx * Math.cos(angle))
      const y = Math.round(c.y - ry * Math.sin(angle))
      // Stepping by angle revisits the same pixel near the flat parts of the
      // ellipse; skipping repeats keeps XOR-style redraws honest.
      if (x !== px || y !== py) this.plot(x, y, attr)
      px = x
      py = y
    }

    if (startNegative) drawRadius(Math.abs(start ?? 0))
    if (endNegative) drawRadius(Math.abs(end ?? 0))

    this.lastX = centre.x
    this.lastY = centre.y
    this.touch()
  }

  /** CIRCLE's default aspect, in the coordinate system currently in force. */
  private worldCircleAspect(): number {
    if (!this.world) return this.circleAspect
    // Under WINDOW a "radius" is in world units, and the world's own x and y
    // scales are usually different; fold that into the aspect ratio.
    const vw = this.view.x2 - this.view.x1
    const vh = this.view.y2 - this.view.y1
    const wx = Math.abs(this.world.x2 - this.world.x1)
    const wy = Math.abs(this.world.y2 - this.world.y1)
    if (wx === 0 || wy === 0 || vw === 0) return this.circleAspect
    return (vh / wy) / (vw / wx) * this.circleAspect * this.aspect
  }

  /** A radius in program units, expressed in horizontal pixels. */
  private radiusInPixels(radius: number): number {
    if (!this.world) return Math.round(radius)
    const vw = this.view.x2 - this.view.x1
    const wx = Math.abs(this.world.x2 - this.world.x1)
    return wx === 0 ? Math.round(radius) : Math.abs((radius * vw) / wx)
  }

  /**
   * PAINT — flood fill out from a point, stopping at the border colour.
   *
   * Scanline fill with an explicit stack. The obvious recursive version blows
   * the JavaScript stack somewhere around a third of a 640x480 screen, which a
   * program filling a background does on its first statement.
   */
  paint(seed: { x: number; y: number }, attr: number, border: number | null, lineNo: number): void {
    this.requireGraphics(lineNo)
    const p = this.toPhysical(seed.x, seed.y)
    const edge = border ?? attr
    if (!this.inView(p.x, p.y)) return

    const w = this.info.width
    const fillable = (x: number, y: number) => {
      if (!this.inView(x, y)) return false
      const at = this.pixels[y * w + x]
      // Stopping on the fill colour as well as the border is what stops the
      // fill running back over itself and looping forever.
      return at !== edge && at !== attr
    }

    if (!fillable(p.x, p.y)) return

    const stack: number[] = [p.x, p.y]
    while (stack.length) {
      const y = stack.pop()!
      let x = stack.pop()!

      while (fillable(x - 1, y)) x -= 1
      let spanAbove = false
      let spanBelow = false

      for (; fillable(x, y); x += 1) {
        this.pixels[y * w + x] = attr
        const above = fillable(x, y - 1)
        if (above !== spanAbove) {
          if (above) stack.push(x, y - 1)
          spanAbove = above
        }
        const below = fillable(x, y + 1)
        if (below !== spanBelow) {
          if (below) stack.push(x, y + 1)
          spanBelow = below
        }
      }
    }

    this.lastX = seed.x
    this.lastY = seed.y
    this.touch()
  }

  /* -------------------------------------------------------------- sprites */

  /** GET (x1,y1)-(x2,y2) — capture a rectangle of attributes. */
  getSprite(from: { x: number; y: number }, to: { x: number; y: number }, lineNo: number): Sprite {
    this.requireGraphics(lineNo)
    const a = this.toPhysical(from.x, from.y)
    const b = this.toPhysical(to.x, to.y)
    const box = normalize(a.x, a.y, b.x, b.y)
    const w = box.x2 - box.x1 + 1
    const h = box.y2 - box.y1 + 1
    if (w <= 0 || h <= 0) throw new BasicError('?Illegal function call', lineNo)

    const data = new Uint8Array(w * h)
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const sx = box.x1 + x
        const sy = box.y1 + y
        const inside = sx >= 0 && sy >= 0 && sx < this.info.width && sy < this.info.height
        data[y * w + x] = inside ? this.pixels[sy * this.info.width + sx] : 0
      }
    }
    this.lastX = from.x
    this.lastY = from.y
    return { w, h, data }
  }

  /**
   * PUT (x,y), sprite [, action] — blit, with the action deciding how the
   * sprite combines with what is already there. XOR is the interesting one: it
   * is how a listing animates a sprite by drawing it twice.
   */
  putSprite(
    at: { x: number; y: number },
    sprite: Sprite,
    action: PutAction,
    lineNo: number,
  ): void {
    this.requireGraphics(lineNo)
    const p = this.toPhysical(at.x, at.y)
    const w = this.info.width
    const mask = this.info.colors - 1

    for (let y = 0; y < sprite.h; y += 1) {
      for (let x = 0; x < sprite.w; x += 1) {
        const dx = p.x + x
        const dy = p.y + y
        if (!this.inView(dx, dy)) continue
        const src = sprite.data[y * sprite.w + x]
        const i = dy * w + dx
        const dst = this.pixels[i]
        switch (action) {
          case 'PSET': this.pixels[i] = src; break
          case 'PRESET': this.pixels[i] = mask - src; break
          case 'AND': this.pixels[i] = dst & src; break
          case 'OR': this.pixels[i] = dst | src; break
          case 'XOR': this.pixels[i] = dst ^ src; break
        }
      }
    }
    this.lastX = at.x
    this.lastY = at.y
    this.touch()
  }

  /* ------------------------------------------------------------ rendering */

  /**
   * Compose the whole screen into RGBA at `displayW` x `displayH`.
   *
   * One pass over the pixels, then one pass over the character cells on top.
   * The window scales the result with CSS, so nothing here knows or cares how
   * big the window is.
   */
  renderInto(out: Uint8ClampedArray): void {
    const w = this.displayW
    const h = this.displayH
    const border = this.palette[this.background] ?? 0

    if (this.info.graphics) {
      for (let i = 0; i < this.pixels.length; i += 1) {
        const c = this.palette[this.pixels[i]] ?? 0
        const o = i * 4
        out[o] = (c >> 16) & 255
        out[o + 1] = (c >> 8) & 255
        out[o + 2] = c & 255
        out[o + 3] = 255
      }
    } else {
      for (let i = 0; i < w * h; i += 1) {
        const o = i * 4
        out[o] = (border >> 16) & 255
        out[o + 1] = (border >> 8) & 255
        out[o + 2] = border & 255
        out[o + 3] = 255
      }
    }

    const { cellW, cellH } = this.info
    // The 8x8 face is centred in cells taller than itself.
    const yPad = Math.max(0, Math.floor((cellH - GLYPH_H) / 2))

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const i = row * this.cols + col
        const code = this.chars[i]
        if (code === EMPTY_CELL) continue

        const attr = this.cellAttrs[i]
        const fg = this.palette[attr & 255] ?? 0
        const bg = this.palette[(attr >> 8) & 255] ?? 0
        const rows = glyph(code)

        for (let cy = 0; cy < cellH; cy += 1) {
          const py = row * cellH + cy
          if (py >= h) break
          const bits = cy >= yPad && cy - yPad < GLYPH_H ? rows[cy - yPad] : 0
          for (let cx = 0; cx < cellW; cx += 1) {
            const px = col * cellW + cx
            if (px >= w) break
            const on = cx < GLYPH_W && (bits & (128 >> cx)) !== 0
            const c = on ? fg : bg
            const o = (py * w + px) * 4
            out[o] = (c >> 16) & 255
            out[o + 1] = (c >> 8) & 255
            out[o + 2] = c & 255
            out[o + 3] = 255
          }
        }
      }
    }
  }
}

/* -------------------------------------------------------------- helpers */

const normalize = (x1: number, y1: number, x2: number, y2: number): Box => ({
  x1: Math.min(x1, x2),
  y1: Math.min(y1, y2),
  x2: Math.max(x1, x2),
  y2: Math.max(y1, y2),
})

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)))

function clampAttr(value: number, max: number, line: number): number {
  const v = Math.trunc(value)
  if (v < 0 || v >= max) throw new BasicError('?Illegal function call', line)
  return v
}

/** SCREEN 0 starts on light grey; the graphics modes on their brightest ink. */
function defaultForeground(info: ModeInfo): number {
  if (info.mode === 0) return 7
  return info.colors - 1 > 15 ? 15 : info.colors - 1
}

/**
 * SCREEN 1's four colours: attribute 0 is whatever COLOR chose for the
 * background, and the other three come from the selected CGA set.
 */
function cgaPalette(which: number, background: number): number[] {
  const set = which === 0 ? [2, 4, 6] : [3, 5, 7]
  return [EGA16[background], EGA16[set[0]], EGA16[set[1]], EGA16[set[2]]]
}
