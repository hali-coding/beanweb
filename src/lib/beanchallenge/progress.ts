/**
 * How far the player has got, kept in localStorage.
 *
 * Keyed by pack id and then by *level id* rather than by position, so inserting
 * or reordering a level never silently relabels what someone has finished -- and
 * so a pack made in the level editor gets its own progress without colliding
 * with the built-in one.
 *
 * There is deliberately no module-level cache. `tests/setup.ts` resets state
 * with `localStorage.clear()`, and a copy held in a module singleton would
 * survive that and leak between tests. Reading a few hundred bytes on demand
 * costs nothing.
 */

import type { Level, Pack } from './level'

const STORAGE_KEY = 'beanweb.beanchallenge.v1'

export interface PackProgress {
  /** Ids of levels finished, in no particular order. */
  completed: string[]
  /** The level to open the app on. */
  current: string
}

export type Progress = Record<string, PackProgress>

/*
 * Every field is validated on the way in, so a record written before a field
 * existed reads back as that field's default and nothing needs a migrate step.
 * Same bargain as `store/settings.ts`.
 */
export function readProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Partial<PackProgress>>
    const out: Progress = {}
    for (const [packId, value] of Object.entries(parsed ?? {})) {
      if (!value || typeof value !== 'object') continue
      out[packId] = {
        completed: Array.isArray(value.completed)
          ? value.completed.filter((id): id is string => typeof id === 'string')
          : [],
        current: typeof value.current === 'string' ? value.current : '',
      }
    }
    return out
  } catch {
    return {}
  }
}

/*
 * Written straight through rather than debounced, unlike `store/fs.ts` and
 * `store/settings.ts`. Those coalesce a burst of keystrokes; this changes twice
 * a level. Debouncing it would mean the next `readProgress` -- which is the only
 * copy there is -- returned the state from before the write, so finishing a
 * level and then opening the next one would drop the completion.
 */
function persist(progress: Progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress))
  } catch {
    /* Quota or private-mode failure: the session still works in memory. */
  }
}

function update(packId: string, change: (p: PackProgress) => PackProgress): Progress {
  const all = readProgress()
  const next = { ...all, [packId]: change(all[packId] ?? { completed: [], current: '' }) }
  persist(next)
  return next
}

export function markComplete(packId: string, levelId: string): Progress {
  return update(packId, (p) =>
    p.completed.includes(levelId) ? p : { ...p, completed: [...p.completed, levelId] },
  )
}

export function setCurrent(packId: string, levelId: string): Progress {
  return update(packId, (p) => ({ ...p, current: levelId }))
}

/** Wipe one pack's record. Used by *Game -> New game*. */
export function resetPack(packId: string): Progress {
  return update(packId, () => ({ completed: [], current: '' }))
}

/**
 * The furthest level the player may open: the first one, plus one past every
 * level they have finished. Finishing level 5 out of order still unlocks 6.
 */
export function furthestUnlocked(pack: Pack, progress: Progress): number {
  const done = new Set(progress[pack.id]?.completed ?? [])
  let furthest = 0
  pack.levels.forEach((level, i) => {
    if (done.has(level.id)) furthest = Math.max(furthest, i + 1)
  })
  return Math.min(furthest, pack.levels.length - 1)
}

export const isComplete = (progress: Progress, packId: string, levelId: string): boolean =>
  (progress[packId]?.completed ?? []).includes(levelId)

/** Where to resume: the saved level if it is still unlocked, else the furthest. */
export function resumeIndex(pack: Pack, progress: Progress): number {
  const limit = furthestUnlocked(pack, progress)
  const current = progress[pack.id]?.current
  const at = current ? pack.levels.findIndex((l: Level) => l.id === current) : -1
  return at >= 0 && at <= limit ? at : limit
}
