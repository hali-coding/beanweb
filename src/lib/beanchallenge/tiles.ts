/**
 * The tile vocabulary, and the one table that names it.
 *
 * Everything about a tile -- its number, its map character, the label an editor
 * will put in a palette -- comes from `LEGEND` below. Both lookup directions are
 * derived from that array at module load, and the derivation asserts that no
 * character is used twice, so a copy-paste slip in the legend is a startup
 * error rather than a level quietly full of floor.
 *
 * Terrain is stored as a `Uint8Array`, so every tile is a small integer. A
 * `const` object rather than a TS `enum`: the values have to survive into the
 * emitted JS, and `enum` is the one construct the transpile-only pipeline here
 * is unhappy about.
 */

export const Tile = {
  Floor: 0,
  Wall: 1,
  /** Passable by the player, refused by blocks and monsters. */
  Gravel: 2,
  /** Standing on it puts the level's hint in the status line. */
  Hint: 3,

  Bean: 4,
  Socket: 5,
  Exit: 6,

  Water: 7,
  Fire: 8,
  Bomb: 9,
  Teleport: 10,

  KeyRed: 11,
  KeyGreen: 12,
  KeyYellow: 13,
  KeyCyan: 14,
  DoorRed: 15,
  DoorGreen: 16,
  DoorYellow: 17,
  DoorCyan: 18,

  Flippers: 19,
  FireBoots: 20,
  Skates: 21,
  Suction: 22,

  Ice: 23,
  /** Corners are named for the two sides that are walled. */
  IceNE: 24,
  IceNW: 25,
  IceSW: 26,
  IceSE: 27,

  ForceUp: 28,
  ForceDown: 29,
  ForceLeft: 30,
  ForceRight: 31,
  ForceRandom: 32,

  ToggleWall: 33,
  ToggleFloor: 34,
  GreenButton: 35,
} as const

export type Tile = (typeof Tile)[keyof typeof Tile]

/** Things that live *on* the terrain rather than being terrain. */
export type EntityKind = 'player' | 'block' | 'bug' | 'fireball' | 'ball' | 'walker'

export const MONSTER_KINDS = ['bug', 'fireball', 'ball', 'walker'] as const
export type MonsterKind = (typeof MONSTER_KINDS)[number]

/**
 * Palette groupings. An editor will show one section per category; the game
 * itself never reads them.
 */
export type Category =
  | 'terrain'
  | 'goal'
  | 'hazard'
  | 'lock'
  | 'boot'
  | 'ice'
  | 'force'
  | 'toggle'
  | 'actor'

export interface LegendEntry {
  /** The map character. Unique across the whole legend. */
  char: string
  name: string
  category: Category
  /** The terrain this character writes. Entity characters write `Tile.Floor`. */
  tile: Tile
  /** Set when the character also places something on top of the terrain. */
  entity?: EntityKind
}

/*
 * The legend. Two mnemonics are load-bearing and worth keeping if this is ever
 * extended: a key is the lowercase letter and its door the uppercase one, and
 * an ice corner's character is drawn like its two walls -- `7` has a top stroke
 * and a right stroke, so it is walled north and east.
 */
export const LEGEND: LegendEntry[] = [
  { char: '.', name: 'Floor', category: 'terrain', tile: Tile.Floor },
  { char: '#', name: 'Wall', category: 'terrain', tile: Tile.Wall },
  { char: ':', name: 'Gravel', category: 'terrain', tile: Tile.Gravel },
  { char: 'H', name: 'Hint', category: 'terrain', tile: Tile.Hint },

  { char: 'b', name: 'Bean', category: 'goal', tile: Tile.Bean },
  { char: 'S', name: 'Socket', category: 'goal', tile: Tile.Socket },
  { char: 'E', name: 'Exit', category: 'goal', tile: Tile.Exit },

  { char: '~', name: 'Water', category: 'hazard', tile: Tile.Water },
  { char: '%', name: 'Fire', category: 'hazard', tile: Tile.Fire },
  { char: 'o', name: 'Bomb', category: 'hazard', tile: Tile.Bomb },
  { char: 'T', name: 'Teleport', category: 'hazard', tile: Tile.Teleport },

  { char: 'r', name: 'Red key', category: 'lock', tile: Tile.KeyRed },
  { char: 'g', name: 'Green key', category: 'lock', tile: Tile.KeyGreen },
  { char: 'y', name: 'Yellow key', category: 'lock', tile: Tile.KeyYellow },
  { char: 'c', name: 'Cyan key', category: 'lock', tile: Tile.KeyCyan },
  { char: 'R', name: 'Red door', category: 'lock', tile: Tile.DoorRed },
  { char: 'G', name: 'Green door', category: 'lock', tile: Tile.DoorGreen },
  { char: 'Y', name: 'Yellow door', category: 'lock', tile: Tile.DoorYellow },
  { char: 'C', name: 'Cyan door', category: 'lock', tile: Tile.DoorCyan },

  { char: 'f', name: 'Flippers', category: 'boot', tile: Tile.Flippers },
  { char: 'z', name: 'Fire boots', category: 'boot', tile: Tile.FireBoots },
  { char: 'k', name: 'Ice skates', category: 'boot', tile: Tile.Skates },
  { char: 's', name: 'Suction boots', category: 'boot', tile: Tile.Suction },

  { char: 'I', name: 'Ice', category: 'ice', tile: Tile.Ice },
  { char: '7', name: 'Ice corner NE', category: 'ice', tile: Tile.IceNE },
  { char: 'F', name: 'Ice corner NW', category: 'ice', tile: Tile.IceNW },
  { char: 'L', name: 'Ice corner SW', category: 'ice', tile: Tile.IceSW },
  { char: 'J', name: 'Ice corner SE', category: 'ice', tile: Tile.IceSE },

  { char: '^', name: 'Force floor up', category: 'force', tile: Tile.ForceUp },
  { char: 'v', name: 'Force floor down', category: 'force', tile: Tile.ForceDown },
  { char: '<', name: 'Force floor left', category: 'force', tile: Tile.ForceLeft },
  { char: '>', name: 'Force floor right', category: 'force', tile: Tile.ForceRight },
  { char: '?', name: 'Force floor random', category: 'force', tile: Tile.ForceRandom },

  { char: 'X', name: 'Toggle wall', category: 'toggle', tile: Tile.ToggleWall },
  { char: 'x', name: 'Toggle floor', category: 'toggle', tile: Tile.ToggleFloor },
  { char: '!', name: 'Green button', category: 'toggle', tile: Tile.GreenButton },

  { char: 'P', name: 'Player', category: 'actor', tile: Tile.Floor, entity: 'player' },
  { char: '*', name: 'Block', category: 'actor', tile: Tile.Floor, entity: 'block' },
  { char: 'B', name: 'Bug', category: 'actor', tile: Tile.Floor, entity: 'bug' },
  { char: 'A', name: 'Fireball', category: 'actor', tile: Tile.Floor, entity: 'fireball' },
  { char: 'O', name: 'Ball', category: 'actor', tile: Tile.Floor, entity: 'ball' },
  { char: 'W', name: 'Walker', category: 'actor', tile: Tile.Floor, entity: 'walker' },
]

/* ------------------------------------------------------------ derived maps */

export const BY_CHAR: Record<string, LegendEntry> = {}
for (const entry of LEGEND) {
  if (BY_CHAR[entry.char]) {
    throw new Error(`beanchallenge: legend character "${entry.char}" is used twice`)
  }
  BY_CHAR[entry.char] = entry
}

/**
 * The character `formatLevel` writes for a bare terrain tile. Entity characters
 * are excluded, so a cell holding a block over floor round-trips as `*` from the
 * entity table rather than as `.` from here.
 */
export const CHAR_OF_TILE: Record<number, string> = {}
for (const entry of LEGEND) {
  if (!entry.entity) CHAR_OF_TILE[entry.tile] = entry.char
}

export const CHAR_OF_ENTITY = Object.fromEntries(
  LEGEND.filter((e) => e.entity).map((e) => [e.entity, e.char]),
) as Record<EntityKind, string>

export const NAME_OF_TILE: Record<number, string> = {}
for (const entry of LEGEND) {
  if (!entry.entity) NAME_OF_TILE[entry.tile] = entry.name
}

/* -------------------------------------------------------------- predicates */

/** Nothing walks through these -- not the player, not a block, not a monster. */
export const isWall = (t: number): boolean => t === Tile.Wall || t === Tile.ToggleWall

export const isDoor = (t: number): boolean =>
  t === Tile.DoorRed || t === Tile.DoorGreen || t === Tile.DoorYellow || t === Tile.DoorCyan

export const isKey = (t: number): boolean =>
  t === Tile.KeyRed || t === Tile.KeyGreen || t === Tile.KeyYellow || t === Tile.KeyCyan

export const isBoot = (t: number): boolean =>
  t === Tile.Flippers || t === Tile.FireBoots || t === Tile.Skates || t === Tile.Suction

/** Collected on contact, leaving floor behind. */
export const isPickup = (t: number): boolean => t === Tile.Bean || isKey(t) || isBoot(t)

export const isIce = (t: number): boolean =>
  t === Tile.Ice || t === Tile.IceNE || t === Tile.IceNW || t === Tile.IceSW || t === Tile.IceSE

export const isForce = (t: number): boolean =>
  t === Tile.ForceUp ||
  t === Tile.ForceDown ||
  t === Tile.ForceLeft ||
  t === Tile.ForceRight ||
  t === Tile.ForceRandom

/** Doors, keys and boots come in four colours; these agree on the order. */
export type Colour = 0 | 1 | 2 | 3
export const COLOUR_NAMES = ['red', 'green', 'yellow', 'cyan'] as const

export function keyColour(t: number): Colour | null {
  switch (t) {
    case Tile.KeyRed: return 0
    case Tile.KeyGreen: return 1
    case Tile.KeyYellow: return 2
    case Tile.KeyCyan: return 3
    default: return null
  }
}

export function doorColour(t: number): Colour | null {
  switch (t) {
    case Tile.DoorRed: return 0
    case Tile.DoorGreen: return 1
    case Tile.DoorYellow: return 2
    case Tile.DoorCyan: return 3
    default: return null
  }
}

export const BOOT_KINDS = ['flippers', 'fire', 'skates', 'suction'] as const
export type BootKind = (typeof BOOT_KINDS)[number]

export function bootKind(t: number): BootKind | null {
  switch (t) {
    case Tile.Flippers: return 'flippers'
    case Tile.FireBoots: return 'fire'
    case Tile.Skates: return 'skates'
    case Tile.Suction: return 'suction'
    default: return null
  }
}
