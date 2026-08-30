import { describe, expect, it } from 'vitest'
import {
  CLASSIC,
  LevelError,
  Tile,
  formatLevel,
  formatLevelFile,
  hintFor,
  parseLevel,
  parseLevelFile,
  replay,
  startLevel,
  step,
  validateLevel,
  type Game,
  type Level,
} from '@/lib/beanchallenge'

/**
 * The rules layer is pure data with no DOM, which is the whole reason it can be
 * tested here at all -- the board itself reaches a canvas, and jsdom has none.
 * Anything about how the game *looks* has to be driven in a real browser.
 *
 * Maps below are the smallest thing that shows the rule. `replay` spends one
 * character per player move, so a two-cell corridor is a complete test case.
 */

const level = (map: string, extra: Partial<Level> = {}): Level => ({
  id: 'test',
  name: 'Test',
  time: 0,
  map,
  ...extra,
})

/** Play `moves` on a one-off map and hand back the finished game. */
const play = (map: string, moves: string, extra: Partial<Level> = {}): Game =>
  replay(level(map, extra), moves)

const tileAt = (g: Game, x: number, y: number) => g.terrain[y * g.w + x]
const at = (g: Game) => [g.player.x, g.player.y]

describe('parsing', () => {
  const map = `
#####
#P.b#
#*B.#
#####`

  it('lifts the movers out of the terrain', () => {
    const board = parseLevel(map)
    expect(board.w).toBe(5)
    expect(board.h).toBe(4)
    expect(board.player).toEqual({ x: 1, y: 1 })
    expect(board.blocks).toEqual([{ x: 1, y: 2 }])
    expect(board.monsters).toEqual([{ x: 2, y: 2, kind: 'bug', dir: 2 }])
    expect(board.beans).toBe(1)
    // The cell a mover stands on is floor, not the character that put it there.
    expect(board.terrain[2 * 5 + 1]).toBe(Tile.Floor)
  })

  it('pads a short row rather than refusing it', () => {
    // An editor grows boards this way; `validateLevel` is what warns about it.
    const board = parseLevel('#####\n#P.\n#####')
    expect(board.w).toBe(5)
    expect(board.terrain[1 * 5 + 4]).toBe(Tile.Floor)
  })

  it('rejects a map it cannot read', () => {
    expect(() => parseLevel('#####\n#P.Q#\n#####')).toThrow(LevelError)
    expect(() => parseLevel('#####\n#P.P#\n#####')).toThrow(/second player/)
    expect(() => parseLevel('#####\n#...#\n#####')).toThrow(/no player start/)
    expect(() => parseLevel('   \n  ')).toThrow(/empty/)
  })
})

describe('formatting', () => {
  it('is the exact inverse of parsing', () => {
    const map = '#####\n#P.b#\n#*B~#\n#####'
    expect(formatLevel(parseLevel(map))).toBe(map)
  })

  it('round-trips every built-in level', () => {
    for (const entry of CLASSIC.levels) {
      const once = formatLevel(parseLevel(entry.map))
      const twice = formatLevel(parseLevel(once))
      expect(twice, entry.id).toBe(once)
    }
  })

  it('round-trips a level file', () => {
    const source = CLASSIC.levels[8]
    const text = formatLevelFile(source)
    const back = parseLevelFile(text)
    expect(back.id).toBe(source.id)
    expect(back.name).toBe(source.name)
    expect(back.time).toBe(source.time)
    expect(back.hint).toBe(source.hint)
    expect(back.solution).toBe(source.solution)
    expect(formatLevel(parseLevel(back.map))).toBe(formatLevel(parseLevel(source.map)))
  })

  it('refuses a file with no rule between header and map', () => {
    expect(() => parseLevelFile('name: Nope\n#####\n#P.E#\n#####')).toThrow(LevelError)
  })
})

describe('validation', () => {
  it('passes every built-in level', () => {
    for (const entry of CLASSIC.levels) {
      expect(validateLevel(entry), entry.id).toEqual([])
    }
  })

  const problems = (map: string) => validateLevel(level(map)).map((p) => p.message)

  it('reports a level with no exit', () => {
    expect(problems('#####\n#P..#\n#####')).toContain('There is no exit.')
  })

  it('reports a ragged row, which parses as a hole in the wall', () => {
    expect(problems('#####\n#P.E#\n#..\n#####').join(' ')).toMatch(/Row 2 is 3 wide, not 5/)
  })

  it('reports a lone teleport and a button-less toggle wall', () => {
    expect(problems('#####\n#PTE#\n#####').join(' ')).toMatch(/lone teleport/)
    expect(problems('#####\n#PXE#\n#####').join(' ')).toMatch(/no green button/)
  })

  it('reports something sealed off behind walls', () => {
    const map = `
#######
#P...E#
#######
#..b..#
#######`
    expect(problems(map).join(' ')).toMatch(/bean is walled off/)
  })

  it('counts a teleport as a way through', () => {
    const map = `
#######
#PT..E#
#######
#..bT.#
#######`
    expect(problems(map).join(' ')).not.toMatch(/walled off/)
  })

  it('returns one error and stops when the map does not parse', () => {
    const report = validateLevel(level('#####\n#PQ.#\n#####'))
    expect(report).toHaveLength(1)
    expect(report[0].severity).toBe('error')
  })
})

describe('walking', () => {
  it('moves one square per move and stops at a wall', () => {
    expect(at(play('#####\n#P..#\n#####', 'RR'))).toEqual([3, 1])
    expect(at(play('#####\n#.P.#\n#####', 'LLL'))).toEqual([1, 1])
  })

  it('collects a bean, opens the socket, and leaves by the exit', () => {
    const g = play('########\n#P.b.SE#\n########', 'RRRRR')
    expect(g.status).toBe('complete')
    expect(g.beansLeft).toBe(0)
  })

  it('refuses the socket while a bean is still on the floor', () => {
    const map = `
#####
#P.S#
#b.E#
#####`
    expect(at(play(map, 'RR'))).toEqual([2, 1])
    // Fetch the bean first and the same square lets you through.
    expect(play(map, 'DLRURD').status).toBe('complete')
  })

  it('reports the level hint while standing on a hint square', () => {
    const g = play('#####\n#PH.#\n#####', 'R', { hint: 'Mind the gap' })
    expect(hintFor(g)).toBe('Mind the gap')
    expect(hintFor(play('#####\n#PH.#\n#####', 'RR', { hint: 'Mind the gap' }))).toBeNull()
  })

  it('runs out of time', () => {
    expect(play('#####\n#P.E#\n#####', '.....', { time: 1 }).status).toBe('timeout')
  })
})

describe('keys and doors', () => {
  it('spends one key of the matching colour and burns the door out', () => {
    const g = play('######\n#PrRE#\n######', 'RR')
    expect(at(g)).toEqual([3, 1])
    expect(g.keys[0]).toBe(0)
    expect(tileAt(g, 3, 1)).toBe(Tile.Floor)
  })

  it('will not open a door with the wrong colour key', () => {
    const g = play('######\n#PgRE#\n######', 'RR')
    expect(at(g)).toEqual([2, 1])
    expect(g.keys[1]).toBe(1)
  })
})

describe('hazards and boots', () => {
  it('drowns, burns and explodes', () => {
    expect(play('######\n#P~.E#\n######', 'R').status).toBe('drowned')
    expect(play('######\n#P%.E#\n######', 'R').status).toBe('burned')
    expect(play('######\n#Po.E#\n######', 'R').status).toBe('exploded')
  })

  it('lets the matching boots through, and only the matching pair', () => {
    expect(play('#######\n#Pf~.E#\n#######', 'RRRR').status).toBe('complete')
    expect(play('#######\n#Pz%.E#\n#######', 'RRRR').status).toBe('complete')
    // Flippers are no help in a fire.
    expect(play('#######\n#Pf%.E#\n#######', 'RR').status).toBe('burned')
  })
})

describe('blocks', () => {
  it('pushes one square when the far side is clear', () => {
    const g = play('#######\n#P*..E#\n#######', 'R')
    expect(at(g)).toEqual([2, 1])
    expect(g.blocks).toEqual([{ x: 3, y: 1 }])
  })

  it('refuses the push, and the move, when there is nowhere to go', () => {
    const g = play('####\n#P*#\n####', 'R')
    expect(at(g)).toEqual([1, 1])
    expect(g.blocks).toEqual([{ x: 2, y: 1 }])
  })

  it('fills water in, and takes a bomb with it', () => {
    const wet = play('######\n#P*~.#\n######', 'R')
    expect(wet.blocks).toHaveLength(0)
    expect(tileAt(wet, 3, 1)).toBe(Tile.Floor)

    const boom = play('######\n#P*o.#\n######', 'R')
    expect(boom.blocks).toHaveLength(0)
    expect(tileAt(boom, 3, 1)).toBe(Tile.Floor)
  })
})

describe('ice', () => {
  it('keeps you going until something stops you', () => {
    expect(at(play('########\n#PII..E#\n########', 'R..'))).toEqual([4, 1])
  })

  it('bounces you back off the far wall', () => {
    expect(at(play('#####\n#PI##\n#..##\n#####', 'R..'))).toEqual([1, 1])
  })

  it('turns you at a corner', () => {
    // 7 is walled north and east, so arriving eastbound sends you south.
    expect(at(play('#####\n#P.7#\n#..I#\n#####', 'RR.'))).toEqual([3, 2])
  })

  it('will not let you in through one of the corner rails', () => {
    expect(at(play('#####\n#.P.#\n#..7#\n#####', 'RD'))).toEqual([3, 1])
  })

  it('is cancelled outright by skates', () => {
    const g = play('########\n#PkII.E#\n########', 'RR.')
    expect(at(g)).toEqual([3, 1])
    expect(g.boots.skates).toBe(true)
  })
})

describe('force floors', () => {
  it('carries you along whether you asked or not', () => {
    expect(at(play('#######\n#P>>.E#\n#######', 'R..'))).toEqual([4, 1])
  })

  it('is cancelled by suction boots', () => {
    expect(at(play('########\n#Ps>>.E#\n########', 'RR.'))).toEqual([3, 1])
  })
})

describe('toggles and teleports', () => {
  it('flips every toggle square when the button is pressed', () => {
    expect(play('#######\n#P!X.E#\n#######', 'RRRR').status).toBe('complete')
    const shut = play('#######\n#P.X.E#\n#######', 'RRRR')
    expect(shut.status).toBe('playing')
    expect(at(shut)).toEqual([2, 1])
  })

  it('sends you to the next pad in reading order', () => {
    expect(at(play('#######\n#PT..T#\n#######', 'R'))).toEqual([5, 1])
  })
})

describe('monsters', () => {
  const walk = (map: string, moves: string) => play(map, moves).monsters[0]

  it('sends a bug round its left-hand wall and a fireball round its right', () => {
    expect(walk('######\n#P...#\n#.B..#\n######', '.')).toMatchObject({ x: 3, y: 2 })
    expect(walk('######\n#P...#\n#.A..#\n######', '.')).toMatchObject({ x: 1, y: 2 })
  })

  it('runs a ball down its line and turns it round at the end', () => {
    const map = '######\n#P...#\n#.O..#\n#....#\n######'
    expect(walk(map, '.')).toMatchObject({ x: 2, y: 3, dir: 2 })
    expect(walk(map, '..')).toMatchObject({ x: 2, y: 2, dir: 0 })
  })

  it('catches the player when it steps onto them', () => {
    expect(play('####\n#PB#\n####', '.').status).toBe('caught')
  })

  it('treats water and fire as walls, except a fireball in fire', () => {
    // Walled in by water east and west with a wall south, the bug goes north.
    // Monsters never drown: a bug that read water as floor would walk into it
    // on the first tick and empty every level that had both.
    expect(walk('######\n#P...#\n#~B~.#\n######', '.')).toMatchObject({ x: 2, y: 1 })
    // A fireball crosses flame, so its right-hand turn into fire is taken.
    expect(walk('######\n#P...#\n#%A..#\n######', '.')).toMatchObject({ x: 1, y: 2 })
  })

  it('replays a walker identically, because the seed lives in the game', () => {
    const map = '#######\n#P....#\n#..W..#\n#.....#\n#######'
    const once = play(map, '......')
    expect(once.monsters).toEqual(play(map, '......').monsters)
    // And it really did draw on the game's own generator rather than Math.random.
    expect(once.seed).not.toBe(startLevel(level(map)).seed)
  })
})

describe('the clock and the tick', () => {
  it('moves the player on odd ticks and the monsters on even ones', () => {
    const g = startLevel(level('######\n#P...#\n#.B..#\n######'))
    const one = step(g, 1)
    expect([one.player.x, one.monsters[0].x]).toEqual([2, 2])
    const two = step(one, null)
    expect([two.player.x, two.monsters[0].x]).toEqual([2, 3])
  })

  it('is inert once the level is over', () => {
    const done = play('#####\n#P.E#\n#####', 'RR')
    expect(done.status).toBe('complete')
    expect(step(done, 3)).toBe(done)
  })
})

describe('the built-in pack', () => {
  it('has thirty levels with distinct ids', () => {
    expect(CLASSIC.levels).toHaveLength(30)
    expect(new Set(CLASSIC.levels.map((l) => l.id)).size).toBe(30)
  })

  /*
   * The one test that keeps thirty hand-drawn puzzles honest: every level
   * carries a recorded winning run, and a rule change that makes any of them
   * unwinnable fails here rather than in front of a player on level 24.
   */
  it('can still be finished, level by level', () => {
    for (const entry of CLASSIC.levels) {
      expect(entry.solution, `${entry.id} has no recorded solution`).toBeTruthy()
      expect(replay(entry, entry.solution!).status, entry.id).toBe('complete')
    }
  })

  /*
   * The five levels built around pushing. Each one puts a block in the single
   * mouth of a corridor, so the only way on is to shove it to the dead end and
   * squeeze past; a solver that froze every block into a wall could not finish
   * any of them, and freezing any one block on its own was enough to stop it.
   *
   * That is the property worth guarding, and this is the cheap half of it: if a
   * block the level ships is still standing where it started when the recorded
   * run ends, the gate it was supposed to be has a way around it.
   */
  const BLOCK_PUZZLES = ['under-lock', 'heavy-lifting', 'deep-end', 'cold-comfort', 'skate-park']

  it.each(BLOCK_PUZZLES)('makes every block in %s load-bearing', (id) => {
    const level = CLASSIC.levels.find((l) => l.id === id)!
    const start = startLevel(level)
    expect(start.blocks.length).toBeGreaterThanOrEqual(3)

    const end = replay(level, level.solution!)
    // A block pushed into water, fire or a bomb is gone from the list entirely,
    // which counts as moved -- what must not happen is one still on its square.
    const resting = new Set(end.blocks.map((b) => `${b.x},${b.y}`))
    const idle = start.blocks.filter((b) => resting.has(`${b.x},${b.y}`))
    expect(idle, `${id} never shifts ${idle.length} of its blocks`).toEqual([])
  })
})
