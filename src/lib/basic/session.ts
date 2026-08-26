import type { WindowId } from '@/lib/types'
import { Screen } from './screen'
import type { Status } from './interpreter'

/**
 * The link between a BASIC editor window and its screen window.
 *
 * The two are separate app windows with no React relationship, so they meet
 * here instead — the same reason close guards live in a module-level Map
 * rather than in the store. What passes between them is a `Screen` the
 * interpreter mutates thousands of times a second and a keyboard queue; neither
 * belongs in a Zustand store, because putting them there would mean a store
 * write per pixel.
 *
 * The screen window reads pixels straight off `screen` on its own animation
 * frame and re-renders React only when `status` changes, which is what
 * `subscribe` is for.
 */
export interface BasicSession {
  /** The one screen object, kept across runs so the window never re-attaches. */
  readonly screen: Screen
  /** Name of the program, for the screen window's title. */
  name: string
  status: Status
  /** The screen window showing this session, if one is open. */
  screenWindow: WindowId | null

  /**
   * F5 and Stop, installed by the editor window.
   *
   * The screen window has no Run button, and F5 pressed over it would reload
   * the tab, so it needs a way to reach the editor's controls. They are plain
   * mutable fields for the same reason `screen` is: reassigning them must not
   * re-render anything.
   */
  run: () => void
  stop: () => void

  /** Queue a keystroke for INKEY$ and for a bare SLEEP to find. */
  pressKey(key: string): void
  /** Take the next queued keystroke, or "" if none. */
  takeKey(): string
  /** Drop anything typed before a run starts. */
  clearKeys(): void

  /** Re-render whatever is watching. Cheap; call it on status changes only. */
  notify(): void
  subscribe(listener: () => void): () => void
  /** For `useSyncExternalStore`: changes identity only when something did. */
  getSnapshot(): number
}

const sessions = new Map<WindowId, BasicSession>()

/** The keyboard queue is small on purpose: INKEY$ reads the recent past, not a log. */
const MAX_KEYS = 32

export function createSession(id: WindowId, name: string): BasicSession {
  const existing = sessions.get(id)
  if (existing) return existing

  const listeners = new Set<() => void>()
  const keys: string[] = []
  let revision = 0

  const session: BasicSession = {
    screen: new Screen(0),
    name,
    status: 'ready',
    screenWindow: null,

    // No-ops until the editor window's effect installs the real ones.
    run: () => {},
    stop: () => {},

    pressKey: (key) => {
      keys.push(key)
      if (keys.length > MAX_KEYS) keys.shift()
    },
    takeKey: () => keys.shift() ?? '',
    clearKeys: () => {
      keys.length = 0
    },

    notify: () => {
      revision += 1
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => revision,
  }

  sessions.set(id, session)
  return session
}

export const getSession = (id: WindowId): BasicSession | undefined => sessions.get(id)

/**
 * Put a session back in the registry.
 *
 * Needed because the session is built during render but torn down in an
 * effect, and React runs mount/cleanup/mount on every mount in development.
 * The cleanup of that first throwaway pass would otherwise unregister a
 * session that nothing ever creates again, leaving the screen window unable to
 * find the program it belongs to.
 */
export function attachSession(id: WindowId, session: BasicSession): void {
  sessions.set(id, session)
}

export function destroySession(id: WindowId): void {
  sessions.delete(id)
}
