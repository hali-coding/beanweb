/**
 * The rules. Pure data in, pure data out -- no DOM, no canvas, no timers.
 *
 * That is what makes the whole game testable under jsdom, the same bargain
 * `lib/basic/screen.ts` makes. `step` advances one tick and returns a new
 * `Game`; the interval that calls it lives in `apps/BeanChallenge.tsx`, because
 * the store is synchronous and the view paces it -- the division Shut Down and
 * the theme curtain already use.
 *
 * `startLevel` takes a `Level` object rather than an index on purpose: a level
 * editor has to be able to playtest a board that has never been saved.
 */

import {
  DELTA,
  MOVE_CHARS,
  S,
  parseLevel,
  turnBack,
  turnLeft,
  turnRight,
  type Dir,
  type Level,
  type MonsterSpawn,
  type Point,
} from './level'
import {
  Tile,
  bootKind,
  doorColour,
  isDoor,
  isForce,
  isIce,
  isPickup,
  isWall,
  keyColour,
  type BootKind,
  type Colour,
  type MonsterKind,
} from './tiles'

/** One tick of the clock, in milliseconds. */
export const TICK_MS = 100
/** Ticks per move. The player moves on odd ticks, monsters on even ones. */
export const PLAYER_PERIOD = 2
const TICKS_PER_SECOND = 1000 / TICK_MS

export type Status = 'playing' | 'complete' | 'drowned' | 'burned' | 'caught' | 'exploded' | 'timeout'

export interface Monster extends Point {
  kind: MonsterKind
  dir: Dir
}

export interface Game {
  level: Level
  w: number
  h: number
  terrain: Uint8Array
  player: { x: number; y: number; dir: Dir }
  blocks: Point[]
  monsters: Monster[]
  /** One count per colour, in `COLOUR_NAMES` order. */
  keys: number[]
  boots: Record<BootKind, boolean>
  beansLeft: number
  /** Beans the level started with, for the HUD. */
  beansTotal: number
  ticks: number
  /** Seconds left, or `Infinity` when the level is untimed. */
  timeLeft: number
  status: Status
  /** Bumped whenever anything visible changed; the view blits on the change. */
  version: number
  seed: number
}

/* --------------------------------------------------------------- randomness */

/*
 * xorshift32, carried in the game state rather than reached for from
 * `Math.random`. Walkers and random force floors are then reproducible, which is
 * what lets a recorded solution replay identically in CI and in the editor's
 * "verify solvable" button.
 */
function random(game: Game): number {
  let s = game.seed | 0
  s ^= s << 13
  s ^= s >>> 17
  s ^= s << 5
  game.seed = s | 0
  return ((s >>> 0) % 0x100000) / 0x100000
}

/** A level always starts from the same seed unless a caller says otherwise. */
function seedFrom(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h | 0 || 1
}

/* ------------------------------------------------------------------- set-up */

export function startLevel(level: Level, seed?: number): Game {
  const board = parseLevel(level.map)
  return {
    level,
    w: board.w,
    h: board.h,
    terrain: board.terrain.slice(),
    player: { x: board.player.x, y: board.player.y, dir: S },
    blocks: board.blocks.map((b) => ({ ...b })),
    monsters: board.monsters.map((m: MonsterSpawn) => ({ ...m })),
    keys: [0, 0, 0, 0],
    boots: { flippers: false, fire: false, skates: false, suction: false },
    beansLeft: board.beans,
    beansTotal: board.beans,
    ticks: 0,
    timeLeft: level.time > 0 ? level.time : Infinity,
    status: 'playing',
    version: 0,
    seed: seed ?? seedFrom(level.id),
  }
}

function clone(game: Game): Game {
  return {
    ...game,
    terrain: game.terrain.slice(),
    player: { ...game.player },
    blocks: game.blocks.map((b) => ({ ...b })),
    monsters: game.monsters.map((m) => ({ ...m })),
    keys: [...game.keys],
    boots: { ...game.boots },
  }
}

/* ------------------------------------------------------------------ queries */

const at = (g: Game, x: number, y: number): number =>
  x < 0 || x >= g.w || y < 0 || y >= g.h ? Tile.Wall : g.terrain[y * g.w + x]

const put = (g: Game, x: number, y: number, tile: number) => {
  g.terrain[y * g.w + x] = tile
}

export const blockAt = (g: Game, x: number, y: number): number =>
  g.blocks.findIndex((b) => b.x === x && b.y === y)

export const monsterAt = (g: Game, x: number, y: number): number =>
  g.monsters.findIndex((m) => m.x === x && m.y === y)

/** The hint to show, when the player is standing on a hint tile. */
export const hintFor = (g: Game): string | null =>
  at(g, g.player.x, g.player.y) === Tile.Hint ? (g.level.hint ?? null) : null

/*
 * An ice corner is walled on two sides. Entering while heading `dir` means
 * coming in through the *opposite* side, so a move is refused when that side is
 * one of the two.
 */
const CORNER_WALLS: Record<number, [Dir, Dir]> = {
  [Tile.IceNE]: [0, 1],
  [Tile.IceNW]: [0, 3],
  [Tile.IceSW]: [2, 3],
  [Tile.IceSE]: [2, 1],
}

function cornerBlocks(tile: number, dir: Dir): boolean {
  const walls = CORNER_WALLS[tile]
  return walls ? walls.includes(turnBack(dir)) : false
}

/** Where an ice tile sends something that arrives heading `dir`. */
export function deflect(tile: number, dir: Dir): Dir {
  switch (tile) {
    case Tile.IceNE: return dir === 0 ? 3 : dir === 1 ? 2 : dir
    case Tile.IceNW: return dir === 0 ? 1 : dir === 3 ? 2 : dir
    case Tile.IceSW: return dir === 2 ? 1 : dir === 3 ? 0 : dir
    case Tile.IceSE: return dir === 2 ? 3 : dir === 1 ? 0 : dir
    default: return dir
  }
}

function forceDir(g: Game, tile: number): Dir {
  switch (tile) {
    case Tile.ForceUp: return 0
    case Tile.ForceRight: return 1
    case Tile.ForceDown: return 2
    case Tile.ForceLeft: return 3
    default: return Math.floor(random(g) * 4) as Dir
  }
}

/* ------------------------------------------------------------- player moves */

/** Can the player step onto this cell, heading `dir`? Hazards say yes and kill. */
function playerCanEnter(g: Game, x: number, y: number, dir: Dir): boolean {
  const tile = at(g, x, y)
  if (isWall(tile)) return false
  if (cornerBlocks(tile, dir)) return false
  if (tile === Tile.Socket && g.beansLeft > 0) return false
  const colour = doorColour(tile)
  if (colour !== null && g.keys[colour] <= 0) return false
  if (monsterAt(g, x, y) !== -1) return true // fatal, but not blocked
  return true
}

/**
 * Push a block one cell. Water, fire and a bomb all swallow it and are levelled
 * to floor -- the move half these puzzles are built on. Returns false if the
 * block has nowhere to go, which also refuses the player's move.
 */
function pushBlock(g: Game, index: number, dir: Dir): boolean {
  const block = g.blocks[index]
  const [dx, dy] = DELTA[dir]
  const nx = block.x + dx
  const ny = block.y + dy
  const tile = at(g, nx, ny)

  if (isWall(tile) || isDoor(tile)) return false
  if (tile === Tile.Gravel || tile === Tile.Socket || tile === Tile.Exit) return false
  if (tile === Tile.Teleport || isPickup(tile)) return false
  if (cornerBlocks(tile, dir)) return false
  if (blockAt(g, nx, ny) !== -1) return false
  if (monsterAt(g, nx, ny) !== -1) return false

  if (tile === Tile.Water || tile === Tile.Fire || tile === Tile.Bomb) {
    put(g, nx, ny, Tile.Floor)
    g.blocks.splice(index, 1)
    return true
  }
  block.x = nx
  block.y = ny
  return true
}

/** Everything that happens because the player is now standing here. */
function arrive(g: Game) {
  const { x, y } = g.player
  const tile = at(g, x, y)

  if (monsterAt(g, x, y) !== -1) {
    g.status = 'caught'
    return
  }

  const colour: Colour | null = keyColour(tile)
  if (colour !== null) {
    g.keys[colour] += 1
    put(g, x, y, Tile.Floor)
    return
  }

  const boot = bootKind(tile)
  if (boot) {
    g.boots[boot] = true
    put(g, x, y, Tile.Floor)
    return
  }

  const door = doorColour(tile)
  if (door !== null) {
    g.keys[door] -= 1
    put(g, x, y, Tile.Floor)
    return
  }

  switch (tile) {
    case Tile.Bean:
      g.beansLeft -= 1
      put(g, x, y, Tile.Floor)
      return
    case Tile.Socket:
      // Only reachable with every bean collected; the socket burns out.
      put(g, x, y, Tile.Floor)
      return
    case Tile.Exit:
      g.status = 'complete'
      return
    case Tile.Water:
      if (!g.boots.flippers) g.status = 'drowned'
      return
    case Tile.Fire:
      if (!g.boots.fire) g.status = 'burned'
      return
    case Tile.Bomb:
      g.status = 'exploded'
      return
    case Tile.GreenButton:
      flipToggles(g)
      return
    case Tile.Teleport:
      teleport(g)
      return
    default:
  }
}

function flipToggles(g: Game) {
  for (let i = 0; i < g.terrain.length; i += 1) {
    if (g.terrain[i] === Tile.ToggleWall) g.terrain[i] = Tile.ToggleFloor
    else if (g.terrain[i] === Tile.ToggleFloor) g.terrain[i] = Tile.ToggleWall
  }
}

/**
 * Teleports form one cycle in reading order. Stepping onto one puts the player
 * on the next; they walk off it under their own power on a later tick, so there
 * is no re-trigger to guard against.
 */
function teleport(g: Game) {
  const pads: number[] = []
  for (let i = 0; i < g.terrain.length; i += 1) if (g.terrain[i] === Tile.Teleport) pads.push(i)
  if (pads.length < 2) return

  const here = g.player.y * g.w + g.player.x
  const from = pads.indexOf(here)
  if (from === -1) return

  for (let step = 1; step < pads.length; step += 1) {
    const pad = pads[(from + step) % pads.length]
    const x = pad % g.w
    const y = (pad - x) / g.w
    if (blockAt(g, x, y) !== -1 || monsterAt(g, x, y) !== -1) continue
    g.player.x = x
    g.player.y = y
    return
  }
}

function movePlayer(g: Game, input: Dir | null) {
  const here = at(g, g.player.x, g.player.y)
  const sliding = (isIce(here) && !g.boots.skates) || (isForce(here) && !g.boots.suction)

  let dir: Dir | null
  if (isIce(here) && !g.boots.skates) {
    dir = deflect(here, g.player.dir)
  } else if (isForce(here) && !g.boots.suction) {
    dir = forceDir(g, here)
  } else {
    dir = input
  }
  if (dir === null) return

  g.player.dir = dir
  const [dx, dy] = DELTA[dir]
  const nx = g.player.x + dx
  const ny = g.player.y + dy

  const block = blockAt(g, nx, ny)
  if (block !== -1) {
    // A block cannot be pushed while sliding: there is no weight behind it.
    if (sliding || !playerCanEnter(g, nx, ny, dir) || !pushBlock(g, block, dir)) {
      if (sliding) g.player.dir = turnBack(dir)
      return
    }
  } else if (!playerCanEnter(g, nx, ny, dir)) {
    // Ice bounces you back the way you came; a wall just stops you.
    if (sliding) g.player.dir = turnBack(dir)
    return
  }

  g.player.x = nx
  g.player.y = ny
  arrive(g)
}

/* ------------------------------------------------------------ monster moves */

/**
 * Water and fire are walls to a monster rather than a way for it to die -- a
 * bug that treated water as floor would walk into it on the first tick and every
 * level with both would empty itself. A fireball is the one exception, and
 * crosses fire. A monster that steps on a bomb sets it off and goes with it.
 */
function monsterCanEnter(g: Game, m: Monster, x: number, y: number, dir: Dir): boolean {
  const tile = at(g, x, y)
  if (isWall(tile) || isDoor(tile)) return false
  if (tile === Tile.Gravel || tile === Tile.Socket || tile === Tile.Exit) return false
  if (tile === Tile.Water) return false
  if (tile === Tile.Fire && m.kind !== 'fireball') return false
  if (cornerBlocks(tile, dir)) return false
  if (blockAt(g, x, y) !== -1) return false
  if (monsterAt(g, x, y) !== -1) return false
  return true
}

/** Each monster's preference order, given the way it is currently facing. */
function choices(kind: MonsterKind, dir: Dir): Dir[] {
  switch (kind) {
    case 'bug':
      return [turnLeft(dir), dir, turnRight(dir), turnBack(dir)]
    case 'fireball':
      return [turnRight(dir), dir, turnLeft(dir), turnBack(dir)]
    case 'ball':
      return [dir, turnBack(dir)]
    default:
      return [dir]
  }
}

function moveMonsters(g: Game) {
  for (let i = 0; i < g.monsters.length; i += 1) {
    const m = g.monsters[i]
    let options = choices(m.kind, m.dir)
    if (m.kind === 'walker') {
      // A blocked walker picks again from all four, using the game's own PRNG so
      // the level still replays the same way twice.
      const spin = Math.floor(random(g) * 4)
      options = [m.dir, ...[0, 1, 2, 3].map((d) => ((d + spin) % 4) as Dir)]
    }

    for (const dir of options) {
      const [dx, dy] = DELTA[dir]
      const nx = m.x + dx
      const ny = m.y + dy
      if (!monsterCanEnter(g, m, nx, ny, dir)) continue
      m.dir = dir
      m.x = nx
      m.y = ny
      if (at(g, nx, ny) === Tile.Bomb) {
        put(g, nx, ny, Tile.Floor)
        g.monsters.splice(i, 1)
        i -= 1
      }
      break
    }
  }
}

/* --------------------------------------------------------------------- step */

/**
 * Advance one tick. `input` is the direction currently being asked for, or null
 * for none; it is only consulted on the player's phase, and ignored entirely
 * while sliding.
 */
export function step(game: Game, input: Dir | null): Game {
  if (game.status !== 'playing') return game

  const g = clone(game)
  g.ticks += 1
  g.version += 1

  if (g.timeLeft !== Infinity && g.ticks % TICKS_PER_SECOND === 0) {
    g.timeLeft -= 1
    if (g.timeLeft <= 0) {
      g.timeLeft = 0
      g.status = 'timeout'
      return g
    }
  }

  if (g.ticks % 2 === 1) {
    movePlayer(g, input)
  } else {
    moveMonsters(g)
    if (monsterAt(g, g.player.x, g.player.y) !== -1) g.status = 'caught'
  }

  return g
}

/**
 * Replay a recorded solution. One character is one player move: `U D L R`, or
 * `.` to stand still for a move -- which is how a listing waits out a slide or
 * lets a monster pass.
 *
 * This is what proves a hand-authored level is winnable. The suite runs it over
 * every built-in level, and the editor will run it over one.
 */
export function replay(level: Level, moves: string, seed?: number): Game {
  let g = startLevel(level, seed)
  for (const char of moves) {
    if (char === '\n' || char === ' ') continue
    const dir = char === '.' ? null : MOVE_CHARS[char]
    if (dir === undefined) throw new Error(`beanchallenge: unknown move "${char}"`)
    for (let i = 0; i < PLAYER_PERIOD && g.status === 'playing'; i += 1) g = step(g, dir)
    if (g.status !== 'playing') break
  }
  return g
}
