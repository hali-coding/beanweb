/**
 * Structural checks on a level.
 *
 * This is a function rather than a pile of test assertions on purpose: the suite
 * runs it over every built-in level, and the level editor will render the same
 * list beside the board as you draw. One implementation, so a level that passes
 * in the editor is a level that passes in CI.
 *
 * Nothing here plays the level. Whether it can actually be *won* is answered by
 * replaying its recorded solution through the engine -- see `replay`.
 */

import { LevelError, parseLevel, type Board, type Level, type Point } from './level'
import { Tile } from './tiles'

export interface Problem {
  severity: 'error' | 'warning'
  message: string
  /** Where on the board, when the problem is about one cell. */
  at?: Point
}

export function validateLevel(level: Level): Problem[] {
  const problems: Problem[] = []

  if (!level.id.trim()) problems.push({ severity: 'error', message: 'The level has no id.' })
  if (!level.name.trim()) problems.push({ severity: 'error', message: 'The level has no name.' })
  if (!Number.isFinite(level.time) || level.time < 0) {
    problems.push({ severity: 'error', message: 'Time must be zero (untimed) or more.' })
  }

  let board: Board
  try {
    board = parseLevel(level.map)
  } catch (err) {
    const message = err instanceof LevelError ? err.message : String(err)
    // Nothing below can run without a board, so this is the whole report.
    return [...problems, { severity: 'error', message: `The map does not parse: ${message}.` }]
  }

  /*
   * A short row is padded with floor, which silently punches a hole in the right
   * border of a hand-drawn map. The parser has to allow it -- an editor grows
   * boards that way -- so the warning belongs here instead.
   */
  const rows = level.map
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
  const ragged = rows.findIndex((row) => row.length !== board.w)
  if (ragged !== -1) {
    problems.push({
      severity: 'warning',
      message: `Row ${ragged} is ${rows[ragged].length} wide, not ${board.w}; the short end fills with floor.`,
    })
  }

  problems.push(...checkBoard(board))
  return problems
}

/** The board-level half, split out so an editor can re-run it without a Level. */
export function checkBoard(board: Board): Problem[] {
  const problems: Problem[] = []
  const { w, h, terrain } = board

  const count = (tile: number) => {
    let n = 0
    for (let i = 0; i < terrain.length; i += 1) if (terrain[i] === tile) n += 1
    return n
  }

  const exits = count(Tile.Exit)
  if (exits === 0) {
    problems.push({ severity: 'error', message: 'There is no exit.' })
  }

  const sockets = count(Tile.Socket)
  if (sockets > 0 && board.beans === 0) {
    problems.push({
      severity: 'warning',
      message: 'The socket opens immediately: there are no beans to collect.',
    })
  }
  if (sockets === 0 && board.beans > 0) {
    problems.push({
      severity: 'warning',
      message: `${board.beans} beans, but no socket -- collecting them does nothing.`,
    })
  }

  const teleports = count(Tile.Teleport)
  if (teleports === 1) {
    problems.push({
      severity: 'warning',
      message: 'A lone teleport sends the player back to itself.',
    })
  }

  const toggles = count(Tile.ToggleWall) + count(Tile.ToggleFloor)
  if (toggles > 0 && count(Tile.GreenButton) === 0) {
    problems.push({
      severity: 'warning',
      message: 'There are toggle walls but no green button to switch them.',
    })
  }

  /*
   * Reachability, generously read: flood from the player through anything that
   * is not a plain wall, counting closed doors as open because a key for them
   * may exist. That will not catch a puzzle whose key is behind its own door,
   * but it does catch the mistake that actually happens -- a region sealed off
   * by walls -- and it never cries wolf about a hard-but-fair level.
   */
  const seen = new Uint8Array(w * h)
  const queue: number[] = [board.player.y * w + board.player.x]
  seen[queue[0]] = 1

  // Teleports form one loop, so reaching any pad reaches them all.
  const pads: number[] = []
  for (let i = 0; i < terrain.length; i += 1) if (terrain[i] === Tile.Teleport) pads.push(i)
  let padsOpen = false

  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head]
    const x = at % w
    const y = (at - x) / w
    const step = (nx: number, ny: number) => {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) return
      const next = ny * w + nx
      if (seen[next]) return
      if (terrain[next] === Tile.Wall) return
      seen[next] = 1
      queue.push(next)
    }
    step(x, y - 1)
    step(x + 1, y)
    step(x, y + 1)
    step(x - 1, y)

    if (!padsOpen && terrain[at] === Tile.Teleport) {
      padsOpen = true
      for (const pad of pads) {
        if (seen[pad]) continue
        seen[pad] = 1
        queue.push(pad)
      }
    }
  }

  const unreachable = (tile: number, what: string) => {
    for (let i = 0; i < terrain.length; i += 1) {
      if (terrain[i] === tile && !seen[i]) {
        problems.push({
          severity: 'warning',
          message: `A ${what} is walled off from the player.`,
          at: { x: i % w, y: Math.floor(i / w) },
        })
        return
      }
    }
  }
  if (exits > 0) unreachable(Tile.Exit, 'exit')
  unreachable(Tile.Bean, 'bean')
  if (sockets > 0) unreachable(Tile.Socket, 'socket')

  return problems
}

/** True when nothing in the report would stop the level being played. */
export const isPlayable = (problems: Problem[]): boolean =>
  !problems.some((p) => p.severity === 'error')
