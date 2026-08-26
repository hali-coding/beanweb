import type { CaseTest, Expr, GraphicsStmt, LValue, PrintItem, Program, Stmt } from './ast'
import { BasicError } from './errors'
import type { Value } from './values'

/**
 * Compiles the statement tree into a flat instruction list.
 *
 * This is what lets QBasic's block structure keep the interruptible design:
 * IF / DO / WHILE / SELECT all become conditional jumps, so the VM stays a
 * simple program counter over an array and `step()` still means "execute one
 * instruction". Nothing in the runtime ever recurses over the tree.
 */

export type Instr = { line: number } & (
  | { op: 'print'; items: PrintItem[] }
  | { op: 'assign'; target: LValue; value: Expr }
  | { op: 'input'; prompt: string | null; targets: LValue[]; wholeLine: boolean }
  | { op: 'jump'; target: number }
  | { op: 'jumpIf'; cond: Expr; target: number }
  | { op: 'jumpUnless'; cond: Expr; target: number }
  | { op: 'forInit'; name: string; from: Expr; to: Expr; step: Expr | null; exit: number }
  | { op: 'forNext'; name: string; body: number }
  | { op: 'gosub'; target: number }
  | { op: 'retsub' }
  | { op: 'call'; name: string; args: Expr[] }
  | { op: 'endproc' }
  | { op: 'dim'; entries: { name: string; dims: Expr[] }[]; shared: boolean }
  | { op: 'const'; entries: { name: string; value: Expr }[] }
  | { op: 'read'; targets: LValue[] }
  | { op: 'restore' }
  | { op: 'randomize'; seed: Expr | null }
  | { op: 'swap'; a: LValue; b: LValue }
  /** Any screen statement, carried whole; the VM switches on `stmt.kind`. */
  | { op: 'gfx'; stmt: GraphicsStmt }
  | { op: 'end' }
  | { op: 'nop' }
)

export interface ProcedureInfo {
  start: number
  params: string[]
  isFunction: boolean
  name: string
}

export interface Compiled {
  code: Instr[]
  /** All DATA values, flattened in source order. */
  data: Value[]
  procedures: Map<string, ProcedureInfo>
}

interface LoopContext {
  kind: 'FOR' | 'DO'
  /** Indices of jump instructions needing the loop's exit address. */
  exits: number[]
}

class Compiler {
  private readonly code: Instr[] = []
  private readonly data: Value[] = []
  private readonly labels = new Map<string, number>()
  /** GOTO/GOSUB sites awaiting a label address. */
  private readonly pending: { at: number; label: string; line: number }[] = []
  private readonly loops: LoopContext[] = []
  private readonly procedures = new Map<string, ProcedureInfo>()
  private selectTemp = 0
  /** Set while compiling a procedure, so EXIT SUB knows it is legal. */
  private inProcedure = false

  compile(program: Program): Compiled {
    // DATA is gathered from the whole program before anything runs, which is
    // what makes READ see values declared after it.
    this.collectData(program.body)
    for (const proc of program.procedures) this.collectData(proc.body)

    this.emitBody(program.body)
    this.emit({ op: 'end', line: lastLine(program.body) })

    for (const proc of program.procedures) {
      if (this.procedures.has(proc.name)) {
        throw new BasicError(`?Duplicate definition: ${proc.name}`, proc.body[0]?.line ?? 1)
      }
      this.procedures.set(proc.name, {
        name: proc.name,
        start: this.code.length,
        params: proc.params,
        isFunction: proc.isFunction,
      })
      this.inProcedure = true
      this.emitBody(proc.body)
      this.inProcedure = false
      this.emit({ op: 'endproc', line: lastLine(proc.body) })
    }

    this.resolveLabels()
    return { code: this.code, data: this.data, procedures: this.procedures }
  }

  /* ---------------------------------------------------------------- emit */

  private emit(instr: Instr): number {
    this.code.push(instr)
    return this.code.length - 1
  }

  private here(): number {
    return this.code.length
  }

  private patch(at: number, target: number): void {
    const instr = this.code[at]
    if ('target' in instr) instr.target = target
  }

  private collectData(body: Stmt[]): void {
    for (const stmt of body) {
      if (stmt.kind === 'data') this.data.push(...stmt.values)
      else if ('body' in stmt && Array.isArray(stmt.body)) this.collectData(stmt.body)
      else if (stmt.kind === 'if') {
        for (const arm of stmt.arms) this.collectData(arm.body)
        if (stmt.else) this.collectData(stmt.else)
      } else if (stmt.kind === 'select') {
        for (const arm of stmt.arms) this.collectData(arm.body)
      }
    }
  }

  private emitBody(body: Stmt[]): void {
    for (const stmt of body) this.emitStatement(stmt)
  }

  private emitStatement(stmt: Stmt): void {
    const line = stmt.line

    switch (stmt.kind) {
      case 'print':
        this.emit({ op: 'print', items: stmt.items, line })
        return
      case 'let':
        this.emit({ op: 'assign', target: stmt.target, value: stmt.value, line })
        return
      case 'input':
        this.emit({
          op: 'input',
          prompt: stmt.prompt,
          targets: stmt.targets,
          wholeLine: stmt.wholeLine,
          line,
        })
        return
      case 'cls':
      case 'screen':
      case 'pset':
      case 'line':
      case 'circle':
      case 'paint':
      case 'draw':
      case 'color':
      case 'locate':
      case 'view':
      case 'viewprint':
      case 'window':
      case 'palette':
      case 'get':
      case 'put':
      case 'width':
      case 'sleep':
      case 'sound':
        this.emit({ op: 'gfx', stmt, line })
        return
      case 'end':
        this.emit({ op: 'end', line })
        return
      case 'rem':
        return // comments emit nothing
      case 'label':
        this.labels.set(stmt.name, this.here())
        return
      case 'data':
        return // already collected
      case 'read':
        this.emit({ op: 'read', targets: stmt.targets, line })
        return
      case 'restore':
        this.emit({ op: 'restore', line })
        return
      case 'dim':
        this.emit({ op: 'dim', entries: stmt.entries, shared: stmt.shared, line })
        return
      case 'const':
        this.emit({ op: 'const', entries: stmt.entries, line })
        return
      case 'randomize':
        this.emit({ op: 'randomize', seed: stmt.seed, line })
        return
      case 'swap':
        this.emit({ op: 'swap', a: stmt.a, b: stmt.b, line })
        return
      case 'call':
        this.emit({ op: 'call', name: stmt.name, args: stmt.args, line })
        return
      case 'return':
        this.emit({ op: 'retsub', line })
        return

      case 'goto': {
        const at = this.emit({ op: 'jump', target: -1, line })
        this.pending.push({ at, label: stmt.label, line })
        return
      }
      case 'gosub': {
        const at = this.emit({ op: 'gosub', target: -1, line })
        this.pending.push({ at, label: stmt.label, line })
        return
      }

      case 'exit':
        this.emitExit(stmt.target, line)
        return

      case 'if':
        this.emitIf(stmt, line)
        return
      case 'for':
        this.emitFor(stmt, line)
        return
      case 'while':
        this.emitWhile(stmt, line)
        return
      case 'do':
        this.emitDo(stmt, line)
        return
      case 'select':
        this.emitSelect(stmt, line)
        return
    }
  }

  private emitExit(target: 'FOR' | 'DO' | 'SUB' | 'FUNCTION', line: number): void {
    if (target === 'SUB' || target === 'FUNCTION') {
      if (!this.inProcedure) {
        throw new BasicError(`?EXIT ${target} outside a procedure`, line)
      }
      this.emit({ op: 'endproc', line })
      return
    }

    // Innermost matching loop wins, as in QBasic.
    for (let i = this.loops.length - 1; i >= 0; i -= 1) {
      if (this.loops[i].kind === target) {
        const at = this.emit({ op: 'jump', target: -1, line })
        this.loops[i].exits.push(at)
        return
      }
    }
    throw new BasicError(`?EXIT ${target} outside a ${target} loop`, line)
  }

  private emitIf(stmt: Extract<Stmt, { kind: 'if' }>, line: number): void {
    const doneJumps: number[] = []

    for (const arm of stmt.arms) {
      const test = this.emit({ op: 'jumpUnless', cond: arm.condition, target: -1, line })
      this.emitBody(arm.body)
      doneJumps.push(this.emit({ op: 'jump', target: -1, line }))
      this.patch(test, this.here())
    }

    if (stmt.else) this.emitBody(stmt.else)
    for (const at of doneJumps) this.patch(at, this.here())
  }

  private emitFor(stmt: Extract<Stmt, { kind: 'for' }>, line: number): void {
    const init = this.emit({
      op: 'forInit',
      name: stmt.name,
      from: stmt.from,
      to: stmt.to,
      step: stmt.step,
      exit: -1,
      line,
    })

    const bodyStart = this.here()
    this.loops.push({ kind: 'FOR', exits: [] })
    this.emitBody(stmt.body)
    this.emit({ op: 'forNext', name: stmt.name, body: bodyStart, line })

    const exit = this.here()
    const instr = this.code[init]
    if (instr.op === 'forInit') instr.exit = exit
    for (const at of this.loops.pop()!.exits) this.patch(at, exit)
  }

  private emitWhile(stmt: Extract<Stmt, { kind: 'while' }>, line: number): void {
    const top = this.here()
    const test = this.emit({ op: 'jumpUnless', cond: stmt.condition, target: -1, line })

    this.loops.push({ kind: 'DO', exits: [] })
    this.emitBody(stmt.body)
    this.emit({ op: 'jump', target: top, line })

    const exit = this.here()
    this.patch(test, exit)
    for (const at of this.loops.pop()!.exits) this.patch(at, exit)
  }

  private emitDo(stmt: Extract<Stmt, { kind: 'do' }>, line: number): void {
    const top = this.here()
    let test = -1

    // Pre-test form: check before the body runs.
    if (stmt.condition && !stmt.post) {
      test = this.emit({
        op: stmt.until ? 'jumpIf' : 'jumpUnless',
        cond: stmt.condition,
        target: -1,
        line,
      })
    }

    this.loops.push({ kind: 'DO', exits: [] })
    this.emitBody(stmt.body)

    if (stmt.condition && stmt.post) {
      // Post-test form: loop back while the condition still holds.
      this.emit({
        op: stmt.until ? 'jumpUnless' : 'jumpIf',
        cond: stmt.condition,
        target: top,
        line,
      })
    } else {
      this.emit({ op: 'jump', target: top, line })
    }

    const exit = this.here()
    if (test >= 0) this.patch(test, exit)
    for (const at of this.loops.pop()!.exits) this.patch(at, exit)
  }

  private emitSelect(stmt: Extract<Stmt, { kind: 'select' }>, line: number): void {
    // Evaluate the subject once into a reserved temporary, so `SELECT CASE f(x)`
    // does not call f once per CASE.
    const temp = `__SEL${this.selectTemp++}`
    this.emit({ op: 'assign', target: { name: temp, args: [] }, value: stmt.subject, line })

    const subject: Expr = { kind: 'var', name: temp }
    const doneJumps: number[] = []

    for (const arm of stmt.arms) {
      let test = -1
      if (arm.tests.length) {
        const cond = arm.tests
          .map((t) => caseCondition(subject, t))
          .reduce((a, b): Expr => ({ kind: 'binary', op: 'OR', left: a, right: b }))
        test = this.emit({ op: 'jumpUnless', cond, target: -1, line })
      }
      this.emitBody(arm.body)
      doneJumps.push(this.emit({ op: 'jump', target: -1, line }))
      if (test >= 0) this.patch(test, this.here())
    }

    for (const at of doneJumps) this.patch(at, this.here())
  }

  private resolveLabels(): void {
    for (const { at, label, line } of this.pending) {
      const target = this.labels.get(label)
      if (target === undefined) throw new BasicError(`?Label not defined: ${label}`, line)
      this.patch(at, target)
    }
  }
}

/** Turn one CASE test into a boolean expression against the subject. */
function caseCondition(subject: Expr, test: CaseTest): Expr {
  if (test.kind === 'value') {
    return { kind: 'binary', op: '=', left: subject, right: test.value }
  }
  if (test.kind === 'compare') {
    return { kind: 'binary', op: test.op, left: subject, right: test.value }
  }
  return {
    kind: 'binary',
    op: 'AND',
    left: { kind: 'binary', op: '>=', left: subject, right: test.from },
    right: { kind: 'binary', op: '<=', left: subject, right: test.to },
  }
}

const lastLine = (body: Stmt[]) => body[body.length - 1]?.line ?? 1

export function compile(program: Program): Compiled {
  return new Compiler().compile(program)
}
