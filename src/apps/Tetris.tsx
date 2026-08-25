import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { MenuBar } from '@/widgets/Menu'
import type { MenuDef } from '@/widgets/Menu'
import { Button, CheckBox } from '@/widgets/controls'
import { TetrisIcon } from '@/lib/icons'
import { useDesktop } from '@/store/desktop'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './tetris.css'

const COLS = 10
const ROWS = 20

type Kind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'
const KINDS: Kind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

/** Spawn matrices. Rotations are derived from these, so only one form each. */
const SHAPES: Record<Kind, number[][]> = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
}

const rotateCW = (m: number[][]): number[][] =>
  m.map((_, y) => m.map((_, x) => m[m.length - 1 - x][y]))

/** All four rotations per piece, computed once at module load. */
const ROTATIONS: Record<Kind, number[][][]> = Object.fromEntries(
  KINDS.map((k) => {
    const forms = [SHAPES[k]]
    for (let i = 0; i < 3; i += 1) forms.push(rotateCW(forms[i]))
    return [k, forms]
  }),
) as Record<Kind, number[][][]>

/* Simple kick table: try in place, then nudge sideways, then up. Not full SRS,
   but it makes rotation against a wall or the floor feel right. */
const KICKS: Array<[number, number]> = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [-2, 0],
  [2, 0],
  [0, -1],
  [-1, -1],
  [1, -1],
]

type Cell = Kind | null
type Board = Cell[][]

interface Piece {
  kind: Kind
  rot: number
  x: number
  y: number
}

type Status = 'ready' | 'playing' | 'paused' | 'over'

interface State {
  board: Board
  piece: Piece | null
  bag: Kind[]
  next: Kind
  score: number
  lines: number
  level: number
  status: Status
}

const emptyBoard = (): Board =>
  Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null))

/** 7-bag randomiser: every piece appears once before any repeats. */
function refill(bag: Kind[]): Kind[] {
  if (bag.length > 1) return bag
  const next = [...KINDS]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next[i], next[j]] = [next[j], next[i]]
  }
  return [...bag, ...next]
}

function cellsOf(piece: Piece): Array<[number, number]> {
  const form = ROTATIONS[piece.kind][piece.rot]
  const out: Array<[number, number]> = []
  for (let y = 0; y < form.length; y += 1) {
    for (let x = 0; x < form.length; x += 1) {
      if (form[y][x]) out.push([piece.x + x, piece.y + y])
    }
  }
  return out
}

function collides(board: Board, piece: Piece): boolean {
  return cellsOf(piece).some(
    ([x, y]) => x < 0 || x >= COLS || y >= ROWS || (y >= 0 && board[y][x] !== null),
  )
}

function spawn(kind: Kind): Piece {
  const size = ROTATIONS[kind][0].length
  return { kind, rot: 0, x: Math.floor((COLS - size) / 2), y: kind === 'I' ? -1 : 0 }
}

const gravityMs = (level: number) => Math.max(70, 800 - (level - 1) * 65)

function dropDistance(board: Board, piece: Piece): number {
  let d = 0
  while (!collides(board, { ...piece, y: piece.y + d + 1 })) d += 1
  return d
}

const LINE_SCORE = [0, 100, 300, 500, 800]

/** Merge the piece, clear full lines, and hand out the next piece. */
function lock(state: State): State {
  const board = state.board.map((row) => [...row])
  for (const [x, y] of cellsOf(state.piece!)) {
    if (y >= 0) board[y][x] = state.piece!.kind
  }

  const kept = board.filter((row) => row.some((c) => c === null))
  const cleared = ROWS - kept.length
  while (kept.length < ROWS) kept.unshift(Array.from({ length: COLS }, () => null))

  const lines = state.lines + cleared
  const level = Math.floor(lines / 10) + 1
  const score = state.score + LINE_SCORE[cleared] * state.level

  const bag = refill(state.bag)
  const [kind, ...rest] = bag
  const piece = spawn(state.next)

  // No room for the new piece means the stack reached the ceiling.
  if (collides(kept, piece)) {
    return { ...state, board: kept, piece: null, lines, level, score, status: 'over' }
  }
  return { ...state, board: kept, piece, bag: rest, next: kind, lines, level, score }
}

function newGame(): State {
  const bag = refill([])
  const [first, second, ...rest] = bag
  return {
    board: emptyBoard(),
    piece: spawn(first),
    bag: rest,
    next: second,
    score: 0,
    lines: 0,
    level: 1,
    status: 'playing',
  }
}

type Action =
  | { type: 'new' }
  | { type: 'tick' }
  | { type: 'move'; dx: number }
  | { type: 'rotate'; dir: 1 | -1 }
  | { type: 'soft' }
  | { type: 'hard' }
  | { type: 'togglePause' }

function reducer(state: State, action: Action): State {
  if (action.type === 'new') return newGame()
  if (action.type === 'togglePause') {
    if (state.status === 'playing') return { ...state, status: 'paused' }
    if (state.status === 'paused') return { ...state, status: 'playing' }
    return state
  }
  if (state.status !== 'playing' || !state.piece) return state

  switch (action.type) {
    case 'move': {
      const moved = { ...state.piece, x: state.piece.x + action.dx }
      return collides(state.board, moved) ? state : { ...state, piece: moved }
    }

    case 'rotate': {
      const rot = (state.piece.rot + (action.dir === 1 ? 1 : 3)) % 4
      for (const [dx, dy] of KICKS) {
        const kicked = { ...state.piece, rot, x: state.piece.x + dx, y: state.piece.y + dy }
        if (!collides(state.board, kicked)) return { ...state, piece: kicked }
      }
      return state
    }

    case 'tick':
    case 'soft': {
      const moved = { ...state.piece, y: state.piece.y + 1 }
      if (collides(state.board, moved)) return lock(state)
      // Soft drop pays a point per row, which is what makes it worth doing.
      const score = action.type === 'soft' ? state.score + 1 : state.score
      return { ...state, piece: moved, score }
    }

    case 'hard': {
      const d = dropDistance(state.board, state.piece)
      const dropped = { ...state.piece, y: state.piece.y + d }
      return lock({ ...state, piece: dropped, score: state.score + d * 2 })
    }

    default:
      return state
  }
}

const initial: State = {
  board: emptyBoard(),
  piece: null,
  bag: [],
  next: 'T',
  score: 0,
  lines: 0,
  level: 1,
  status: 'ready',
}

export function Tetris({ windowId }: AppProps) {
  const [state, dispatch] = useReducer(reducer, initial)
  // A display preference, not part of the game, so it stays out of the reducer.
  const [showGhost, setShowGhost] = useState(true)
  const requestClose = useDesktop((s) => s.requestClose)
  const isActive = useDesktop((s) => s.activeId === windowId)

  // Gravity. Re-created when the level changes so the drop speeds up.
  useEffect(() => {
    if (state.status !== 'playing') return
    const id = setInterval(() => dispatch({ type: 'tick' }), gravityMs(state.level))
    return () => clearInterval(id)
  }, [state.status, state.level])

  // Keys are only claimed while this window is in front, so a Terminal in the
  // background keeps its own arrows and space bar.
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      switch (e.key) {
        case 'ArrowLeft': dispatch({ type: 'move', dx: -1 }); break
        case 'ArrowRight': dispatch({ type: 'move', dx: 1 }); break
        case 'ArrowDown': dispatch({ type: 'soft' }); break
        case 'ArrowUp':
        case 'x':
        case 'X':
          if (!e.repeat) dispatch({ type: 'rotate', dir: 1 })
          break
        case 'z':
        case 'Z':
          if (!e.repeat) dispatch({ type: 'rotate', dir: -1 })
          break
        case ' ':
          if (!e.repeat) dispatch({ type: 'hard' })
          break
        case 'p':
        case 'P':
          if (!e.repeat) dispatch({ type: 'togglePause' })
          break
        default:
          return
      }
      // Stop the page scrolling out from under the game.
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive])

  // One flat array of 200 cells: the settled board, plus the falling piece and
  // its landing shadow painted on top.
  const cells = useMemo(() => {
    const grid: Array<{ kind: Cell; ghost: boolean }> = state.board.flat().map((kind) => ({
      kind,
      ghost: false,
    }))
    if (state.piece && state.status !== 'over') {
      // Skipping the scan entirely when the shadow is off, not just hiding it.
      if (showGhost) {
        const d = dropDistance(state.board, state.piece)
        for (const [x, y] of cellsOf({ ...state.piece, y: state.piece.y + d })) {
          if (y >= 0) grid[y * COLS + x] = { kind: state.piece.kind, ghost: true }
        }
      }
      // Painted after the shadow so a piece resting on the stack wins.
      for (const [x, y] of cellsOf(state.piece)) {
        if (y >= 0) grid[y * COLS + x] = { kind: state.piece.kind, ghost: false }
      }
    }
    return grid
  }, [state.board, state.piece, state.status, showGhost])

  const preview = useMemo(() => {
    const form = ROTATIONS[state.next][0]
    const size = form.length
    return Array.from({ length: 16 }, (_, i) => {
      const y = Math.floor(i / 4)
      const x = i % 4
      // Centre the shape in the 4x4 preview well.
      const off = size === 4 ? 0 : 1
      const sy = y - (size === 2 ? 1 : off)
      const sx = x - (size === 2 ? 1 : off)
      return sy >= 0 && sy < size && sx >= 0 && sx < size && form[sy][sx] ? state.next : null
    })
  }, [state.next])

  const press = useCallback((action: Action) => () => dispatch(action), [])

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'Game',
        items: [
          { label: 'New game', shortcut: 'Alt+N', onSelect: () => dispatch({ type: 'new' }) },
          {
            label: state.status === 'paused' ? 'Resume' : 'Pause',
            shortcut: 'P',
            disabled: state.status !== 'playing' && state.status !== 'paused',
            onSelect: () => dispatch({ type: 'togglePause' }),
          },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
    ],
    [requestClose, state.status, windowId],
  )

  const overlay =
    state.status === 'ready'
      ? 'Press New game'
      : state.status === 'paused'
        ? 'Paused'
        : state.status === 'over'
          ? 'Game over'
          : null

  return (
    <div className="tetris">
      <MenuBar menus={menus} />

      <div className="tetris-body">
        <div className="tetris-well">
          <div className="tetris-field" role="img" aria-label={`Tetris board, score ${state.score}`}>
            {cells.map((cell, i) => (
              <span
                key={i}
                className="tetris-cell"
                data-kind={cell.kind ?? undefined}
                data-ghost={cell.ghost || undefined}
              />
            ))}
          </div>
          {overlay ? (
            <div className="tetris-overlay">
              <span className="tetris-overlay-text">{overlay}</span>
            </div>
          ) : null}
        </div>

        <div className="tetris-side">
          <div className="b-box tetris-box">
            <span className="b-box-label">Next</span>
            <div className="tetris-preview">
              {preview.map((kind, i) => (
                <span key={i} className="tetris-cell" data-kind={kind ?? undefined} />
              ))}
            </div>
          </div>

          <dl className="tetris-stats">
            <dt>Score</dt>
            <dd>{state.score}</dd>
            <dt>Level</dt>
            <dd>{state.level}</dd>
            <dt>Lines</dt>
            <dd>{state.lines}</dd>
          </dl>

          <div className="tetris-options">
            <CheckBox
              label="Ghost piece"
              checked={showGhost}
              onChange={(e) => setShowGhost(e.target.checked)}
            />
          </div>

          <div className="tetris-buttons">
            <Button isDefault onClick={press({ type: 'new' })}>
              New game
            </Button>
            <Button
              disabled={state.status !== 'playing' && state.status !== 'paused'}
              onClick={press({ type: 'togglePause' })}
            >
              {state.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
          </div>
        </div>
      </div>

      {/* Touch pad: only shown where there is no keyboard. */}
      <div className="tetris-pad">
        <Button onClick={press({ type: 'move', dx: -1 })} aria-label="Move left">←</Button>
        <Button onClick={press({ type: 'rotate', dir: -1 })} aria-label="Rotate left">↺</Button>
        <Button onClick={press({ type: 'rotate', dir: 1 })} aria-label="Rotate right">↻</Button>
        <Button onClick={press({ type: 'move', dx: 1 })} aria-label="Move right">→</Button>
        <Button onClick={press({ type: 'soft' })} aria-label="Soft drop">↓</Button>
        <Button onClick={press({ type: 'hard' })} aria-label="Hard drop">⤓</Button>
      </div>

      <div className="tetris-status b-fixed">
        ←/→ move · ↓ soft · ↑/X rotate · Z back · Space drop · P pause
      </div>
    </div>
  )
}

registerApp({
  id: 'tetris',
  name: 'Tetris',
  component: Tetris,
  icon: TetrisIcon,
  defaultW: 372,
  defaultH: 462,
  minW: 320,
  minH: 400,
  singleton: true,
})
