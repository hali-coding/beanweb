import { create } from 'zustand'
import { getCloseGuard } from '@/lib/closeGuards'
import type {
  AlertKind,
  AlertState,
  BWindowState,
  Rect,
  KeyPromptState,
  SavePanelState,
  WindowId,
} from '@/lib/types'

/**
 * Desktop state.
 *
 * Performance note: window geometry lives here, but a *live* drag never writes
 * to this store. The drag hook mutates the element's transform directly and
 * calls commitRect() once on release, so dragging a window re-renders nothing.
 * See wm/useWindowGesture.ts.
 */

let nextZ = 100
let seq = 0
/** Windows with a close prompt already on screen. */
const closing = new Set<WindowId>()
const uid = (prefix: string) => `${prefix}-${++seq}-${Date.now().toString(36)}`

export interface OpenOptions {
  appId: string
  title?: string
  rect?: Partial<Rect>
  minW?: number
  minH?: number
  args?: Record<string, string>
  /** If set, focus the existing window with this appId instead of opening a second. */
  singleton?: boolean
}

interface DesktopStore {
  windows: Record<WindowId, BWindowState>
  order: WindowId[]
  activeId: WindowId | null
  alerts: AlertState[]
  savePanels: SavePanelState[]
  keyPrompts: KeyPromptState[]

  openWindow: (opts: OpenOptions) => WindowId
  /** Ask the window's close guard first; use this for anything user-initiated. */
  requestClose: (id: WindowId) => Promise<void>
  /** Close immediately, skipping any guard. */
  closeWindow: (id: WindowId) => void
  focusWindow: (id: WindowId) => void
  commitRect: (id: WindowId, rect: Rect) => void
  setTitle: (id: WindowId, title: string) => void
  toggleZoom: (id: WindowId, viewport: { w: number; h: number }) => void
  minimizeWindow: (id: WindowId, minimized?: boolean) => void

  showAlert: (
    kind: AlertKind,
    title: string,
    text: string,
    buttons?: string[],
    defaultButton?: number,
  ) => Promise<number>
  dismissAlert: (id: string, index: number) => void

  /** Open a save panel; resolves with the chosen path, or null on cancel. */
  showSavePanel: (title: string, directory: string, name: string) => Promise<string | null>
  /** Open an open panel; resolves with an existing file's path, or null on cancel. */
  showOpenPanel: (title: string, directory: string) => Promise<string | null>
  dismissSavePanel: (id: string, path: string | null) => void

  /** Ask for an API key; resolves with the key, or null on cancel. */
  showKeyPrompt: (current: string) => Promise<string | null>
  dismissKeyPrompt: (id: string, key: string | null) => void
}

/** Cascade new windows so they never land exactly on top of each other. */
function cascade(count: number): { x: number; y: number } {
  const step = 24
  const wrap = 8
  const i = count % wrap
  return { x: 48 + i * step, y: 40 + i * step }
}

export const useDesktop = create<DesktopStore>((set, get) => ({
  windows: {},
  order: [],
  activeId: null,
  alerts: [],
  savePanels: [],
  keyPrompts: [],

  openWindow: (opts) => {
    if (opts.singleton) {
      const existing = Object.values(get().windows).find((w) => w.appId === opts.appId)
      if (existing) {
        get().focusWindow(existing.id)
        get().minimizeWindow(existing.id, false)
        return existing.id
      }
    }

    const id = uid('win')
    const pos = cascade(get().order.length)
    const rect: Rect = {
      x: opts.rect?.x ?? pos.x,
      y: opts.rect?.y ?? pos.y,
      w: opts.rect?.w ?? 480,
      h: opts.rect?.h ?? 320,
    }

    const win: BWindowState = {
      id,
      appId: opts.appId,
      title: opts.title ?? opts.appId,
      rect,
      minW: opts.minW ?? 220,
      minH: opts.minH ?? 120,
      z: ++nextZ,
      minimized: false,
      zoomed: false,
      args: opts.args,
    }

    set((s) => ({
      windows: { ...s.windows, [id]: win },
      order: [...s.order, id],
      activeId: id,
    }))
    return id
  },

  requestClose: async (id) => {
    const guard = getCloseGuard(id)
    if (!guard) {
      get().closeWindow(id)
      return
    }
    // A guard usually opens an alert. Without this a second Alt+W while the
    // alert is up would stack a duplicate prompt on the same window.
    if (closing.has(id)) return
    closing.add(id)
    try {
      if (await guard()) get().closeWindow(id)
    } finally {
      closing.delete(id)
    }
  },

  closeWindow: (id) =>
    set((s) => {
      if (!s.windows[id]) return s
      const windows = { ...s.windows }
      delete windows[id]
      const order = s.order.filter((w) => w !== id)
      // Focus falls to the front-most survivor, matching R5.
      const activeId =
        s.activeId === id
          ? (order
              .map((w) => windows[w])
              .filter((w) => w && !w.minimized)
              .sort((a, b) => a.z - b.z)
              .pop()?.id ?? null)
          : s.activeId
      return { windows, order, activeId }
    }),

  focusWindow: (id) =>
    set((s) => {
      const win = s.windows[id]
      if (!win) return s
      if (s.activeId === id && win.z === nextZ) return s
      return {
        activeId: id,
        windows: { ...s.windows, [id]: { ...win, z: ++nextZ } },
      }
    }),

  commitRect: (id, rect) =>
    set((s) => {
      const win = s.windows[id]
      if (!win) return s
      const r = win.rect
      if (r.x === rect.x && r.y === rect.y && r.w === rect.w && r.h === rect.h) return s
      return { windows: { ...s.windows, [id]: { ...win, rect, zoomed: false } } }
    }),

  setTitle: (id, title) =>
    set((s) => {
      const win = s.windows[id]
      if (!win || win.title === title) return s
      return { windows: { ...s.windows, [id]: { ...win, title } } }
    }),

  toggleZoom: (id, viewport) =>
    set((s) => {
      const win = s.windows[id]
      if (!win) return s
      if (win.zoomed && win.restore) {
        return {
          windows: { ...s.windows, [id]: { ...win, rect: win.restore, zoomed: false } },
        }
      }
      // R5's zoom grows to the "ideal" size clamped to the screen, not a true
      // maximise -- it deliberately leaves the Deskbar visible.
      const zoomRect: Rect = {
        x: 0,
        y: 0,
        w: Math.max(win.minW, viewport.w - 100),
        h: Math.max(win.minH, viewport.h - 8),
      }
      return {
        windows: {
          ...s.windows,
          [id]: { ...win, restore: win.rect, rect: zoomRect, zoomed: true },
        },
      }
    }),

  minimizeWindow: (id, minimized) =>
    set((s) => {
      const win = s.windows[id]
      if (!win) return s
      const next = minimized ?? !win.minimized
      if (next === win.minimized) return s
      return { windows: { ...s.windows, [id]: { ...win, minimized: next } } }
    }),

  showAlert: (kind, title, text, buttons = ['OK'], defaultButton = 0) =>
    new Promise<number>((resolve) => {
      const id = uid('alert')
      set((s) => ({
        alerts: [...s.alerts, { id, kind, title, text, buttons, defaultButton, resolve }],
      }))
    }),

  dismissAlert: (id, index) => {
    const alert = get().alerts.find((a) => a.id === id)
    set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }))
    alert?.resolve(index)
  },

  showSavePanel: (title, directory, name) =>
    new Promise<string | null>((resolve) => {
      const id = uid('save')
      set((s) => ({
        savePanels: [...s.savePanels, { id, mode: 'save', title, directory, name, resolve }],
      }))
    }),

  // Shares the queue -- and the panel -- with save. Only the confirm rule and
  // the button labels differ, and a file browser is a file browser.
  showOpenPanel: (title, directory) =>
    new Promise<string | null>((resolve) => {
      const id = uid('open')
      set((s) => ({
        savePanels: [...s.savePanels, { id, mode: 'open', title, directory, name: '', resolve }],
      }))
    }),

  dismissSavePanel: (id, path) => {
    const panel = get().savePanels.find((p) => p.id === id)
    set((s) => ({ savePanels: s.savePanels.filter((p) => p.id !== id) }))
    panel?.resolve(path)
  },

  showKeyPrompt: (current) =>
    new Promise<string | null>((resolve) => {
      const id = uid('key')
      set((s) => ({ keyPrompts: [...s.keyPrompts, { id, current, resolve }] }))
    }),

  dismissKeyPrompt: (id, key) => {
    const prompt = get().keyPrompts.find((p) => p.id === id)
    set((s) => ({ keyPrompts: s.keyPrompts.filter((p) => p.id !== id) }))
    prompt?.resolve(key)
  },
}))

/* ---------------------------------------------------------------- selectors
   Kept as module-level functions so their identity is stable and Zustand can
   skip re-renders reliably. */

export const selectWindow = (id: WindowId) => (s: DesktopStore) => s.windows[id]
export const selectOrder = (s: DesktopStore) => s.order
export const selectActiveId = (s: DesktopStore) => s.activeId
export const selectAlerts = (s: DesktopStore) => s.alerts
export const selectSavePanels = (s: DesktopStore) => s.savePanels
export const selectKeyPrompts = (s: DesktopStore) => s.keyPrompts

/** Imperative handles for code outside React (menus, app internals). */
export const desktop = {
  open: (opts: OpenOptions) => useDesktop.getState().openWindow(opts),
  requestClose: (id: WindowId) => useDesktop.getState().requestClose(id),
  close: (id: WindowId) => useDesktop.getState().closeWindow(id),
  alert: (kind: AlertKind, title: string, text: string, buttons?: string[]) =>
    useDesktop.getState().showAlert(kind, title, text, buttons),
}
