import { syntaxError } from './errors'

/**
 * Tokenizer for QBasic-flavoured BASIC.
 *
 * Unlike the line-numbered dialect this replaced, the whole source is tokenized
 * at once and newlines are significant: a newline ends a statement, exactly as
 * `:` does. Every token carries its 1-based source row, which is what errors
 * point at and what the editor's highlighter will need.
 */

export type TokenKind =
  | 'number'
  | 'string'
  | 'keyword'
  | 'name'
  | 'op'
  | 'comment'
  | 'newline'
  | 'eof'

export interface Token {
  kind: TokenKind
  /** Canonical text: keywords and names upper-cased, strings unquoted. */
  value: string
  /** Exact source slice, for the highlighter. */
  raw: string
  start: number
  end: number
  /** 1-based source row. */
  line: number
}

export const KEYWORDS = new Set([
  // statements
  'PRINT', 'LET', 'INPUT', 'LINE', 'CLS', 'END', 'STOP', 'SYSTEM',
  'IF', 'THEN', 'ELSE', 'ELSEIF',
  'FOR', 'TO', 'STEP', 'NEXT',
  'WHILE', 'WEND',
  'DO', 'LOOP', 'UNTIL', 'EXIT',
  'SELECT', 'CASE', 'IS',
  'GOTO', 'GOSUB', 'RETURN',
  'DIM', 'SHARED', 'CONST', 'REDIM',
  'DATA', 'READ', 'RESTORE',
  'SUB', 'FUNCTION', 'CALL', 'DECLARE',
  'RANDOMIZE', 'REM', 'SWAP',
  // graphics and console
  'SCREEN', 'PSET', 'PRESET', 'CIRCLE', 'PAINT', 'DRAW', 'COLOR', 'LOCATE',
  'VIEW', 'WINDOW', 'PALETTE', 'GET', 'PUT', 'WIDTH', 'USING',
  // sound: parsed so a listing runs, but silent
  'BEEP', 'SOUND', 'PLAY', 'SLEEP',
  // `AS` is reserved, but the type names after it are not: reserving DOUBLE or
  // STRING would stop them being used as ordinary FUNCTION or variable names.
  'AS',
  // operators that are words
  'AND', 'OR', 'NOT', 'XOR', 'MOD',
])

/** Longest first, so <= and <> win over <. */
const OPERATORS = [
  '<=', '>=', '<>', '+', '-', '*', '/', '\\', '^', '=', '<', '>',
  '(', ')', ',', ';', ':',
]

/** QBasic type suffixes. `$` means string; the rest are numeric widths. */
const SUFFIXES = '$%&!#'

const isDigit = (c: string) => c >= '0' && c <= '9'
const isAlpha = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_'

/**
 * Tokenize a whole program.
 *
 * `lenient` keeps the highlighter alive on text that does not parse: an unknown
 * character becomes an op token instead of throwing.
 */
export function tokenize(source: string, lenient = false): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1

  const push = (kind: TokenKind, value: string, start: number) => {
    tokens.push({ kind, value, raw: source.slice(start, i), start, end: i, line })
  }

  while (i < source.length) {
    const start = i
    const c = source[i]

    if (c === '\n') {
      i += 1
      push('newline', '\n', start)
      line += 1
      continue
    }

    // A line continuation is not QBasic, so \r is just whitespace.
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1
      continue
    }

    // Apostrophe comments run to end of line, as does REM (handled below).
    if (c === "'") {
      while (i < source.length && source[i] !== '\n') i += 1
      push('comment', source.slice(start + 1, i).trim(), start)
      continue
    }

    if (c === '"') {
      i += 1
      let text = ''
      while (i < source.length && source[i] !== '"' && source[i] !== '\n') {
        text += source[i]
        i += 1
      }
      if (source[i] === '"') i += 1
      push('string', text, start)
      continue
    }

    // &H is hexadecimal and &O octal, which is how a listing writes a bit
    // pattern: LINE's style masks are always spelled &HF0F0, never 61680.
    if (c === '&') {
      const base = (source[i + 1] ?? '').toUpperCase()
      if (base === 'H' || base === 'O') {
        i += 2
        const digits = base === 'H' ? /[0-9a-fA-F]/ : /[0-7]/
        const from = i
        while (i < source.length && digits.test(source[i])) i += 1
        if (i === from) throw syntaxError(`Syntax error: expected digits after &${base}`, line)
        const value = parseInt(source.slice(from, i), base === 'H' ? 16 : 8)
        // A trailing type suffix belongs to the literal, not to what follows.
        if (SUFFIXES.includes(source[i] ?? '') && source[i] !== '$') i += 1
        push('number', String(value), start)
        continue
      }
    }

    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      while (i < source.length && isDigit(source[i])) i += 1
      if (source[i] === '.') {
        i += 1
        while (i < source.length && isDigit(source[i])) i += 1
      }
      if (source[i] === 'E' || source[i] === 'e') {
        const save = i
        i += 1
        if (source[i] === '+' || source[i] === '-') i += 1
        if (isDigit(source[i] ?? '')) {
          while (i < source.length && isDigit(source[i])) i += 1
        } else {
          i = save
        }
      }
      // A numeric literal may carry a type suffix too: 1#, 100&, 2.5!
      if (SUFFIXES.includes(source[i] ?? '') && source[i] !== '$') i += 1
      push('number', source.slice(start, i).replace(/[%&!#]$/, ''), start)
      continue
    }

    if (isAlpha(c)) {
      while (i < source.length && (isAlpha(source[i]) || isDigit(source[i]))) i += 1
      const bare = source.slice(start, i).toUpperCase()

      // REM swallows the rest of the line.
      if (bare === 'REM') {
        while (i < source.length && source[i] !== '\n') i += 1
        push('comment', source.slice(start + 3, i).trim(), start)
        continue
      }

      // A type suffix belongs to the name: A$ and A% are different variables.
      if (!KEYWORDS.has(bare) && SUFFIXES.includes(source[i] ?? '')) i += 1

      const word = source.slice(start, i).toUpperCase()
      push(KEYWORDS.has(word) ? 'keyword' : 'name', word, start)
      continue
    }

    const op = OPERATORS.find((o) => source.startsWith(o, i))
    if (op) {
      i += op.length
      push('op', op, start)
      continue
    }

    i += 1
    if (lenient) {
      push('op', source.slice(start, i), start)
      continue
    }
    throw syntaxError(`Syntax error: unexpected "${c}"`, line)
  }

  tokens.push({ kind: 'eof', value: '', raw: '', start: i, end: i, line })
  return tokens
}
