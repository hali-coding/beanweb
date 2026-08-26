import type { Coord, Expr, GraphicsStmt, LValue, PrintItem } from './ast'
import { BUILTINS, NULLARY_BUILTINS, isBuiltin } from './builtins'
import type { BuiltinContext } from './builtins'
import type { Compiled, Instr, ProcedureInfo } from './compiler'
import { BasicError } from './errors'
import { draw } from './gml'
import type { Host } from './host'
import { Screen } from './screen'
import type { PutAction, Sprite } from './screen'
import {
  FALSE,
  TRUE,
  compare,
  defaultFor,
  formatNumber,
  isString,
  isStringName,
  toNumber,
} from './values'
import type { Value } from './values'

/**
 * The virtual machine.
 *
 * `step()` executes exactly one instruction and returns. Nothing here loops
 * until a program finishes, because `DO : LOOP` is a legal program: run it to
 * completion on the main thread and the tab is gone, and Stop can never fire
 * because the event loop it needs is the one being blocked.
 *
 * `runSlice()` is the only thing that loops, and only against a clock.
 */

export type Status = 'ready' | 'running' | 'awaiting-input' | 'done' | 'error'

export interface SliceOptions {
  budgetMs?: number
  maxSteps?: number
}

interface ArrayValue {
  /** Size of each dimension; indices run 0..size-1. */
  dims: number[]
  data: Value[]
}

interface Frame {
  vars: Map<string, Value>
  arrays: Map<string, ArrayValue>
  /** Live FOR loops, keyed by control variable. */
  loops: Map<string, { limit: number; step: number }>
  /** Where to resume; -1 marks a FUNCTION call, whose caller restores the pc. */
  returnPc: number
  proc: ProcedureInfo | null
}

const PRINT_ZONE = 14

/**
 * A FUNCTION called from inside an expression runs to completion within one
 * step, because expressions are evaluated as a tree rather than compiled to a
 * value stack. This ceiling keeps a runaway function an error instead of a
 * frozen tab — the one place the step budget is approximated.
 */
const FUNCTION_STEP_LIMIT = 200000

export class Interpreter {
  status: Status = 'ready'
  error: BasicError | null = null
  pendingInput: { prompt: string; targets: LValue[]; wholeLine: boolean } | null = null
  /** Source lines that pause execution before running. */
  breakpoints = new Set<number>()

  /**
   * The screen the program draws on. Owned outside the VM when the app passes
   * one in, so the screen window can hold a single stable object across runs
   * while each Run gets a fresh interpreter.
   */
  readonly screen: Screen

  private readonly program: Compiled
  private readonly host: Host
  private readonly now: () => number

  private pc = 0
  private frames: Frame[] = []
  private gosubStack: number[] = []
  private dataPointer = 0
  private column = 0
  private steps = 0
  private skipBreakOnce = false
  /** Row last executed, so a breakpoint fires once per entry to its line. */
  private lastLine: number | null = null
  private seed = 1
  /** Names declared DIM SHARED, visible inside procedures. */
  private shared = new Set<string>()
  /** Set by endproc so a FUNCTION's value survives its frame being popped. */
  private lastReturn: Value | undefined

  /**
   * Sprites captured by GET, keyed by the array they were stored in and the
   * element they start at.
   *
   * QBasic packed the pixels into the array's own bytes, which a program could
   * then poke at. Keeping them beside the array instead means a blit is exact
   * in every mode; the array still receives the two header words a listing
   * might read, and the packed body is the one thing not reproduced. GET
   * followed by PUT — which is all any listing does — behaves identically.
   */
  private sprites = new Map<ArrayValue, Map<number, Sprite>>()

  /** Wall-clock deadline for SLEEP n; 0 when not sleeping. */
  private sleepUntil = 0
  /** Set by a bare SLEEP, which waits for a keystroke rather than a clock. */
  private sleepForKey = false
  /** Whether the app has been told to show the screen for this mode. */
  private announced = false

  constructor(
    program: Compiled,
    host: Host,
    now: () => number = () => performance.now(),
    screen: Screen = new Screen(0),
  ) {
    this.program = program
    this.host = host
    this.now = now
    this.screen = screen
  }

  /* ---------------------------------------------------------------- public */

  start(): void {
    this.pc = 0
    this.frames = [
      { vars: new Map(), arrays: new Map(), loops: new Map(), returnPc: -1, proc: null },
    ]
    this.gosubStack = []
    this.dataPointer = 0
    this.column = 0
    this.steps = 0
    this.error = null
    this.pendingInput = null
    this.lastReturn = undefined
    this.lastLine = null
    this.shared.clear()
    this.seed = 1
    this.sprites.clear()
    this.sleepUntil = 0
    this.sleepForKey = false
    this.announced = false
    this.screen.setMode(0, 1)
    this.status = this.program.code.length ? 'running' : 'done'
  }

  stop(): void {
    if (this.status === 'running' || this.status === 'awaiting-input') this.status = 'done'
  }

  resume(): void {
    if (this.status !== 'ready') return
    this.skipBreakOnce = true
    this.status = 'running'
  }

  get stepCount(): number {
    return this.steps
  }

  /** The source line about to execute — the debugger's current-line marker. */
  get currentLine(): number | null {
    return this.program.code[this.pc]?.line ?? null
  }

  /** Module-level variables, for a watch window. */
  variables(): ReadonlyMap<string, Value> {
    return this.frames[0]?.vars ?? new Map()
  }

  runSlice(options: SliceOptions = {}): Status {
    const { budgetMs = 8, maxSteps } = options
    const started = this.now()
    let taken = 0

    while (this.status === 'running') {
      if (maxSteps !== undefined && taken >= maxSteps) break
      // A sleeping program is still running; it just has nothing to do until
      // its deadline, so the slice ends and the pump waits it out.
      if (this.sleeping()) break

      const line = this.program.code[this.pc]?.line
      if (
        line !== undefined &&
        this.breakpoints.has(line) &&
        line !== this.lastLine &&
        !this.skipBreakOnce
      ) {
        this.status = 'ready'
        break
      }
      this.skipBreakOnce = false
      if (line !== undefined) this.lastLine = line

      this.step()
      taken += 1

      if (maxSteps === undefined && this.now() - started >= budgetMs) break
    }

    return this.status
  }

  /**
   * Whether SLEEP is still holding the program, clearing the hold when it is
   * over. A bare SLEEP ends on the next keystroke, a timed one on the clock.
   */
  private sleeping(): boolean {
    if (this.sleepForKey) {
      if (!this.host.inkey()) return true
      this.sleepForKey = false
      return false
    }
    if (this.sleepUntil === 0) return false
    if (this.now() < this.sleepUntil) return true
    this.sleepUntil = 0
    return false
  }

  /**
   * How long the program wants to be left alone, in milliseconds. The pump
   * uses it as its next timeout so a `SLEEP 5` costs five timers, not five
   * thousand.
   */
  get sleepDelayMs(): number {
    if (this.sleepForKey) return 30
    if (this.sleepUntil === 0) return 0
    return Math.max(0, this.sleepUntil - this.now())
  }

  /** Execute exactly one instruction. The unit the debugger steps by. */
  step(): Status {
    if (this.status !== 'running' && this.status !== 'ready') return this.status
    this.status = 'running'

    const instr = this.program.code[this.pc]
    if (!instr) {
      this.status = 'done'
      return this.status
    }

    this.steps += 1
    try {
      this.exec(instr)
    } catch (err) {
      this.error =
        err instanceof BasicError ? err : new BasicError(`?${(err as Error).message}`, instr.line)
      this.status = 'error'
    }
    return this.status
  }

  resumeInput(text: string): void {
    const pending = this.pendingInput
    if (!pending || this.status !== 'awaiting-input') return
    const line = this.currentLine ?? 1
    const parts = pending.wholeLine ? [text] : text.split(',')

    try {
      pending.targets.forEach((target, i) => {
        if (isStringName(target.name)) {
          this.assign(target, pending.wholeLine ? text : (parts[i] ?? '').trim(), line)
        } else {
          const raw = (parts[i] ?? '').trim()
          const n = Number(raw)
          // A vintage interpreter re-asks on bad numeric input; treating it as
          // zero is simpler and kinder.
          this.assign(target, raw !== '' && Number.isFinite(n) ? n : 0, line)
        }
      })
    } catch (err) {
      this.error = err instanceof BasicError ? err : new BasicError(String(err), line)
      this.status = 'error'
      this.pendingInput = null
      return
    }

    this.pendingInput = null
    this.screen.write(`${text}\n`)
    this.status = 'running'
    this.pc += 1
  }

  /* -------------------------------------------------------------- frames */

  private get frame(): Frame {
    return this.frames[this.frames.length - 1]
  }

  /**
   * Where a name lives. Inside a procedure a name is local unless it was
   * declared DIM SHARED, which is how QBasic scopes things.
   */
  private scopeFor(name: string): Frame {
    if (this.frames.length === 1) return this.frames[0]
    if (this.shared.has(name)) return this.frames[0]
    return this.frame
  }

  /* ---------------------------------------------------------------- exec */

  private exec(instr: Instr): void {
    const line = instr.line

    switch (instr.op) {
      case 'nop':
        this.pc += 1
        return

      case 'print':
        this.execPrint(instr.items, line)
        this.pc += 1
        return

      case 'assign':
        this.assign(instr.target, this.eval(instr.value, line), line)
        this.pc += 1
        return

      case 'input':
        this.pendingInput = {
          prompt: instr.prompt ?? '',
          targets: instr.targets,
          wholeLine: instr.wholeLine,
        }
        // The prompt belongs on the screen as well as in the console: a
        // program that asks a question in SCREEN 13 asks it there.
        this.screen.write(`${instr.prompt ?? ''}? `)
        this.status = 'awaiting-input'
        return // pc advances in resumeInput

      case 'jump':
        this.pc = instr.target
        return

      case 'jumpIf':
        this.pc = this.truth(instr.cond, line) ? instr.target : this.pc + 1
        return

      case 'jumpUnless':
        this.pc = this.truth(instr.cond, line) ? this.pc + 1 : instr.target
        return

      case 'forInit': {
        const from = toNumber(this.eval(instr.from, line), line)
        const limit = toNumber(this.eval(instr.to, line), line)
        const step = instr.step ? toNumber(this.eval(instr.step, line), line) : 1
        if (step === 0) throw new BasicError('?FOR step of zero', line)

        this.setVar(instr.name, from, line)
        this.frame.loops.set(instr.name, { limit, step })
        // A loop whose range is empty never enters the body.
        this.pc = exhausted(from, limit, step) ? instr.exit : this.pc + 1
        return
      }

      case 'forNext': {
        const loop = this.frame.loops.get(instr.name)
        if (!loop) throw new BasicError('?NEXT without FOR', line)
        const value = toNumber(this.getVar(instr.name), line) + loop.step
        this.setVar(instr.name, value, line)
        if (exhausted(value, loop.limit, loop.step)) {
          this.frame.loops.delete(instr.name)
          this.pc += 1
        } else {
          this.pc = instr.body
        }
        return
      }

      case 'gosub':
        this.gosubStack.push(this.pc + 1)
        this.pc = instr.target
        return

      case 'retsub': {
        const target = this.gosubStack.pop()
        if (target === undefined) throw new BasicError('?RETURN without GOSUB', line)
        this.pc = target
        return
      }

      case 'call': {
        const info = this.program.procedures.get(instr.name)
        if (!info) throw new BasicError(`?Undefined procedure: ${instr.name}`, line)
        const args = instr.args.map((a) => this.eval(a, line))
        if (info.isFunction) {
          // Calling a FUNCTION as a statement is legal; the result is discarded.
          this.callFunction(info, args, line)
          this.pc += 1
          return
        }
        this.enter(info, args, this.pc + 1, line)
        return
      }

      case 'endproc': {
        const frame = this.frames.pop()
        if (!frame) {
          this.status = 'done'
          return
        }
        if (frame.proc?.isFunction) this.lastReturn = frame.vars.get(frame.proc.name)
        // A FUNCTION call restores the pc in callFunction; a SUB resumes here.
        if (frame.returnPc >= 0) this.pc = frame.returnPc
        if (this.frames.length === 0) this.status = 'done'
        return
      }

      case 'dim':
        for (const entry of instr.entries) {
          if (instr.shared) this.shared.add(entry.name)
          const dims = entry.dims.map((d) => Math.trunc(toNumber(this.eval(d, line), line)) + 1)
          this.declareArray(entry.name, dims.length ? dims : [11], line)
        }
        this.pc += 1
        return

      case 'const':
        for (const entry of instr.entries) {
          this.setVar(entry.name, this.eval(entry.value, line), line)
        }
        this.pc += 1
        return

      case 'read':
        for (const target of instr.targets) {
          if (this.dataPointer >= this.program.data.length) {
            throw new BasicError('?Out of DATA', line)
          }
          this.assign(target, this.program.data[this.dataPointer++], line)
        }
        this.pc += 1
        return

      case 'restore':
        this.dataPointer = 0
        this.pc += 1
        return

      case 'randomize': {
        const seed = instr.seed ? toNumber(this.eval(instr.seed, line), line) : 1
        // A fixed LCG, so RANDOMIZE with the same seed replays the same run.
        this.seed = Math.trunc(Math.abs(seed)) || 1
        this.pc += 1
        return
      }

      case 'swap': {
        const a = this.readLValue(instr.a, line)
        const b = this.readLValue(instr.b, line)
        this.assign(instr.a, b, line)
        this.assign(instr.b, a, line)
        this.pc += 1
        return
      }

      case 'gfx':
        this.execGraphics(instr.stmt, line)
        this.pc += 1
        return

      case 'end':
        this.status = 'done'
        return
    }
  }

  private enter(info: ProcedureInfo, args: Value[], returnPc: number, line: number): void {
    if (args.length !== info.params.length) {
      throw new BasicError(`?Wrong number of arguments to ${info.name}`, line)
    }
    const frame: Frame = {
      vars: new Map(),
      arrays: new Map(),
      loops: new Map(),
      returnPc,
      proc: info,
    }
    // Arguments are passed by value. QBasic passes by reference; this is a
    // deliberate simplification, and the only place the dialect differs.
    info.params.forEach((param, i) => frame.vars.set(param, args[i]))
    if (info.isFunction) frame.vars.set(info.name, defaultFor(info.name))
    this.frames.push(frame)
    this.pc = info.start
  }

  /**
   * Run a FUNCTION to completion and hand back its value. Bounded, so a
   * runaway function raises an error rather than hanging the browser.
   */
  private callFunction(info: ProcedureInfo, args: Value[], line: number): Value {
    const savedPc = this.pc
    const depth = this.frames.length
    this.lastReturn = undefined

    this.enter(info, args, -1, line)
    let steps = 0

    while (this.frames.length > depth && this.status === 'running') {
      if (++steps > FUNCTION_STEP_LIMIT) {
        throw new BasicError(`?${info.name} ran too long`, line)
      }
      const instr = this.program.code[this.pc]
      if (!instr) break
      if (instr.op === 'input') {
        throw new BasicError('?INPUT is not allowed inside a FUNCTION', line)
      }
      this.steps += 1
      this.exec(instr)
    }

    // If the body fell off the end without endproc, drop its frame anyway.
    if (this.frames.length > depth) {
      const frame = this.frames.pop()!
      this.lastReturn = frame.vars.get(info.name)
    }

    this.pc = savedPc
    return this.lastReturn ?? defaultFor(info.name)
  }

  /* ------------------------------------------------------------- graphics */

  /** Tell the app to show the screen, once per run and once per mode change. */
  private announce(): void {
    if (this.announced) return
    this.announced = true
    this.host.show()
  }

  /** Evaluate a coordinate pair, resolving STEP against the graphics cursor. */
  private coord(c: Coord, line: number): { x: number; y: number } {
    const x = toNumber(this.eval(c.x, line), line)
    const y = toNumber(this.eval(c.y, line), line)
    return c.step ? { x: this.screen.lastX + x, y: this.screen.lastY + y } : { x, y }
  }

  /** An optional numeric argument. */
  private optional(expr: Expr | null, line: number): number | null {
    return expr === null ? null : toNumber(this.eval(expr, line), line)
  }

  /** An optional colour, falling back to whatever COLOR last chose. */
  private colour(expr: Expr | null, line: number, fallback = this.screen.foreground): number {
    const v = this.optional(expr, line)
    return v === null ? fallback : Math.trunc(v)
  }

  private execGraphics(stmt: GraphicsStmt, line: number): void {
    const screen = this.screen

    switch (stmt.kind) {
      case 'cls': {
        const target = this.optional(stmt.target, line)
        screen.cls(target === null ? null : Math.trunc(target))
        // The transcript has no viewports, so any CLS clears all of it.
        this.host.cls()
        this.column = 0
        return
      }

      case 'screen': {
        const mode = Math.trunc(toNumber(this.eval(stmt.mode, line), line))
        screen.setMode(mode, line)
        this.announced = false
        this.announce()
        return
      }

      case 'pset': {
        const at = this.coord(stmt.at, line)
        // PRESET with no colour means the background — that is the whole
        // difference between the two statements.
        const attr = this.colour(stmt.color, line, stmt.preset ? screen.background : screen.foreground)
        screen.pset(at.x, at.y, attr, line)
        this.announce()
        return
      }

      case 'line': {
        // `LINE -(x,y)` starts wherever the pen was left.
        const from = stmt.from
          ? this.coord(stmt.from, line)
          : { x: screen.lastX, y: screen.lastY }
        const to = this.coord(stmt.to, line)
        const style = this.optional(stmt.style, line)
        screen.line(
          from,
          to,
          this.colour(stmt.color, line),
          stmt.shape,
          style === null ? null : Math.trunc(style) & 0xffff,
          line,
        )
        this.announce()
        return
      }

      case 'circle': {
        const at = this.coord(stmt.at, line)
        screen.circle(
          at,
          toNumber(this.eval(stmt.radius, line), line),
          this.colour(stmt.color, line),
          this.optional(stmt.start, line),
          this.optional(stmt.end, line),
          this.optional(stmt.aspect, line),
          line,
        )
        this.announce()
        return
      }

      case 'paint': {
        const at = this.coord(stmt.at, line)
        const fill = this.colour(stmt.color, line)
        const border = this.optional(stmt.border, line)
        screen.paint(at, fill, border === null ? null : Math.trunc(border), line)
        this.announce()
        return
      }

      case 'draw': {
        const macro = this.eval(stmt.macro, line)
        if (!isString(macro)) throw new BasicError('?Type mismatch error', line)
        draw(screen, macro, screen.foreground, line)
        this.announce()
        return
      }

      case 'color':
        screen.setColor(this.optional(stmt.a, line), this.optional(stmt.b, line), line)
        this.announce()
        return

      case 'locate': {
        const cursor = this.optional(stmt.cursor, line)
        screen.locate(
          this.optional(stmt.row, line),
          this.optional(stmt.col, line),
          cursor === null ? null : cursor !== 0,
          line,
        )
        this.announce()
        return
      }

      case 'view': {
        const box = stmt.box
          ? (() => {
              const a = this.coord(stmt.box[0], line)
              const b = this.coord(stmt.box[1], line)
              return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
            })()
          : null
        const fill = this.optional(stmt.fill, line)
        const border = this.optional(stmt.border, line)
        screen.setView(
          box,
          stmt.screen,
          fill === null ? null : Math.trunc(fill),
          border === null ? null : Math.trunc(border),
          line,
        )
        this.announce()
        return
      }

      case 'viewprint':
        screen.setTextView(this.optional(stmt.top, line), this.optional(stmt.bottom, line), line)
        this.announce()
        return

      case 'window': {
        const box = stmt.box
          ? (() => {
              const a = this.coord(stmt.box[0], line)
              const b = this.coord(stmt.box[1], line)
              return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
            })()
          : null
        screen.setWindow(box, stmt.screen, line)
        this.announce()
        return
      }

      case 'palette': {
        if (stmt.using) {
          screen.paletteUsing(this.paletteValues(stmt.using, line))
        } else if (stmt.attr === null) {
          screen.resetPalette()
        } else {
          screen.setPalette(
            toNumber(this.eval(stmt.attr, line), line),
            toNumber(this.eval(stmt.color!, line), line),
            line,
          )
        }
        this.announce()
        return
      }

      case 'get': {
        const sprite = screen.getSprite(this.coord(stmt.from, line), this.coord(stmt.to, line), line)
        this.storeSprite(stmt.target, sprite, line)
        this.announce()
        return
      }

      case 'put': {
        const sprite = this.loadSprite(stmt.source, line)
        screen.putSprite(this.coord(stmt.at, line), sprite, stmt.action as PutAction, line)
        this.announce()
        return
      }

      case 'width': {
        const cols = this.optional(stmt.cols, line)
        const rows = this.optional(stmt.rows, line)
        screen.setWidth(
          cols === null ? null : Math.trunc(cols),
          rows === null ? null : Math.trunc(rows),
          line,
        )
        this.announce()
        return
      }

      case 'sleep': {
        const seconds = this.optional(stmt.seconds, line)
        if (seconds === null || seconds <= 0) this.sleepForKey = true
        else this.sleepUntil = this.now() + seconds * 1000
        return
      }

      case 'sound':
        // BEEP, SOUND and PLAY parse and run so a listing is not stopped by
        // them; there is no audio here, so nothing is heard.
        for (const arg of stmt.args) this.eval(arg, line)
        return
    }
  }

  /** Read a whole numeric array, for PALETTE USING. */
  private paletteValues(target: LValue, line: number): number[] {
    const array = this.findArray(target.name)
    if (!array) throw new BasicError('?Array not defined', line)
    const start = target.args.length
      ? this.arrayOffset(array, target.args.map((a) => this.eval(a, line)), line)
      : 0
    return array.data.slice(start).map((v) => (typeof v === 'number' ? v : -1))
  }

  /** Where a GET/PUT array's sprite lives: the array, and the element it starts at. */
  private spriteSlot(target: LValue, line: number): { array: ArrayValue; offset: number } {
    let array = this.findArray(target.name)
    if (!array) {
      // QBasic would have needed a DIM first; auto-dimensioning matches what
      // this runtime already does everywhere else an array appears.
      this.declareArray(target.name, [11], line)
      array = this.findArray(target.name)!
    }
    if (isStringName(target.name)) throw new BasicError('?Type mismatch error', line)
    const offset = target.args.length
      ? this.arrayOffset(array, target.args.map((a) => this.eval(a, line)), line)
      : 0
    return { array, offset }
  }

  private storeSprite(target: LValue, sprite: Sprite, line: number): void {
    const { array, offset } = this.spriteSlot(target, line)
    let slots = this.sprites.get(array)
    if (!slots) {
      slots = new Map()
      this.sprites.set(array, slots)
    }
    slots.set(offset, sprite)
    // The two header words a listing might read back: the width in bits, and
    // the height in pixels, exactly as the hardware format put them.
    const bpp = bitsPerPixel(this.screen.info.colors)
    if (offset < array.data.length) array.data[offset] = sprite.w * bpp
    if (offset + 1 < array.data.length) array.data[offset + 1] = sprite.h
  }

  private loadSprite(source: LValue, line: number): Sprite {
    const { array, offset } = this.spriteSlot(source, line)
    const sprite = this.sprites.get(array)?.get(offset)
    if (!sprite) throw new BasicError('?PUT from an array that no GET filled', line)
    return sprite
  }

  /* ----------------------------------------------------------- variables */

  private getVar(name: string): Value {
    const scope = this.scopeFor(name)
    if (scope.vars.has(name)) return scope.vars.get(name)!
    return defaultFor(name)
  }

  private setVar(name: string, value: Value, line: number): void {
    // SELECT CASE stores its subject in a hidden temp whose type is not known
    // until run time, so the name-suffix check does not apply to it.
    if (!name.startsWith('__SEL') && isStringName(name) !== isString(value)) {
      throw new BasicError('?Type mismatch error', line)
    }
    this.scopeFor(name).vars.set(name, value)
  }

  private findArray(name: string): ArrayValue | undefined {
    const scope = this.scopeFor(name)
    return scope.arrays.get(name) ?? this.frames[0].arrays.get(name)
  }

  private declareArray(name: string, dims: number[], line: number): void {
    const size = dims.reduce((a, b) => a * b, 1)
    if (size <= 0 || !Number.isFinite(size)) {
      throw new BasicError('?Subscript out of range', line)
    }
    const scope = this.shared.has(name) ? this.frames[0] : this.scopeFor(name)
    scope.arrays.set(name, {
      dims,
      data: Array.from({ length: size }, () => defaultFor(name)),
    })
  }

  private arrayOffset(array: ArrayValue, args: Value[], line: number): number {
    if (args.length !== array.dims.length) {
      throw new BasicError('?Wrong number of subscripts', line)
    }
    let offset = 0
    for (let i = 0; i < args.length; i += 1) {
      const index = Math.trunc(toNumber(args[i], line))
      if (index < 0 || index >= array.dims[i]) {
        throw new BasicError('?Subscript out of range', line)
      }
      offset = offset * array.dims[i] + index
    }
    return offset
  }

  private assign(target: LValue, value: Value, line: number): void {
    if (target.args.length === 0) {
      this.setVar(target.name, value, line)
      return
    }
    // QBasic auto-dimensions an undeclared array to 10 on first use.
    let array = this.findArray(target.name)
    if (!array) {
      this.declareArray(
        target.name,
        target.args.map(() => 11),
        line,
      )
      array = this.findArray(target.name)!
    }
    if (isStringName(target.name) !== isString(value)) {
      throw new BasicError('?Type mismatch error', line)
    }
    const args = target.args.map((a) => this.eval(a, line))
    array.data[this.arrayOffset(array, args, line)] = value
  }

  private readLValue(target: LValue, line: number): Value {
    if (target.args.length === 0) return this.getVar(target.name)
    const array = this.findArray(target.name)
    if (!array) return defaultFor(target.name)
    const args = target.args.map((a) => this.eval(a, line))
    return array.data[this.arrayOffset(array, args, line)]
  }

  /* ----------------------------------------------------------------- I/O */

  /**
   * Everything printed goes to two places: the console transcript through the
   * host, and the screen, which is where LOCATE, COLOR and the graphics modes
   * can act on it. The transcript is a scrolling log; the screen is the
   * program's actual 80x25 (or 40x25) display.
   */
  private out(text: string): void {
    if (!text) return
    this.host.print(text)
    this.screen.write(text)
    const nl = text.lastIndexOf('\n')
    this.column = nl >= 0 ? text.length - nl - 1 : this.column + text.length
  }

  private execPrint(items: PrintItem[], line: number): void {
    let trailing = false

    for (const item of items) {
      if (item.expr) {
        // TAB and SPC look like function calls but are only legal inside
        // PRINT, and neither produces a value: they move the cursor.
        const spacing = printSpacing(item.expr)
        if (spacing) {
          const n = Math.trunc(toNumber(this.eval(spacing.arg, line), line))
          if (spacing.name === 'SPC') {
            this.out(' '.repeat(Math.max(0, n)))
          } else {
            // TAB(n) means column n, wrapping to the next line if already past.
            if (n - 1 < this.column) this.out('\n')
            this.out(' '.repeat(Math.max(0, n - 1 - this.column)))
          }
          trailing = item.separator !== null
          if (item.separator === ',') this.padToZone()
          continue
        }

        const value = this.eval(item.expr, line)
        // A number carries a leading sign-space and a trailing space, which is
        // why PRINT 1;2 reads " 1  2 ". Strings get neither.
        this.out(isString(value) ? value : `${formatNumber(value)} `)
      }
      if (item.separator === ',') this.padToZone()
      trailing = item.separator !== null
    }

    if (!trailing) this.out('\n')
  }

  private padToZone(): void {
    this.out(' '.repeat(PRINT_ZONE - (this.column % PRINT_ZONE)))
  }

  /* --------------------------------------------------------- expressions */

  private truth(expr: Expr, line: number): boolean {
    return toNumber(this.eval(expr, line), line) !== 0
  }

  private builtinContext(): BuiltinContext {
    return {
      random: () => this.random(),
      screen: this.screen,
      inkey: () => this.host.inkey(),
    }
  }

  private random(): number {
    // Park-Miller: small, deterministic, and enough for a toy.
    this.seed = (this.seed * 16807) % 2147483647
    return (this.seed - 1) / 2147483646
  }

  private eval(expr: Expr, line: number): Value {
    switch (expr.kind) {
      case 'num':
        return expr.value
      case 'str':
        return expr.value

      case 'var': {
        // A bare name can be a zero-argument FUNCTION call.
        const proc = this.program.procedures.get(expr.name)
        if (proc?.isFunction && proc.params.length === 0) {
          return this.callFunction(proc, [], line)
        }
        // So can a builtin: TIMER, INKEY$ and CSRLIN are spelled without
        // parentheses, and reading them as undeclared variables would silently
        // hand back zero.
        if (NULLARY_BUILTINS.has(expr.name)) {
          return BUILTINS[expr.name]([], line, this.builtinContext())
        }
        return this.getVar(expr.name)
      }

      case 'index':
        return this.evalIndex(expr, line)

      case 'unary': {
        if (expr.op === '-') return -toNumber(this.eval(expr.operand, line), line)
        return this.truth(expr.operand, line) ? FALSE : TRUE
      }

      case 'binary':
        return this.evalBinary(expr, line)
    }
  }

  /**
   * `name(args)` is spelled the same for an array element, a user FUNCTION and
   * a builtin, so the three are told apart here, in that order — a declared
   * array shadows a function of the same name, as in QBasic.
   */
  private evalIndex(expr: Extract<Expr, { kind: 'index' }>, line: number): Value {
    const array = this.findArray(expr.name)
    if (array) {
      const args = expr.args.map((a) => this.eval(a, line))
      return array.data[this.arrayOffset(array, args, line)]
    }

    const proc = this.program.procedures.get(expr.name)
    if (proc?.isFunction) {
      return this.callFunction(
        proc,
        expr.args.map((a) => this.eval(a, line)),
        line,
      )
    }

    if (isBuiltin(expr.name)) {
      const args = expr.args.map((a) => this.eval(a, line))
      return BUILTINS[expr.name](args, line, this.builtinContext())
    }

    // Reading an undeclared array is legal: QBasic dimensions it to 10.
    this.declareArray(
      expr.name,
      expr.args.map(() => 11),
      line,
    )
    const created = this.findArray(expr.name)!
    const args = expr.args.map((a) => this.eval(a, line))
    return created.data[this.arrayOffset(created, args, line)]
  }

  private evalBinary(expr: Extract<Expr, { kind: 'binary' }>, line: number): Value {
    const { op } = expr
    const left = this.eval(expr.left, line)
    const right = this.eval(expr.right, line)

    switch (op) {
      case '+':
        if (isString(left) && isString(right)) return left + right
        return toNumber(left, line) + toNumber(right, line)
      case '-':
        return toNumber(left, line) - toNumber(right, line)
      case '*':
        return toNumber(left, line) * toNumber(right, line)
      case '/': {
        const divisor = toNumber(right, line)
        if (divisor === 0) throw new BasicError('?Division by zero', line)
        return toNumber(left, line) / divisor
      }
      case '\\': {
        const divisor = Math.trunc(toNumber(right, line))
        if (divisor === 0) throw new BasicError('?Division by zero', line)
        return Math.trunc(Math.trunc(toNumber(left, line)) / divisor)
      }
      case 'MOD': {
        const divisor = Math.trunc(toNumber(right, line))
        if (divisor === 0) throw new BasicError('?Division by zero', line)
        return Math.trunc(toNumber(left, line)) % divisor
      }
      case '^':
        return toNumber(left, line) ** toNumber(right, line)

      case '=':
        return compare(left, right, line) === 0 ? TRUE : FALSE
      case '<>':
        return compare(left, right, line) !== 0 ? TRUE : FALSE
      case '<':
        return compare(left, right, line) < 0 ? TRUE : FALSE
      case '>':
        return compare(left, right, line) > 0 ? TRUE : FALSE
      case '<=':
        return compare(left, right, line) <= 0 ? TRUE : FALSE
      case '>=':
        return compare(left, right, line) >= 0 ? TRUE : FALSE

      case 'AND':
        return toNumber(left, line) && toNumber(right, line) ? TRUE : FALSE
      case 'OR':
        return toNumber(left, line) || toNumber(right, line) ? TRUE : FALSE
      case 'XOR':
        return (toNumber(left, line) !== 0) !== (toNumber(right, line) !== 0) ? TRUE : FALSE
    }
  }
}

const exhausted = (value: number, limit: number, step: number) =>
  step > 0 ? value > limit : value < limit

/** How many bits one pixel took in a mode with this many colours. */
const bitsPerPixel = (colors: number) => Math.max(1, Math.round(Math.log2(colors)))

/**
 * TAB and SPC inside PRINT. They parse as calls because that is how they are
 * written, but they are cursor moves, so PRINT has to spot them before it
 * evaluates anything.
 */
function printSpacing(expr: Expr): { name: 'TAB' | 'SPC'; arg: Expr } | null {
  if (expr.kind !== 'index') return null
  if (expr.name !== 'TAB' && expr.name !== 'SPC') return null
  if (expr.args.length !== 1) return null
  return { name: expr.name, arg: expr.args[0] }
}
