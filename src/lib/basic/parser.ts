import type {
  BinaryOp,
  StmtNode,
  CaseArm,
  CaseTest,
  Coord,
  Expr,
  LineShape,
  LValue,
  PrintItem,
  Procedure,
  Program,
  PutAction,
  Stmt,
} from './ast'
import { syntaxError } from './errors'
import { tokenize } from './tokens'
import type { Token } from './tokens'

/**
 * QBasic parser.
 *
 * Precedence follows QBasic exactly, which differs from the 8-bit dialects in
 * one place worth knowing: NOT binds *looser* than the comparisons, so
 * `NOT a = b` means `NOT (a = b)`.
 *
 *   highest  ^
 *            unary -
 *            * /
 *            \        (integer divide)
 *            MOD
 *            + -
 *            = <> < > <= >=
 *            NOT
 *            AND
 *   lowest   OR XOR
 */
const PRECEDENCE: Record<string, number> = {
  OR: 1,
  XOR: 1,
  AND: 2,
  '=': 4,
  '<>': 4,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  MOD: 6,
  '\\': 7,
  '*': 8,
  '/': 8,
  '^': 10,
}
const NOT_PRECEDENCE = 3
const NEGATE_PRECEDENCE = 9

/** Keywords that close a block; a body parses until it meets one. */
const BLOCK_ENDERS = new Set([
  'END', 'ELSE', 'ELSEIF', 'NEXT', 'WEND', 'LOOP', 'CASE',
])

class Parser {
  private pos = 0
  private readonly tokens: Token[]

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]
  }

  private get line(): number {
    return this.peek().line
  }

  private next(): Token {
    return this.tokens[this.pos++]
  }

  private accept(kind: Token['kind'], value?: string): boolean {
    const t = this.peek()
    if (t.kind !== kind) return false
    if (value !== undefined && t.value !== value) return false
    this.pos += 1
    return true
  }

  private at(kind: Token['kind'], value?: string): boolean {
    const t = this.peek()
    return t.kind === kind && (value === undefined || t.value === value)
  }

  private expect(kind: Token['kind'], value?: string): Token {
    const t = this.peek()
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw syntaxError(
        `Syntax error: expected ${value ?? kind}, found ${t.value || 'end of line'}`,
        t.line,
      )
    }
    this.pos += 1
    return t
  }

  /** Consume statement separators: newlines, colons, and comments. */
  private skipSeparators(): void {
    for (;;) {
      if (this.at('newline') || this.at('op', ':')) {
        this.pos += 1
        continue
      }
      if (this.at('comment')) {
        this.pos += 1
        continue
      }
      break
    }
  }

  private endOfStatement(): void {
    if (this.at('comment')) this.pos += 1
    if (this.at('eof')) return
    if (this.at('newline') || this.at('op', ':')) {
      this.pos += 1
      return
    }
    const t = this.peek()
    throw syntaxError(`Syntax error: unexpected ${t.value || 'end of line'}`, t.line)
  }

  /* ----------------------------------------------------------- expressions */

  parseExpr(minPrecedence = 0): Expr {
    let left = this.parseUnary(minPrecedence)

    for (;;) {
      const t = this.peek()
      const isOp = t.kind === 'op' || t.kind === 'keyword'
      const precedence = isOp ? PRECEDENCE[t.value] : undefined
      if (precedence === undefined || precedence < minPrecedence) break

      this.pos += 1
      const nextMin = t.value === '^' ? precedence : precedence + 1
      left = { kind: 'binary', op: t.value as BinaryOp, left, right: this.parseExpr(nextMin) }
    }

    return left
  }

  private parseUnary(minPrecedence: number): Expr {
    // NOT sits below the comparisons, so it only applies where it is allowed to.
    if (this.at('keyword', 'NOT') && minPrecedence <= NOT_PRECEDENCE) {
      this.pos += 1
      return { kind: 'unary', op: 'NOT', operand: this.parseExpr(NOT_PRECEDENCE) }
    }
    if (this.accept('op', '-')) {
      return { kind: 'unary', op: '-', operand: this.parseExpr(NEGATE_PRECEDENCE) }
    }
    if (this.accept('op', '+')) return this.parseUnary(minPrecedence)
    return this.parsePrimary()
  }

  private parsePrimary(): Expr {
    const t = this.next()

    if (t.kind === 'number') return { kind: 'num', value: Number(t.value) }
    if (t.kind === 'string') return { kind: 'str', value: t.value }

    if (t.kind === 'name') {
      if (this.at('op', '(')) {
        return { kind: 'index', name: t.value, args: this.parseArgs() }
      }
      return { kind: 'var', name: t.value }
    }

    if (t.kind === 'op' && t.value === '(') {
      const inner = this.parseExpr()
      this.expect('op', ')')
      return inner
    }

    // SCREEN is a statement *and* a function reading a character off the
    // screen. Only the call form can appear in an expression, so the keyword
    // is safe to reinterpret as a name here.
    if (t.kind === 'keyword' && t.value === 'SCREEN' && this.at('op', '(')) {
      return { kind: 'index', name: 'SCREEN', args: this.parseArgs() }
    }

    throw syntaxError(`Syntax error: unexpected ${t.value || 'end of line'}`, t.line)
  }

  private parseArgs(): Expr[] {
    this.expect('op', '(')
    const args: Expr[] = []
    if (!this.at('op', ')')) {
      args.push(this.parseExpr())
      while (this.accept('op', ',')) args.push(this.parseExpr())
    }
    this.expect('op', ')')
    return args
  }

  private parseLValue(): LValue {
    const name = this.expect('name').value
    const args = this.at('op', '(') ? this.parseArgs() : []
    return { name, args }
  }

  /* ------------------------------------------------------------ statements */

  /** Parse statements until a block-closing keyword or EOF. */
  private parseBody(): Stmt[] {
    const body: Stmt[] = []
    for (;;) {
      this.skipSeparators()
      if (this.at('eof')) break
      const t = this.peek()
      // `END` is both a statement and the start of END IF / END SUB, so it only
      // closes a block when the next word says so.
      if (t.kind === 'keyword' && t.value === 'END' && this.closesBlock()) break
      if (t.kind === 'keyword' && t.value !== 'END' && BLOCK_ENDERS.has(t.value)) break
      // A SUB or FUNCTION always closes module-level flow.
      if (t.kind === 'keyword' && (t.value === 'SUB' || t.value === 'FUNCTION')) break
      body.push(this.parseStatement())
    }
    return body
  }

  /** True when the END at the cursor terminates a block rather than the program. */
  private closesBlock(): boolean {
    const next = this.peek(1)
    return (
      next.kind === 'keyword' &&
      (next.value === 'IF' || next.value === 'SELECT' ||
       next.value === 'SUB' || next.value === 'FUNCTION')
    )
  }

  private parseStatement(): Stmt {
    const line = this.line
    return { ...this.parseStatementNode(), line }
  }

  private parseStatementNode(): StmtNode {
    const t = this.peek()

    // A leading number is a label, exactly as QBasic treats it, so old
    // line-numbered listings still run.
    if (t.kind === 'number' && Number.isInteger(Number(t.value))) {
      this.pos += 1
      return { kind: 'label', name: t.value }
    }

    // `name:` at the start of a statement is a label.
    if (t.kind === 'name' && this.peek(1).kind === 'op' && this.peek(1).value === ':') {
      // Only a label if what follows the colon ends the line or begins a new
      // statement; `a: b = 1` is a label then a statement either way.
      this.pos += 2
      return { kind: 'label', name: t.value }
    }

    if (t.kind === 'keyword') {
      switch (t.value) {
        case 'PRINT': this.pos += 1; return this.finish(this.parsePrint())
        case 'LET': this.pos += 1; return this.finish(this.parseLet())
        case 'INPUT': this.pos += 1; return this.finish(this.parseInput(false))

        case 'CLS': this.pos += 1; return this.finish(this.parseCls())
        case 'END': this.pos += 1; return this.finish({ kind: 'end' })
        case 'STOP': this.pos += 1; return this.finish({ kind: 'end' })
        case 'SYSTEM': this.pos += 1; return this.finish({ kind: 'end' })
        case 'IF': this.pos += 1; return this.parseIf()
        case 'FOR': this.pos += 1; return this.parseFor()
        case 'WHILE': this.pos += 1; return this.parseWhile()
        case 'DO': this.pos += 1; return this.parseDo()
        case 'SELECT': this.pos += 1; return this.parseSelect()
        case 'EXIT': this.pos += 1; return this.finish(this.parseExit())
        case 'GOTO': this.pos += 1; return this.finish({ kind: 'goto', label: this.parseLabelRef() })
        case 'GOSUB': this.pos += 1; return this.finish({ kind: 'gosub', label: this.parseLabelRef() })
        case 'RETURN': this.pos += 1; return this.finish({ kind: 'return' })
        case 'DIM': case 'REDIM': this.pos += 1; return this.finish(this.parseDim())
        case 'CONST': this.pos += 1; return this.finish(this.parseConst())
        case 'DATA': this.pos += 1; return this.finish(this.parseData())
        case 'READ': this.pos += 1; return this.finish(this.parseRead())
        case 'RESTORE': this.pos += 1; return this.finish({ kind: 'restore' })
        case 'CALL': this.pos += 1; return this.finish(this.parseCall())
        case 'RANDOMIZE': {
          this.pos += 1
          const seed = this.startsExpression() ? this.parseExpr() : null
          return this.finish({ kind: 'randomize', seed })
        }
        case 'SWAP': {
          this.pos += 1
          const a = this.parseLValue()
          this.expect('op', ',')
          const b = this.parseLValue()
          return this.finish({ kind: 'swap', a, b })
        }
        case 'SCREEN': this.pos += 1; return this.finish(this.parseScreen())
        case 'PSET': this.pos += 1; return this.finish(this.parsePset(false))
        case 'PRESET': this.pos += 1; return this.finish(this.parsePset(true))
        case 'LINE': this.pos += 1; return this.finish(this.parseLine())
        case 'CIRCLE': this.pos += 1; return this.finish(this.parseCircle())
        case 'PAINT': this.pos += 1; return this.finish(this.parsePaint())
        case 'DRAW': this.pos += 1; return this.finish({ kind: 'draw', macro: this.parseExpr() })
        case 'COLOR': this.pos += 1; return this.finish(this.parseColor())
        case 'LOCATE': this.pos += 1; return this.finish(this.parseLocate())
        case 'VIEW': this.pos += 1; return this.finish(this.parseView())
        case 'WINDOW': this.pos += 1; return this.finish(this.parseWindow())
        case 'PALETTE': this.pos += 1; return this.finish(this.parsePalette())
        case 'GET': this.pos += 1; return this.finish(this.parseGet())
        case 'PUT': this.pos += 1; return this.finish(this.parsePut())
        case 'WIDTH': this.pos += 1; return this.finish(this.parseWidth())
        case 'SLEEP': {
          this.pos += 1
          return this.finish({ kind: 'sleep', seconds: this.startsExpression() ? this.parseExpr() : null })
        }
        case 'BEEP': case 'SOUND': case 'PLAY': {
          this.pos += 1
          return this.finish({ kind: 'sound', args: this.parseOptionalArgs() })
        }
        case 'DECLARE': {
          // Forward declarations carry no runtime meaning here; procedures are
          // collected in a pass before execution regardless.
          this.pos += 1
          while (!this.at('newline') && !this.at('eof')) this.pos += 1
          return this.finish({ kind: 'rem', text: '' })
        }
        default:
          throw syntaxError(`Syntax error: ${t.value} cannot start a statement`, t.line)
      }
    }

    if (t.kind === 'name') {
      // Either an assignment, or a bare SUB call: `PrintTotal 3, 4`.
      const save = this.pos
      const target = this.parseLValue()
      if (this.accept('op', '=')) {
        return this.finish({ kind: 'let', target, value: this.parseExpr() })
      }
      this.pos = save
      return this.finish(this.parseBareCall())
    }

    throw syntaxError(`Syntax error: unexpected ${t.value || 'end of line'}`, t.line)
  }

  /** Consume the statement separator after a single-line statement. */
  private finish(stmt: StmtNode): StmtNode {
    this.endOfStatement()
    return stmt
  }

  private startsExpression(): boolean {
    const t = this.peek()
    if (t.kind === 'number' || t.kind === 'string' || t.kind === 'name') return true
    if (t.kind === 'op' && (t.value === '(' || t.value === '-' || t.value === '+')) return true
    return t.kind === 'keyword' && t.value === 'NOT'
  }

  private parseLabelRef(): string {
    const t = this.peek()
    if (t.kind === 'number' || t.kind === 'name') {
      this.pos += 1
      return t.value
    }
    throw syntaxError('Syntax error: expected a label', t.line)
  }

  private parsePrint(): StmtNode {
    const items: PrintItem[] = []
    while (this.startsExpression() || this.at('op', ';') || this.at('op', ',')) {
      if (this.accept('op', ';')) {
        items.push({ expr: null, separator: ';' })
        continue
      }
      if (this.accept('op', ',')) {
        items.push({ expr: null, separator: ',' })
        continue
      }
      const expr = this.parseExpr()
      let separator: PrintItem['separator'] = null
      if (this.accept('op', ';')) separator = ';'
      else if (this.accept('op', ',')) separator = ','
      items.push({ expr, separator })
      if (separator === null) break
    }
    return { kind: 'print', items }
  }

  private parseLet(): StmtNode {
    const target = this.parseLValue()
    this.expect('op', '=')
    return { kind: 'let', target, value: this.parseExpr() }
  }

  private parseInput(wholeLine: boolean): StmtNode {
    let prompt: string | null = null
    if (this.at('string')) {
      prompt = this.next().value
      if (!this.accept('op', ';')) this.accept('op', ',')
    }
    const targets = [this.parseLValue()]
    while (this.accept('op', ',')) targets.push(this.parseLValue())
    return { kind: 'input', prompt, targets, wholeLine }
  }

  private parseIf(): StmtNode {
    const condition = this.parseExpr()
    this.expect('keyword', 'THEN')

    // Single-line form: everything up to the end of the line, with an optional
    // ELSE tail. No END IF.
    if (!this.at('newline') && !this.at('eof') && !this.at('comment')) {
      const body = this.parseInlineBody()
      let otherwise: Stmt[] | null = null
      if (this.accept('keyword', 'ELSE')) otherwise = this.parseInlineBody()
      this.endOfStatement()
      return { kind: 'if', arms: [{ condition, body }], else: otherwise }
    }

    // Block form.
    const arms = [{ condition, body: this.parseBody() }]
    let otherwise: Stmt[] | null = null

    for (;;) {
      if (this.accept('keyword', 'ELSEIF')) {
        const c = this.parseExpr()
        this.expect('keyword', 'THEN')
        arms.push({ condition: c, body: this.parseBody() })
        continue
      }
      if (this.accept('keyword', 'ELSE')) {
        otherwise = this.parseBody()
        continue
      }
      break
    }

    this.expect('keyword', 'END')
    this.expect('keyword', 'IF')
    this.endOfStatement()
    return { kind: 'if', arms, else: otherwise }
  }

  /** Statements on one physical line, for the single-line IF form. */
  private parseInlineBody(): Stmt[] {
    const body: Stmt[] = []
    for (;;) {
      if (this.at('newline') || this.at('eof') || this.at('comment')) break
      if (this.at('keyword', 'ELSE')) break
      // A bare number after THEN is the old `IF x THEN 100` shorthand.
      if (this.at('number')) {
        const t = this.next()
        body.push({ kind: 'goto', label: t.value, line: t.line })
      } else {
        body.push(this.parseInlineStatement())
      }
      if (!this.accept('op', ':')) break
    }
    return body
  }

  /**
   * Parse one statement without consuming the trailing separator — the inline
   * body handles separators itself.
   */
  private parseInlineStatement(): Stmt {
    const line = this.line
    return { ...this.parseInlineStatementNode(), line }
  }

  private parseInlineStatementNode(): StmtNode {
    const mark = this.pos
    // Reuse parseStatement, but undo its separator consumption by parsing into
    // a sub-parser is overkill; instead temporarily treat ':'/newline as the
    // terminator by parsing the statement kinds that can appear inline.
    const t = this.peek()
    if (t.kind === 'keyword') {
      switch (t.value) {
        case 'PRINT': this.pos += 1; return this.parsePrint()
        case 'LET': this.pos += 1; return this.parseLet()
        case 'INPUT': this.pos += 1; return this.parseInput(false)
        case 'CLS': this.pos += 1; return this.parseCls()
        case 'END': this.pos += 1; return { kind: 'end' }
        case 'SCREEN': this.pos += 1; return this.parseScreen()
        case 'PSET': this.pos += 1; return this.parsePset(false)
        case 'PRESET': this.pos += 1; return this.parsePset(true)
        case 'LINE': this.pos += 1; return this.parseLine()
        case 'CIRCLE': this.pos += 1; return this.parseCircle()
        case 'PAINT': this.pos += 1; return this.parsePaint()
        case 'DRAW': this.pos += 1; return { kind: 'draw', macro: this.parseExpr() }
        case 'COLOR': this.pos += 1; return this.parseColor()
        case 'LOCATE': this.pos += 1; return this.parseLocate()
        case 'VIEW': this.pos += 1; return this.parseView()
        case 'WINDOW': this.pos += 1; return this.parseWindow()
        case 'PALETTE': this.pos += 1; return this.parsePalette()
        case 'GET': this.pos += 1; return this.parseGet()
        case 'PUT': this.pos += 1; return this.parsePut()
        case 'WIDTH': this.pos += 1; return this.parseWidth()
        case 'SLEEP':
          this.pos += 1
          return { kind: 'sleep', seconds: this.startsExpression() ? this.parseExpr() : null }
        case 'BEEP': case 'SOUND': case 'PLAY':
          this.pos += 1
          return { kind: 'sound', args: this.parseOptionalArgs() }
        case 'STOP': this.pos += 1; return { kind: 'end' }
        case 'GOTO': this.pos += 1; return { kind: 'goto', label: this.parseLabelRef() }
        case 'GOSUB': this.pos += 1; return { kind: 'gosub', label: this.parseLabelRef() }
        case 'RETURN': this.pos += 1; return { kind: 'return' }
        case 'EXIT': this.pos += 1; return this.parseExit()
        case 'READ': this.pos += 1; return this.parseRead()
        case 'RESTORE': this.pos += 1; return { kind: 'restore' }
        case 'CALL': this.pos += 1; return this.parseCall()
        default:
          throw syntaxError(`Syntax error: ${t.value} is not allowed here`, t.line)
      }
    }
    if (t.kind === 'name') {
      const target = this.parseLValue()
      if (this.accept('op', '=')) {
        return { kind: 'let', target, value: this.parseExpr() }
      }
      this.pos = mark
      return this.parseBareCall()
    }
    throw syntaxError(`Syntax error: unexpected ${t.value || 'end of line'}`, t.line)
  }

  private parseFor(): StmtNode {
    const name = this.expect('name').value
    this.expect('op', '=')
    const from = this.parseExpr()
    this.expect('keyword', 'TO')
    const to = this.parseExpr()
    const step = this.accept('keyword', 'STEP') ? this.parseExpr() : null
    const body = this.parseBody()
    this.expect('keyword', 'NEXT')
    // `NEXT`, `NEXT I`, and `NEXT I, J` are all legal; the name is decorative
    // here because the block structure already says which loop is closing.
    if (this.at('name')) {
      this.pos += 1
      while (this.accept('op', ',')) this.expect('name')
    }
    this.endOfStatement()
    return { kind: 'for', name, from, to, step, body }
  }

  private parseWhile(): StmtNode {
    const condition = this.parseExpr()
    const body = this.parseBody()
    this.expect('keyword', 'WEND')
    this.endOfStatement()
    return { kind: 'while', condition, body }
  }

  private parseDo(): StmtNode {
    let condition: Expr | null = null
    let until = false
    let post = false

    if (this.accept('keyword', 'WHILE')) condition = this.parseExpr()
    else if (this.accept('keyword', 'UNTIL')) {
      condition = this.parseExpr()
      until = true
    }

    const body = this.parseBody()
    this.expect('keyword', 'LOOP')

    if (condition === null) {
      if (this.accept('keyword', 'WHILE')) {
        condition = this.parseExpr()
        post = true
      } else if (this.accept('keyword', 'UNTIL')) {
        condition = this.parseExpr()
        until = true
        post = true
      }
    }

    this.endOfStatement()
    return { kind: 'do', condition, until, post, body }
  }

  private parseSelect(): StmtNode {
    this.expect('keyword', 'CASE')
    const subject = this.parseExpr()
    const arms: CaseArm[] = []

    this.skipSeparators()
    while (this.accept('keyword', 'CASE')) {
      const tests: CaseTest[] = []
      if (this.accept('keyword', 'ELSE')) {
        // CASE ELSE: no tests.
      } else {
        tests.push(this.parseCaseTest())
        while (this.accept('op', ',')) tests.push(this.parseCaseTest())
      }
      // A colon after the case list is optional.
      this.accept('op', ':')
      arms.push({ tests, body: this.parseBody() })
    }

    this.expect('keyword', 'END')
    this.expect('keyword', 'SELECT')
    this.endOfStatement()
    return { kind: 'select', subject, arms }
  }

  private parseCaseTest(): CaseTest {
    if (this.accept('keyword', 'IS')) {
      const t = this.next()
      if (t.kind !== 'op' || !PRECEDENCE[t.value]) {
        throw syntaxError('Syntax error: expected a comparison after IS', t.line)
      }
      return { kind: 'compare', op: t.value as BinaryOp, value: this.parseExpr() }
    }
    const value = this.parseExpr()
    if (this.accept('keyword', 'TO')) {
      return { kind: 'range', from: value, to: this.parseExpr() }
    }
    return { kind: 'value', value }
  }

  private parseExit(): StmtNode {
    const t = this.expect('keyword')
    if (t.value !== 'FOR' && t.value !== 'DO' && t.value !== 'SUB' && t.value !== 'FUNCTION') {
      throw syntaxError('Syntax error: EXIT needs FOR, DO, SUB or FUNCTION', t.line)
    }
    return { kind: 'exit', target: t.value }
  }

  private parseDim(): StmtNode {
    const shared = this.accept('keyword', 'SHARED')
    const entries: { name: string; dims: Expr[] }[] = []
    do {
      const name = this.expect('name').value
      const dims = this.at('op', '(') ? this.parseArgs() : []
      // `DIM x AS INTEGER` — the type is accepted and ignored; the suffix
      // convention is what actually decides string vs number here.
      if (this.accept('keyword', 'AS')) this.next() // the type name is accepted and ignored
      entries.push({ name, dims })
    } while (this.accept('op', ','))
    return { kind: 'dim', entries, shared }
  }

  private parseConst(): StmtNode {
    const entries: { name: string; value: Expr }[] = []
    do {
      const name = this.expect('name').value
      this.expect('op', '=')
      entries.push({ name, value: this.parseExpr() })
    } while (this.accept('op', ','))
    return { kind: 'const', entries }
  }

  private parseData(): StmtNode {
    const values: (string | number)[] = []
    do {
      const t = this.next()
      if (t.kind === 'string') values.push(t.value)
      else if (t.kind === 'number') values.push(Number(t.value))
      else if (t.kind === 'op' && t.value === '-') {
        values.push(-Number(this.expect('number').value))
      } else if (t.kind === 'name') values.push(t.value)
      else throw syntaxError('Syntax error: bad DATA value', t.line)
    } while (this.accept('op', ','))
    return { kind: 'data', values }
  }

  private parseRead(): StmtNode {
    const targets = [this.parseLValue()]
    while (this.accept('op', ',')) targets.push(this.parseLValue())
    return { kind: 'read', targets }
  }

  private parseCall(): StmtNode {
    const name = this.expect('name').value
    const args = this.at('op', '(') ? this.parseArgs() : []
    return { kind: 'call', name, args }
  }

  /** `MySub 1, 2` — a call without the CALL keyword or parentheses. */
  private parseBareCall(): StmtNode {
    const name = this.expect('name').value
    const args: Expr[] = []
    if (this.startsExpression()) {
      args.push(this.parseExpr())
      while (this.accept('op', ',')) args.push(this.parseExpr())
    }
    return { kind: 'call', name, args }
  }

  /* -------------------------------------------------------------- graphics */

  /** True at anything that terminates a statement. */
  private atStatementEnd(): boolean {
    return (
      this.at('newline') ||
      this.at('eof') ||
      this.at('comment') ||
      this.at('op', ':') ||
      this.at('keyword', 'ELSE')
    )
  }

  /**
   * An argument that may be left out.
   *
   * The graphics statements are full of holes - `LINE (0,0)-(9,9), , BF` skips
   * the colour and `LOCATE , 5` skips the row - so almost every argument
   * position has to cope with finding a comma where a value should be.
   */
  private parseOptionalExpr(): Expr | null {
    if (this.atStatementEnd() || this.at('op', ',')) return null
    return this.parseExpr()
  }

  /** `[STEP] (x, y)` - a point, absolute or relative to the graphics cursor. */
  private parseCoord(): Coord {
    const step = this.accept('keyword', 'STEP')
    this.expect('op', '(')
    const x = this.parseExpr()
    this.expect('op', ',')
    const y = this.parseExpr()
    this.expect('op', ')')
    return { step, x, y }
  }

  /** True where a coordinate could start, so an optional one can be spotted. */
  private atCoord(): boolean {
    return this.at('op', '(') || this.at('keyword', 'STEP')
  }

  /** Arguments to a statement that takes them bare: `SOUND 440, 2`. */
  private parseOptionalArgs(): Expr[] {
    const args: Expr[] = []
    if (!this.startsExpression()) return args
    args.push(this.parseExpr())
    while (this.accept('op', ',')) args.push(this.parseExpr())
    return args
  }

  private parseCls(): StmtNode {
    return { kind: 'cls', target: this.startsExpression() ? this.parseExpr() : null }
  }

  private parseScreen(): StmtNode {
    const mode = this.parseExpr()
    let colorSwitch: Expr | null = null
    if (this.accept('op', ',')) colorSwitch = this.parseOptionalExpr()
    // The active and visual page numbers only mattered on hardware with more
    // than one page of video memory; they are accepted and dropped.
    while (this.accept('op', ',')) this.parseOptionalExpr()
    return { kind: 'screen', mode, colorSwitch }
  }

  private parsePset(preset: boolean): StmtNode {
    const at = this.parseCoord()
    const color = this.accept('op', ',') ? this.parseOptionalExpr() : null
    return { kind: 'pset', at, color, preset }
  }

  /**
   * LINE, which is two unrelated statements sharing a keyword: the graphics
   * one, and `LINE INPUT`, which reads a whole line including its commas.
   */
  private parseLine(): StmtNode {
    if (this.accept('keyword', 'INPUT')) return this.parseInput(true)

    // `LINE -(x,y)` continues from the graphics cursor.
    const from = this.atCoord() ? this.parseCoord() : null
    this.expect('op', '-')
    const to = this.parseCoord()

    let color: Expr | null = null
    let shape: LineShape = 'line'
    let style: Expr | null = null

    if (this.accept('op', ',')) {
      color = this.parseOptionalExpr()
      if (this.accept('op', ',')) {
        // B and BF are bare names, not keywords - `B` stays a usable variable.
        if (this.at('name', 'B')) {
          this.pos += 1
          shape = 'box'
        } else if (this.at('name', 'BF')) {
          this.pos += 1
          shape = 'boxfill'
        }
        if (this.accept('op', ',')) style = this.parseOptionalExpr()
      }
    }

    return { kind: 'line', from, to, color, shape, style }
  }

  private parseCircle(): StmtNode {
    const at = this.parseCoord()
    this.expect('op', ',')
    const radius = this.parseExpr()
    let color: Expr | null = null
    let start: Expr | null = null
    let end: Expr | null = null
    let aspect: Expr | null = null
    if (this.accept('op', ',')) {
      color = this.parseOptionalExpr()
      if (this.accept('op', ',')) {
        start = this.parseOptionalExpr()
        if (this.accept('op', ',')) {
          end = this.parseOptionalExpr()
          if (this.accept('op', ',')) aspect = this.parseOptionalExpr()
        }
      }
    }
    return { kind: 'circle', at, radius, color, start, end, aspect }
  }

  private parsePaint(): StmtNode {
    const at = this.parseCoord()
    let color: Expr | null = null
    let border: Expr | null = null
    if (this.accept('op', ',')) {
      color = this.parseOptionalExpr()
      if (this.accept('op', ',')) {
        border = this.parseOptionalExpr()
        // A background argument follows on hardware that could tile a fill.
        if (this.accept('op', ',')) this.parseOptionalExpr()
      }
    }
    return { kind: 'paint', at, color, border }
  }

  private parseColor(): StmtNode {
    const a = this.parseOptionalExpr()
    let b: Expr | null = null
    let c: Expr | null = null
    if (this.accept('op', ',')) {
      b = this.parseOptionalExpr()
      if (this.accept('op', ',')) c = this.parseOptionalExpr()
    }
    return { kind: 'color', a, b, c }
  }

  private parseLocate(): StmtNode {
    const row = this.parseOptionalExpr()
    let col: Expr | null = null
    let cursor: Expr | null = null
    if (this.accept('op', ',')) {
      col = this.parseOptionalExpr()
      if (this.accept('op', ',')) {
        cursor = this.parseOptionalExpr()
        // The two remaining arguments shaped the hardware cursor's scan lines.
        while (this.accept('op', ',')) this.parseOptionalExpr()
      }
    }
    return { kind: 'locate', row, col, cursor }
  }

  /** `VIEW PRINT` and `VIEW` are different statements behind one keyword. */
  private parseView(): StmtNode {
    if (this.accept('keyword', 'PRINT')) {
      if (this.atStatementEnd()) return { kind: 'viewprint', top: null, bottom: null }
      const top = this.parseExpr()
      this.expect('keyword', 'TO')
      return { kind: 'viewprint', top, bottom: this.parseExpr() }
    }

    const screen = this.accept('keyword', 'SCREEN')
    if (!this.atCoord()) return { kind: 'view', box: null, screen, fill: null, border: null }

    const from = this.parseCoord()
    this.expect('op', '-')
    const to = this.parseCoord()
    let fill: Expr | null = null
    let border: Expr | null = null
    if (this.accept('op', ',')) {
      fill = this.parseOptionalExpr()
      if (this.accept('op', ',')) border = this.parseOptionalExpr()
    }
    return { kind: 'view', box: [from, to], screen, fill, border }
  }

  private parseWindow(): StmtNode {
    const screen = this.accept('keyword', 'SCREEN')
    if (!this.atCoord()) return { kind: 'window', box: null, screen }
    const from = this.parseCoord()
    this.expect('op', '-')
    const to = this.parseCoord()
    return { kind: 'window', box: [from, to], screen }
  }

  private parsePalette(): StmtNode {
    if (this.accept('keyword', 'USING')) {
      return { kind: 'palette', attr: null, color: null, using: this.parseLValue() }
    }
    if (this.atStatementEnd()) return { kind: 'palette', attr: null, color: null, using: null }
    const attr = this.parseExpr()
    this.expect('op', ',')
    return { kind: 'palette', attr, color: this.parseExpr(), using: null }
  }

  private parseGet(): StmtNode {
    const from = this.parseCoord()
    this.expect('op', '-')
    const to = this.parseCoord()
    this.expect('op', ',')
    return { kind: 'get', from, to, target: this.parseLValue() }
  }

  private parsePut(): StmtNode {
    const at = this.parseCoord()
    this.expect('op', ',')
    const source = this.parseLValue()
    let action: PutAction = 'XOR'
    if (this.accept('op', ',')) {
      const t = this.expect('keyword')
      if (!['PSET', 'PRESET', 'AND', 'OR', 'XOR'].includes(t.value)) {
        throw syntaxError(`Syntax error: ${t.value} is not a PUT action`, t.line)
      }
      action = t.value as PutAction
    }
    return { kind: 'put', at, source, action }
  }

  private parseWidth(): StmtNode {
    const cols = this.parseOptionalExpr()
    const rows = this.accept('op', ',') ? this.parseOptionalExpr() : null
    return { kind: 'width', cols, rows }
  }

  /* -------------------------------------------------------------- program */

  parseProgram(): Program {
    const body: Stmt[] = []
    const procedures: Procedure[] = []

    for (;;) {
      this.skipSeparators()
      if (this.at('eof')) break

      if (this.at('keyword', 'SUB') || this.at('keyword', 'FUNCTION')) {
        procedures.push(this.parseProcedure())
        continue
      }

      const before = this.pos
      body.push(...this.parseBody())
      // parseBody stops at a block ender it cannot consume; that means the
      // program has a stray END IF / NEXT / LOOP with no opener.
      if (this.pos === before && !this.at('eof')) {
        const t = this.peek()
        throw syntaxError(`Syntax error: unexpected ${t.value}`, t.line)
      }
    }

    return { body, procedures }
  }

  private parseProcedure(): Procedure {
    const isFunction = this.next().value === 'FUNCTION'
    const name = this.expect('name').value

    const params: string[] = []
    if (this.at('op', '(')) {
      this.expect('op', '(')
      if (!this.at('op', ')')) {
        do {
          params.push(this.expect('name').value)
          if (this.accept('keyword', 'AS')) this.next() // the type name is accepted and ignored
        } while (this.accept('op', ','))
      }
      this.expect('op', ')')
    }
    this.endOfStatement()

    const body = this.parseBody()
    this.expect('keyword', 'END')
    this.expect('keyword', isFunction ? 'FUNCTION' : 'SUB')
    this.endOfStatement()

    return { name, params, body, isFunction }
  }
}

export function parseProgram(source: string): Program {
  return new Parser(tokenize(source)).parseProgram()
}

/** Expression parser exposed for tests. */
export function parseExpression(source: string): Expr {
  return new Parser(tokenize(source)).parseExpr()
}
