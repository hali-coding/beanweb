/**
 * Draw's document model.
 *
 * Pure data, no DOM -- the same division as `lib/beanchallenge/engine.ts` and
 * `lib/basic/screen.ts`, and for the same reason: it is what lets the geometry
 * and the file format be tested under jsdom, where there is no layout engine,
 * no `getBBox` and no `getScreenCTM`.
 *
 * Rect and ellipse are deliberately *not* paths. A rectangle has to save as
 * `<rect>` -- that is what makes the file readable to anything else, and it
 * keeps a resize four numbers rather than eight nodes. The cost is that the
 * node tool cannot touch one, and the answer is CorelDRAW's own: Convert to
 * curves (`toPath`) turns it into a `PathShape` first.
 */

export interface Point {
  x: number
  y: number
}

/**
 * One point on a path, with its two bezier control points.
 *
 * `in` and `out` are offsets *from the anchor*, not absolute positions, so
 * dragging a node carries its handles along without touching them. A corner
 * node is simply one whose offsets are both zero.
 */
export interface PathNode {
  p: Point
  in: Point
  out: Point
  /** Keep `in` and `out` opposite and equal in length while either is dragged. */
  smooth: boolean
}

export interface GradientStop {
  /** 0 at the start of the ramp, 1 at the end. */
  offset: number
  color: string
}

/**
 * A gradient is always relative to the shape's own bounding box
 * (`objectBoundingBox`), never to the page. That is the whole reason it is
 * modelled at all: a box-relative gradient follows its shape through every
 * move, resize and rotate with no work, so none of `geom.ts` has to know
 * gradients exist.
 */
export interface LinearGradient {
  kind: 'linear'
  /** Degrees clockwise. 0 runs left to right, 90 runs top to bottom. */
  angle: number
  stops: GradientStop[]
}

export interface RadialGradient {
  kind: 'radial'
  stops: GradientStop[]
}

export type Gradient = LinearGradient | RadialGradient

/**
 * A colour, a gradient, or nothing.
 *
 * A plain string covers both `#rrggbb` and a `url(#id)` that came in with a
 * file and refers to something Draw chose not to model -- see `parseSVG`,
 * which only adopts a gradient it could write back out identically.
 */
export type Fill = string | Gradient | null

export const isGradient = (f: Fill): f is Gradient =>
  typeof f === 'object' && f !== null

export interface Style {
  /** null is a genuine "no fill", which is not the same as white. */
  fill: Fill
  /** Colour only. A gradient stroke is not offered. */
  stroke: string | null
  strokeWidth: number
}

interface Base {
  id: string
  style: Style
  /**
   * Degrees clockwise about the shape's own bounding-box centre.
   *
   * The one piece of geometry that is not baked into the coordinates. It has
   * to stay a field because baking a rotation into a `<rect>` would force it
   * to become a path, which is exactly what the model is avoiding.
   */
  rotation: number
}

export interface RectShape extends Base {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  /** Corner radius. 0 for a plain rectangle. */
  rx: number
}

export interface EllipseShape extends Base {
  kind: 'ellipse'
  cx: number
  cy: number
  rx: number
  ry: number
}

export interface PathShape extends Base {
  kind: 'path'
  nodes: PathNode[]
  closed: boolean
}

export interface TextShape extends Base {
  kind: 'text'
  /** The text baseline's start, as SVG means it. */
  x: number
  y: number
  text: string
  fontSize: number
  fontFamily: string
}

/**
 * Something Draw can draw but not edit: `<image>`, `<use>`, a `<g>` carrying a
 * clip path. Held as the markup it arrived as and written back out untouched,
 * in its original place in the paint order.
 *
 * This is the whole reason opening a foreign file is safe. Dropping what we do
 * not understand would mean the first save quietly deletes half of somebody's
 * drawing, which is the worst thing this app could do to them.
 */
export interface ForeignShape {
  kind: 'foreign'
  id: string
  markup: string
}

export type Shape = RectShape | EllipseShape | PathShape | TextShape | ForeignShape
export type ShapeKind = Shape['kind']

/** Everything except `foreign` -- the shapes with geometry to edit. */
export type EditableShape = RectShape | EllipseShape | PathShape | TextShape

export const isEditable = (s: Shape): s is EditableShape => s.kind !== 'foreign'

export interface DrawDoc {
  /** The page, in document units. Also the SVG's width/height and viewBox. */
  width: number
  height: number
  /** Painter's order: last is front-most, which is SVG's own rule. */
  shapes: Shape[]
  /**
   * `<defs>`, `<style>`, `<title>`, `<desc>` and comments, verbatim and first,
   * so a `url(#gradient)` fill that came in with the file still resolves.
   */
  preamble: string[]
  /**
   * Plain-English notes about anything the parser could only approximate.
   * Empty for a document Draw made itself; what the save warning is built on.
   */
  lossy: string[]
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export const DEFAULT_STYLE: Style = { fill: '#ffc900', stroke: '#000000', strokeWidth: 1 }

/**
 * The default page. Chosen so it fits inside Draw's own default window at
 * 100% -- a drawing clipped by its own scrollbars the moment you open it
 * looks broken, whatever the arithmetic says.
 */
export const PAGE_W = 512
export const PAGE_H = 384

export function emptyDoc(width = PAGE_W, height = PAGE_H): DrawDoc {
  return { width, height, shapes: [], preamble: [], lossy: [] }
}

let seq = 0
/** Ids only have to be unique within a document; they are not persisted state. */
export function shapeId(prefix = 's'): string {
  return `${prefix}${++seq}`
}
