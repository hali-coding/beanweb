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

export interface SavePanelState {
  id: string
  title: string
  /** Directory the panel is browsing. */
  directory: string
  /** Pre-filled file name. */
  name: string
  /** Resolves with the chosen path, or null if the user cancelled. */
  resolve: (path: string | null) => void
}
