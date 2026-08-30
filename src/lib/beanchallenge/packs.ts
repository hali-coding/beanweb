/**
 * Where levels come from.
 *
 * Nothing outside this file indexes `LEVELS` directly. Today there is one pack,
 * the built-in thirty; when the level editor lands, packs read from the virtual
 * disk join the list returned here and every caller -- the Level menu, the
 * resume logic, progress -- carries on unchanged.
 */

import { CLASSIC } from './levels'
import type { Level, Pack } from './level'

export const DEFAULT_PACK = CLASSIC.id

export function listPacks(): Pack[] {
  return [CLASSIC]
}

export function getPack(id: string): Pack | undefined {
  return listPacks().find((pack) => pack.id === id)
}

/** The pack asked for, or the built-in one if that id is not among them. */
export function packOrDefault(id: string | undefined): Pack {
  return (id ? getPack(id) : undefined) ?? CLASSIC
}

export function levelAt(pack: Pack, index: number): Level | undefined {
  return pack.levels[index]
}

export function indexOfLevel(pack: Pack, levelId: string): number {
  return pack.levels.findIndex((level) => level.id === levelId)
}
