import { BasicError } from './errors'
import type { Screen } from './screen'
import { formatNumber, isString } from './values'
import type { Value } from './values'

/**
 * The standard QBasic function library.
 *
 * Each builtin validates its own arity and argument types, so a wrong call is a
 * BASIC error with a line number rather than a JavaScript exception.
 */

export interface BuiltinContext {
  /** The VM's RNG, so RANDOMIZE can make runs reproducible. */
  random: () => number
  /** The screen, for the functions that read it back. */
  screen: Screen
  /** The next buffered keystroke, or "" — what INKEY$ returns. */
  inkey: () => string
}

/**
 * Builtins spelled without parentheses.
 *
 * `TIMER`, `INKEY$` and `CSRLIN` are function calls that look exactly like
 * variable reads, so the evaluator needs this list to tell them apart. Without
 * it they resolve as undeclared variables and quietly return zero.
 */
export const NULLARY_BUILTINS = new Set(['TIMER', 'INKEY$', 'CSRLIN', 'RND'])

type Builtin = (args: Value[], line: number, ctx: BuiltinContext) => Value

const num = (v: Value, line: number, fn: string): number => {
  if (typeof v !== 'number') throw new BasicError(`?Type mismatch in ${fn}`, line)
  return v
}

const str = (v: Value, line: number, fn: string): string => {
  if (typeof v !== 'string') throw new BasicError(`?Type mismatch in ${fn}`, line)
  return v
}

const arity = (args: Value[], min: number, max: number, line: number, fn: string) => {
  if (args.length < min || args.length > max) {
    throw new BasicError(`?Wrong number of arguments to ${fn}`, line)
  }
}

export const BUILTINS: Record<string, Builtin> = {
  /* ------------------------------------------------------------- strings */
  LEN: (a, line) => {
    arity(a, 1, 1, line, 'LEN')
    return str(a[0], line, 'LEN').length
  },
  'LEFT$': (a, line) => {
    arity(a, 2, 2, line, 'LEFT$')
    return str(a[0], line, 'LEFT$').slice(0, Math.max(0, num(a[1], line, 'LEFT$')))
  },
  'RIGHT$': (a, line) => {
    arity(a, 2, 2, line, 'RIGHT$')
    const n = Math.max(0, num(a[1], line, 'RIGHT$'))
    const s = str(a[0], line, 'RIGHT$')
    return n === 0 ? '' : s.slice(Math.max(0, s.length - n))
  },
  'MID$': (a, line) => {
    arity(a, 2, 3, line, 'MID$')
    const s = str(a[0], line, 'MID$')
    // BASIC strings are 1-based, and reading past the end yields "".
    const start = Math.max(1, Math.trunc(num(a[1], line, 'MID$')))
    if (a.length === 2) return s.slice(start - 1)
    const count = Math.max(0, Math.trunc(num(a[2], line, 'MID$')))
    return s.slice(start - 1, start - 1 + count)
  },
  'CHR$': (a, line) => {
    arity(a, 1, 1, line, 'CHR$')
    return String.fromCharCode(Math.trunc(num(a[0], line, 'CHR$')))
  },
  ASC: (a, line) => {
    arity(a, 1, 1, line, 'ASC')
    const s = str(a[0], line, 'ASC')
    if (!s) throw new BasicError('?Illegal function call in ASC', line)
    return s.charCodeAt(0)
  },
  VAL: (a, line) => {
    arity(a, 1, 1, line, 'VAL')
    // VAL reads a leading number and ignores the rest, returning 0 for none.
    const match = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(str(a[0], line, 'VAL'))
    return match ? Number(match[0]) : 0
  },
  'STR$': (a, line) => {
    arity(a, 1, 1, line, 'STR$')
    // Note the leading sign-space, and no trailing space: that padding belongs
    // to PRINT, not to the string form of a number.
    return formatNumber(num(a[0], line, 'STR$'))
  },
  'UCASE$': (a, line) => {
    arity(a, 1, 1, line, 'UCASE$')
    return str(a[0], line, 'UCASE$').toUpperCase()
  },
  'LCASE$': (a, line) => {
    arity(a, 1, 1, line, 'LCASE$')
    return str(a[0], line, 'LCASE$').toLowerCase()
  },
  'SPACE$': (a, line) => {
    arity(a, 1, 1, line, 'SPACE$')
    return ' '.repeat(Math.max(0, Math.trunc(num(a[0], line, 'SPACE$'))))
  },
  'STRING$': (a, line) => {
    arity(a, 2, 2, line, 'STRING$')
    const count = Math.max(0, Math.trunc(num(a[0], line, 'STRING$')))
    const what = a[1]
    const ch = isString(what) ? what.slice(0, 1) : String.fromCharCode(Math.trunc(what))
    return ch.repeat(count)
  },
  INSTR: (a, line) => {
    arity(a, 2, 3, line, 'INSTR')
    // INSTR(hay, needle) or INSTR(start, hay, needle); 0 means not found.
    const start = a.length === 3 ? Math.max(1, Math.trunc(num(a[0], line, 'INSTR'))) : 1
    const hay = str(a[a.length - 2], line, 'INSTR')
    const needle = str(a[a.length - 1], line, 'INSTR')
    return hay.indexOf(needle, start - 1) + 1
  },
  'LTRIM$': (a, line) => {
    arity(a, 1, 1, line, 'LTRIM$')
    return str(a[0], line, 'LTRIM$').replace(/^\s+/, '')
  },
  'RTRIM$': (a, line) => {
    arity(a, 1, 1, line, 'RTRIM$')
    return str(a[0], line, 'RTRIM$').replace(/\s+$/, '')
  },

  /* --------------------------------------------------------------- maths */
  ABS: (a, line) => Math.abs(num(a[0], line, 'ABS')),
  INT: (a, line) => Math.floor(num(a[0], line, 'INT')),
  FIX: (a, line) => Math.trunc(num(a[0], line, 'FIX')),
  SGN: (a, line) => Math.sign(num(a[0], line, 'SGN')),
  SQR: (a, line) => {
    const n = num(a[0], line, 'SQR')
    if (n < 0) throw new BasicError('?Illegal function call in SQR', line)
    return Math.sqrt(n)
  },
  SIN: (a, line) => Math.sin(num(a[0], line, 'SIN')),
  COS: (a, line) => Math.cos(num(a[0], line, 'COS')),
  TAN: (a, line) => Math.tan(num(a[0], line, 'TAN')),
  ATN: (a, line) => Math.atan(num(a[0], line, 'ATN')),
  EXP: (a, line) => Math.exp(num(a[0], line, 'EXP')),
  LOG: (a, line) => {
    const n = num(a[0], line, 'LOG')
    if (n <= 0) throw new BasicError('?Illegal function call in LOG', line)
    return Math.log(n)
  },
  RND: (a, line, ctx) => {
    arity(a, 0, 1, line, 'RND')
    return ctx.random()
  },
  /* ------------------------------------------------------------- screen */
  /**
   * POINT(x, y) reads the attribute at a coordinate. POINT(n) with a single
   * argument instead reports where the graphics cursor is: 0 and 1 give it in
   * physical pixels, 2 and 3 in whatever coordinates WINDOW set up.
   */
  POINT: (a, line, ctx) => {
    arity(a, 1, 2, line, 'POINT')
    const { screen } = ctx
    if (a.length === 2) {
      return screen.point(num(a[0], line, 'POINT'), num(a[1], line, 'POINT'), line)
    }
    const which = Math.trunc(num(a[0], line, 'POINT'))
    const physical = screen.toPhysical(screen.lastX, screen.lastY)
    switch (which) {
      case 0: return physical.x
      case 1: return physical.y
      case 2: return screen.lastX
      case 3: return screen.lastY
      default: throw new BasicError('?Illegal function call in POINT', line)
    }
  },

  /** PMAP converts between world and physical coordinates, both directions. */
  PMAP: (a, line, ctx) => {
    arity(a, 2, 2, line, 'PMAP')
    const v = num(a[0], line, 'PMAP')
    const which = Math.trunc(num(a[1], line, 'PMAP'))
    const { screen } = ctx
    switch (which) {
      case 0: return screen.toPhysical(v, 0).x
      case 1: return screen.toPhysical(0, v).y
      case 2: return screen.toLogical(v, 0).x
      case 3: return screen.toLogical(0, v).y
      default: throw new BasicError('?Illegal function call in PMAP', line)
    }
  },

  /** The row the text cursor is on. */
  CSRLIN: (a, line, ctx) => {
    arity(a, 0, 0, line, 'CSRLIN')
    return ctx.screen.cursorRow
  },

  /** POS(0) — the column the text cursor is on. */
  POS: (a, line, ctx) => {
    arity(a, 0, 1, line, 'POS')
    return ctx.screen.cursorCol
  },

  /** SCREEN(row, col) reads a character back off the screen; a third argument
   *  asks for its colour attribute instead. */
  SCREEN: (a, line, ctx) => {
    arity(a, 2, 3, line, 'SCREEN')
    const row = Math.trunc(num(a[0], line, 'SCREEN'))
    const col = Math.trunc(num(a[1], line, 'SCREEN'))
    const { screen } = ctx
    if (row < 1 || row > screen.rows || col < 1 || col > screen.cols) {
      throw new BasicError('?Illegal function call in SCREEN', line)
    }
    const i = (row - 1) * screen.cols + (col - 1)
    if (a.length === 3 && num(a[2], line, 'SCREEN') !== 0) {
      const attr = screen.cellAttrs[i]
      return (attr & 255) | (((attr >> 8) & 255) << 4)
    }
    return screen.charAt(row, col).charCodeAt(0)
  },

  /** INKEY$ — the next keystroke, or "" if none is waiting. Never blocks. */
  'INKEY$': (a, line, ctx) => {
    arity(a, 0, 0, line, 'INKEY$')
    return ctx.inkey()
  },

  TIMER: () => {
    // Seconds since midnight, as QBasic reports it.
    const now = new Date()
    return (
      now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000
    )
  },
}

export const isBuiltin = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(BUILTINS, name)
