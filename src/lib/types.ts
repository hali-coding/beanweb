export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type WindowId = string

export interface BWindowState {
  id: WindowId
  appId: string
  title: string
  /** Live geometry. During a drag the DOM leads and this trails by one commit. */
  rect: Rect
  minW: number
  minH: number
  /** Stacking order. Higher is nearer the front. */
  z: number
  minimized: boolean
  zoomed: boolean
  /** Geometry to restore when un-zooming. */
  restore?: Rect
  /** Per-instance launch arguments, e.g. the path a Tracker window opened on. */
  args?: Record<string, string>
}

export type AlertKind = 'info' | 'warn' | 'stop'

export interface AlertState {
  id: string
  kind: AlertKind
  title: string
  text: string
  buttons: string[]
  /** Index of the button that is the default action. */
  defaultButton: number
  resolve: (index: number) => void
}

/** Save names a file that need not exist yet; open picks one that does. */
export type FilePanelMode = 'save' | 'open'

export interface SavePanelState {
  id: string
  mode: FilePanelMode
  title: string
  /** Directory the panel is browsing. */
  directory: string
  /** Pre-filled file name. Empty in open mode until a row is picked. */
  name: string
  /** Resolves with the chosen path, or null if the user cancelled. */
  resolve: (path: string | null) => void
}

export interface KeyPromptState {
  id: string
  /** Current key, so the panel can show it is already set. */
  current: string
  /** Resolves with the new key, or null if the user cancelled. */
  resolve: (key: string | null) => void
}

/** Shut Down parks the desktop; Restart quits everything and boots again. */
export type ShutdownMode = 'shutdown' | 'restart'

export interface ShutdownState {
  mode: ShutdownMode
  /** 'quitting' walks the open windows; 'down' is the final parked screen. */
  phase: 'quitting' | 'down'
  /** Title of the window currently being asked to quit, for the status line. */
  quitting: string | null
}
