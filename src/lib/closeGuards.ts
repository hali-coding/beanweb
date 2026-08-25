import { useEffect, useRef } from 'react'
import type { WindowId } from './types'

/**
 * Close guards.
 *
 * An app that holds unsaved state registers a guard; every close path
 * (`requestClose`) asks it for permission first. Guards live in a module-level
 * Map rather than in the desktop store because they are functions — putting
 * them in state would churn the store on every keystroke that changes a
 * closure, for something no component ever renders.
 */

export type CloseGuard = () => boolean | Promise<boolean>

const guards = new Map<WindowId, CloseGuard>()

export function getCloseGuard(id: WindowId): CloseGuard | undefined {
  return guards.get(id)
}

/**
 * Register a guard for the lifetime of a window's component.
 *
 * The guard is re-read from a ref on every call, so it always sees current
 * props and state. Registering the caller's function directly would freeze the
 * first render's closure and check a stale `dirty` flag.
 */
export function useCloseGuard(windowId: WindowId, guard: CloseGuard) {
  const ref = useRef(guard)
  ref.current = guard

  useEffect(() => {
    guards.set(windowId, () => ref.current())
    return () => {
      guards.delete(windowId)
    }
  }, [windowId])
}
