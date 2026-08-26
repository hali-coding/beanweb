import { BasicError } from './errors'
import type { Screen } from './screen'

/**
 * DRAW's graphics macro language.
 *
 * A whole turtle graphics system hidden in a string literal: `DRAW "U10 R10
 * D10 L10"` is a square. It is its own tiny interpreter, kept apart from the
 * BASIC one because it shares nothing with it — no variables, no control flow,
 * just a pen with a heading, a scale and a colour.
 *
 * Not supported: the `X` command, which executes another string through
 * `VARPTR$`. That is a pointer into a memory model this runtime does not have,
 * and there is no honest way to fake it, so it raises rather than silently
 * drawing nothing.
 */

interface Pen {
  /** Colour drawn with, starting from the screen's current foreground. */
  colour: number
  /** Scale in quarters: 4 means one unit per step, as QBasic starts. */
  scale: number
  /** Heading in degrees, counter-clockwise from east as drawn on screen. */
  angle: number
}

/** One character of look-ahead over the macro string. */
class Cursor {
  private at = 0
  private readonly text: string
  private readonly line: number

  constructor(text: string, line: number) {
    this.text = text
    this.line = line
  }

  get done(): boolean {
    return this.at >= this.text.length
  }

  /** Next significant character, upper-cased. Spaces are separators only. */
  next(): string {
    while (this.at < this.text.length && this.text[this.at] === ' ') this.at += 1
    return this.at < this.text.length ? this.text[this.at++].toUpperCase() : ''
  }

  peek(): string {
    let i = this.at
    while (i < this.text.length && this.text[i] === ' ') i += 1
    return i < this.text.length ? this.text[i].toUpperCase() : ''
  }

  /** An optional signed number; absent means the command's default of 1. */
  number(fallback: number | null = null): number {
    while (this.at < this.text.length && this.text[this.at] === ' ') this.at += 1

    // `=variable;` dereferences a BASIC variable through VARPTR$, which this
    // runtime has no pointers for.
    if (this.text[this.at] === '=') {
      throw new BasicError('?DRAW cannot read a variable with "="', this.line)
    }

    const start = this.at
    if (this.text[this.at] === '+' || this.text[this.at] === '-') this.at += 1
    const digits = this.at
    while (this.at < this.text.length && this.text[this.at] >= '0' && this.text[this.at] <= '9') {
      this.at += 1
    }
    if (this.at === digits) {
      this.at = start
      if (fallback === null) throw new BasicError('?Syntax error in DRAW', this.line)
      return fallback
    }
    return Number(this.text.slice(start, this.at))
  }

  /** True if the next character is a separator the grammar allows to be there. */
  accept(ch: string): boolean {
    while (this.at < this.text.length && this.text[this.at] === ' ') this.at += 1
    if (this.text[this.at] === ch) {
      this.at += 1
      return true
    }
    return false
  }
}

/**
 * Run a DRAW string against the screen.
 *
 * `defaultColour` is what the pen uses until a `C` command changes it — the
 * screen's current foreground, resolved by the caller.
 */
export function draw(screen: Screen, macro: string, defaultColour: number, line: number): void {
  const pen: Pen = { colour: defaultColour, scale: 4, angle: 0 }
  const cursor = new Cursor(macro, line)

  while (!cursor.done) {
    const cmd = cursor.next()
    if (!cmd) break

    // A move can be prefixed by B (do not draw) and N (return afterwards), in
    // either order, and both apply to the single move that follows.
    let blind = false
    let restore = false
    let c = cmd
    while (c === 'B' || c === 'N') {
      if (c === 'B') blind = true
      else restore = true
      c = cursor.next()
      if (!c) return
    }

    switch (c) {
      case 'U': move(screen, pen, 0, -cursor.number(1), blind, restore, line); break
      case 'D': move(screen, pen, 0, cursor.number(1), blind, restore, line); break
      case 'L': move(screen, pen, -cursor.number(1), 0, blind, restore, line); break
      case 'R': move(screen, pen, cursor.number(1), 0, blind, restore, line); break
      case 'E': { const n = cursor.number(1); move(screen, pen, n, -n, blind, restore, line); break }
      case 'F': { const n = cursor.number(1); move(screen, pen, n, n, blind, restore, line); break }
      case 'G': { const n = cursor.number(1); move(screen, pen, -n, n, blind, restore, line); break }
      case 'H': { const n = cursor.number(1); move(screen, pen, -n, -n, blind, restore, line); break }

      case 'M': {
        // A signed pair is relative; an unsigned one is absolute. That single
        // distinction is why `M+10,0` and `M10,0` do different things.
        const relative = cursor.peek() === '+' || cursor.peek() === '-'
        const x = cursor.number()
        if (!cursor.accept(',')) throw new BasicError('?Syntax error in DRAW', line)
        const y = cursor.number()
        moveTo(screen, pen, x, y, relative, blind, restore, line)
        break
      }

      case 'A': {
        const n = cursor.number(0)
        if (n < 0 || n > 3) throw new BasicError('?Illegal function call in DRAW', line)
        pen.angle = n * 90
        break
      }
      case 'T': {
        if (cursor.next() !== 'A') throw new BasicError('?Syntax error in DRAW', line)
        pen.angle = cursor.number(0)
        break
      }
      case 'C':
        pen.colour = cursor.number(0)
        break
      case 'S': {
        const n = cursor.number(4)
        if (n < 1 || n > 255) throw new BasicError('?Illegal function call in DRAW', line)
        pen.scale = n
        break
      }
      case 'P': {
        const fill = cursor.number(0)
        const border = cursor.accept(',') ? cursor.number(0) : fill
        screen.paint({ x: screen.lastX, y: screen.lastY }, fill, border, line)
        break
      }
      case 'X':
        throw new BasicError('?DRAW "X" needs VARPTR$, which is not supported', line)

      default:
        throw new BasicError(`?Syntax error in DRAW: ${c}`, line)
    }

    // A semicolon between commands is decoration; the grammar never needs it.
    cursor.accept(';')
  }
}

/** Step the pen by a scaled, rotated offset in glyph units. */
function move(
  screen: Screen,
  pen: Pen,
  dx: number,
  dy: number,
  blind: boolean,
  restore: boolean,
  line: number,
): void {
  const k = pen.scale / 4
  const rad = (pen.angle * Math.PI) / 180
  const sx = dx * k
  const sy = dy * k
  // Screen y grows downwards, so a counter-clockwise turn on screen is a
  // clockwise turn in these coordinates — hence the sign on the sine terms.
  const rx = sx * Math.cos(rad) + sy * Math.sin(rad)
  const ry = -sx * Math.sin(rad) + sy * Math.cos(rad)
  stroke(screen, pen, screen.lastX + rx, screen.lastY + ry, blind, restore, line)
}

/** `M` — the same step, but to a stated point. */
function moveTo(
  screen: Screen,
  pen: Pen,
  x: number,
  y: number,
  relative: boolean,
  blind: boolean,
  restore: boolean,
  line: number,
): void {
  const tx = relative ? screen.lastX + x * (pen.scale / 4) : x
  const ty = relative ? screen.lastY + y * (pen.scale / 4) : y
  stroke(screen, pen, tx, ty, blind, restore, line)
}

function stroke(
  screen: Screen,
  pen: Pen,
  tx: number,
  ty: number,
  blind: boolean,
  restore: boolean,
  line: number,
): void {
  const fromX = screen.lastX
  const fromY = screen.lastY

  if (blind) {
    screen.lastX = tx
    screen.lastY = ty
  } else {
    screen.line({ x: fromX, y: fromY }, { x: tx, y: ty }, pen.colour, 'line', null, line)
  }

  if (restore) {
    screen.lastX = fromX
    screen.lastY = fromY
  }
}
