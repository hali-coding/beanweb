/**
 * Levels: the shape they have in memory, and the two directions between that
 * shape and text.
 *
 * `parseLevel` and `formatLevel` are exact inverses over a normalised map, and
 * `tests/beanchallenge.test.ts` holds them to it across every built-in level.
 * That matters more than it looks: an editor is a thing that mutates a board and
 * writes it back, and without a guaranteed inverse there is nothing to write.
 */

import {
  BY_CHAR,
  CHAR_OF_ENTITY,
  CHAR_OF_TILE,
  Tile,
  type EntityKind,
  type MonsterKind,
} from './tiles'

/** North, east, south, west. Numbered so turning is arithmetic. */
export type Dir = 0 | 1 | 2 | 3
export const N: Dir = 0
export const E: Dir = 1
export const S: Dir = 2
export const W: Dir = 3

/** Offsets, indexed by `Dir`. */
export const DELTA: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

export const turnLeft = (d: Dir): Dir => ((d + 3) % 4) as Dir
export const turnRight = (d: Dir): Dir => ((d + 1) % 4) as Dir
export const turnBack = (d: Dir): Dir => ((d + 2) % 4) as Dir

/** The letters a recorded solution is written in. `.` waits one tick. */
export const MOVE_CHARS: Record<string, Dir> = { U: N, R: E, D: S, L: W }

export interface Point {
  x: number
  y: number
}

export interface MonsterSpawn extends Point {
  kind: MonsterKind
  /**
   * Which way it is facing at the start. The map format has no room for a
   * facing, so parsing always yields south and the movement rules reorient on
   * the first tick; the field exists so a later format revision can carry one.
   */
  dir: Dir
}

/** A parsed map: terrain in one array, everything that moves lifted out of it. */
export interface Board {
  w: number
  h: number
  /** Row-major, `w * h` entries of `Tile`. */
  terrain: Uint8Array
  player: Point
  blocks: Point[]
  monsters: MonsterSpawn[]
  /** Beans present on the board, which is the level's quota. */
  beans: number
}

export interface Level {
  /**
   * Stable slug. Progress is keyed by this rather than by position, so
   * inserting or reordering levels never relabels what someone has finished.
   */
  id: string
  name: string
  /** Seconds on the clock. Zero means untimed. */
  time: number
  hint?: string
  /** A recorded winning move string; see `replay` in engine.ts. */
  solution?: string
  map: string
}

export interface Pack {
  id: string
  name: string
  levels: Level[]
}

/* ------------------------------------------------------------------ parsing */

export class LevelError extends Error {}

/**
 * Turn a map string into a `Board`.
 *
 * Leading and trailing blank lines are dropped so a level literal can start its
 * template string on the line after the backtick, and short rows are padded with
 * floor so a hand-edited map with ragged right edges still parses. Any width and
 * height is legal -- an editor will grow and shrink boards, and nothing here
 * assumes a square.
 */
export function parseLevel(map: string): Board {
  const lines = map.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && lines[0].trim() === '') lines.shift()
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) throw new LevelError('map is empty')

  // Trailing whitespace is invisible in a source literal; strip it before
  // measuring or one stray space widens the whole board.
  const rows = lines.map((line) => line.replace(/\s+$/, ''))
  const w = Math.max(...rows.map((r) => r.length))
  const h = rows.length

  const terrain = new Uint8Array(w * h)
  const blocks: Point[] = []
  const monsters: MonsterSpawn[] = []
  let player: Point | null = null
  let beans = 0

  for (let y = 0; y < h; y += 1) {
    const row = rows[y]
    for (let x = 0; x < w; x += 1) {
      const char = x < row.length ? row[x] : '.'
      const entry = BY_CHAR[char]
      if (!entry) {
        throw new LevelError(`unknown map character "${char}" at ${x},${y}`)
      }
      terrain[y * w + x] = entry.tile
      if (entry.tile === Tile.Bean) beans += 1
      if (!entry.entity) continue

      switch (entry.entity) {
        case 'player':
          if (player) throw new LevelError(`a second player start at ${x},${y}`)
          player = { x, y }
          break
        case 'block':
          blocks.push({ x, y })
          break
        default:
          monsters.push({ x, y, kind: entry.entity as MonsterKind, dir: S })
      }
    }
  }

  if (!player) throw new LevelError('no player start')
  return { w, h, terrain, player, blocks, monsters, beans }
}

/* ---------------------------------------------------------------- formatting */

/**
 * The inverse of `parseLevel`. Entities are painted over the terrain, so a block
 * standing on floor comes back as `*` rather than as the floor underneath it.
 */
export function formatLevel(board: Board): string {
  const { w, h, terrain } = board
  const grid: string[][] = []
  for (let y = 0; y < h; y += 1) {
    const row: string[] = []
    for (let x = 0; x < w; x += 1) {
      const tile = terrain[y * w + x]
      const char = CHAR_OF_TILE[tile]
      if (char === undefined) throw new LevelError(`tile ${tile} has no character`)
      row.push(char)
    }
    grid.push(row)
  }

  const put = (p: Point, entity: EntityKind) => {
    if (p.x < 0 || p.x >= w || p.y < 0 || p.y >= h) return
    grid[p.y][p.x] = CHAR_OF_ENTITY[entity]
  }
  for (const block of board.blocks) put(block, 'block')
  for (const monster of board.monsters) put(monster, monster.kind)
  put(board.player, 'player')

  return grid.map((row) => row.join('')).join('\n')
}

/** The map a level round-trips to: same board, canonical whitespace. */
export const normaliseMap = (map: string): string => formatLevel(parseLevel(map))

/* --------------------------------------------------------------- level files */

/**
 * A level as a document: a short `key: value` header, a `---` rule, then the
 * map. This is the form a level takes on the disk, which means StyledEdit can
 * already open one and a future editor already has somewhere to save to.
 */
const FILE_SEPARATOR = '---'

export function formatLevelFile(level: Level): string {
  const head = [`id: ${level.id}`, `name: ${level.name}`, `time: ${level.time}`]
  if (level.hint) head.push(`hint: ${level.hint}`)
  if (level.solution) head.push(`solution: ${level.solution}`)
  return `${head.join('\n')}\n${FILE_SEPARATOR}\n${normaliseMap(level.map)}\n`
}

export function parseLevelFile(text: string): Level {
  const body = text.replace(/\r\n?/g, '\n')
  const cut = body.split('\n').findIndex((line) => line.trim() === FILE_SEPARATOR)
  if (cut === -1) throw new LevelError(`level file has no "${FILE_SEPARATOR}" line`)

  const header: Record<string, string> = {}
  for (const line of body.split('\n').slice(0, cut)) {
    if (line.trim() === '') continue
    const at = line.indexOf(':')
    if (at === -1) throw new LevelError(`header line is not "key: value": ${line}`)
    header[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }

  const map = body.split('\n').slice(cut + 1).join('\n')
  const time = Number(header.time ?? 0)
  const level: Level = {
    id: header.id || 'untitled',
    name: header.name || 'Untitled',
    time: Number.isFinite(time) ? time : 0,
    map,
  }
  if (header.hint) level.hint = header.hint
  if (header.solution) level.solution = header.solution

  // Parse once so a malformed map fails here rather than at play time.
  parseLevel(level.map)
  return level
}
