/** Expression and statement nodes. Plain data — no behaviour lives here. */

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  /** A bare name: a variable, or a zero-argument function. */
  | { kind: 'var'; name: string }
  /**
   * `name(args)`. BASIC spells array indexing and function calls identically,
   * so which one this is can only be decided at run time, against the arrays
   * and functions that actually exist.
   */
  | { kind: 'index'; name: string; args: Expr[] }
  | { kind: 'unary'; op: '-' | 'NOT'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '\\' | '^' | 'MOD'
  | '=' | '<>' | '<' | '>' | '<=' | '>='
  | 'AND' | 'OR' | 'XOR'

export interface PrintItem {
  expr: Expr | null
  separator: ';' | ',' | null
}

/** Assignment target: a variable, or an element of an array. */
export interface LValue {
  name: string
  args: Expr[]
}

/** One arm of SELECT CASE. An empty `tests` array is CASE ELSE. */
export interface CaseArm {
  tests: CaseTest[]
  body: Stmt[]
}

export type CaseTest =
  /** CASE 1  /  CASE "a" */
  | { kind: 'value'; value: Expr }
  /** CASE 1 TO 10 */
  | { kind: 'range'; from: Expr; to: Expr }
  /** CASE IS >= 10 */
  | { kind: 'compare'; op: BinaryOp; value: Expr }

/**
 * A coordinate pair as the graphics statements spell it: `(x, y)` or
 * `STEP (dx, dy)`, the latter measured from the graphics cursor. Every
 * graphics statement takes at least one, so it is worth a name.
 */
export interface Coord {
  step: boolean
  x: Expr
  y: Expr
}

/** LINE's four shapes: a segment, a box outline, and a filled box. */
export type LineShape = 'line' | 'box' | 'boxfill'

/** How PUT combines a sprite with the pixels already on screen. */
export type PutAction = 'PSET' | 'PRESET' | 'AND' | 'OR' | 'XOR'

export type StmtNode =
  | { kind: 'print'; items: PrintItem[] }
  | { kind: 'let'; target: LValue; value: Expr }
  | { kind: 'input'; prompt: string | null; targets: LValue[]; wholeLine: boolean }
  | { kind: 'if'; arms: { condition: Expr; body: Stmt[] }[]; else: Stmt[] | null }
  | { kind: 'for'; name: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[] }
  | { kind: 'while'; condition: Expr; body: Stmt[] }
  /** DO [WHILE|UNTIL c] ... LOOP [WHILE|UNTIL c]; `post` means the test is at the bottom. */
  | { kind: 'do'; condition: Expr | null; until: boolean; post: boolean; body: Stmt[] }
  | { kind: 'select'; subject: Expr; arms: CaseArm[] }
  | { kind: 'exit'; target: 'FOR' | 'DO' | 'SUB' | 'FUNCTION' }
  | { kind: 'goto'; label: string }
  | { kind: 'gosub'; label: string }
  | { kind: 'return' }
  | { kind: 'label'; name: string }
  | { kind: 'dim'; entries: { name: string; dims: Expr[] }[]; shared: boolean }
  | { kind: 'const'; entries: { name: string; value: Expr }[] }
  | { kind: 'data'; values: (string | number)[] }
  | { kind: 'read'; targets: LValue[] }
  | { kind: 'restore' }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'randomize'; seed: Expr | null }
  | { kind: 'swap'; a: LValue; b: LValue }
  | { kind: 'rem'; text: string }
  | { kind: 'end' }
  /** `CLS`, `CLS 1` (graphics viewport) or `CLS 2` (text viewport). */
  | { kind: 'cls'; target: Expr | null }

  /* ------------------------------------------------------------- graphics */
  | { kind: 'screen'; mode: Expr; colorSwitch: Expr | null }
  /** PSET and PRESET differ only in what an omitted colour means. */
  | { kind: 'pset'; at: Coord; color: Expr | null; preset: boolean }
  /** `from` is null in the `LINE -(x,y)` form, which starts where the pen is. */
  | { kind: 'line'; from: Coord | null; to: Coord; color: Expr | null; shape: LineShape; style: Expr | null }
  | {
      kind: 'circle'
      at: Coord
      radius: Expr
      color: Expr | null
      start: Expr | null
      end: Expr | null
      aspect: Expr | null
    }
  | { kind: 'paint'; at: Coord; color: Expr | null; border: Expr | null }
  | { kind: 'draw'; macro: Expr }
  | { kind: 'color'; a: Expr | null; b: Expr | null; c: Expr | null }
  | { kind: 'locate'; row: Expr | null; col: Expr | null; cursor: Expr | null }
  /** `VIEW SCREEN (…)-(…)`, or bare `VIEW` to reset. */
  | { kind: 'view'; box: [Coord, Coord] | null; screen: boolean; fill: Expr | null; border: Expr | null }
  /** `VIEW PRINT top TO bottom`, or bare to reset — a different statement. */
  | { kind: 'viewprint'; top: Expr | null; bottom: Expr | null }
  | { kind: 'window'; box: [Coord, Coord] | null; screen: boolean }
  /** `PALETTE`, `PALETTE attr, colour`, or `PALETTE USING array`. */
  | { kind: 'palette'; attr: Expr | null; color: Expr | null; using: LValue | null }
  | { kind: 'get'; from: Coord; to: Coord; target: LValue }
  | { kind: 'put'; at: Coord; source: LValue; action: PutAction }
  | { kind: 'width'; cols: Expr | null; rows: Expr | null }
  /** `SLEEP` waits for a key; `SLEEP n` waits n seconds. */
  | { kind: 'sleep'; seconds: Expr | null }
  /** Sound is parsed and accepted so listings run, but nothing is heard. */
  | { kind: 'sound'; args: Expr[] }

/** Every statement carries the source row it began on, so a runtime error can
 *  point the editor at the right line. */
export type Stmt = StmtNode & { line: number }

/**
 * The statements that only draw.
 *
 * None of them branch, loop or call, so the compiler emits every one as a
 * single instruction carrying the node itself rather than inventing a
 * different opcode for each. One instruction still means one `step()`, which
 * is the property the whole interruptible design rests on.
 */
export type GraphicsKind =
  | 'cls' | 'screen' | 'pset' | 'line' | 'circle' | 'paint' | 'draw' | 'color'
  | 'locate' | 'view' | 'viewprint' | 'window' | 'palette' | 'get' | 'put'
  | 'width' | 'sleep' | 'sound'

export type GraphicsStmt = Extract<Stmt, { kind: GraphicsKind }>

/** A SUB or FUNCTION definition. */
export interface Procedure {
  name: string
  params: string[]
  body: Stmt[]
  isFunction: boolean
}

export interface Program {
  /** Module-level code. */
  body: Stmt[]
  procedures: Procedure[]
}
