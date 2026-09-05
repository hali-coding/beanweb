/**
 * Geometry for Draw. Pure functions over `types.ts`, no DOM.
 *
 * Everything here is baked into coordinates rather than accumulated into a
 * matrix. A move changes `x`/`y`; a resize changes `w`/`h`. That keeps the SVG
 * output readable, keeps the parser from needing a matrix decomposer, and --
 * the reason that actually matters -- means the node editor is always looking
 * at the numbers it is about to change. `rotation` is the single exception,
 * for the reason given in types.ts.
 */

import type { Bounds, EllipseShape, PathNode, PathShape, Point, RectShape, Shape } from './types'
import { shapeId } from './types'

/**
 * `foreign` shapes appear in every one of these switches as a no-op. They have
 * markup and a place in the paint order and nothing else -- no geometry to
 * measure, move or scale -- so they are never selectable and every operation
 * hands them straight back.
 */
const NO_BOUNDS: Bounds = { x: 0, y: 0, w: 0, h: 0 }

/** Quarter-circle bezier constant: 4/3 * (sqrt(2) - 1). */
export const KAPPA = 0.5522847498307936

export const point = (x: number, y: number): Point => ({ x, y })

/** A corner node -- both control points collapsed onto the anchor. */
export const corner = (x: number, y: number): PathNode => ({
  p: { x, y },
  in: { x: 0, y: 0 },
  out: { x: 0, y: 0 },
  smooth: false,
})

export function rotatePoint(p: Point, centre: Point, deg: number): Point {
  if (!deg) return { ...p }
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - centre.x
  const dy = p.y - centre.y
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos }
}

/**
 * Text is measured arithmetically, never with `getBBox`.
 *
 * jsdom has no `getBBox` at all, so a measured version would take every text
 * case out of the suite and leave the selection handles untestable. 0.6 em is
 * about right for the sans face the desktop uses; the handles around a text
 * object are therefore a few pixels loose, which is the trade.
 */
const TEXT_ADVANCE = 0.6
const TEXT_ASCENT = 0.8

/** The bounding box in the shape's own unrotated frame. */
export function bounds(shape: Shape): Bounds {
  switch (shape.kind) {
    case 'foreign':
      return NO_BOUNDS
    case 'rect':
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
    case 'ellipse':
      return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, w: shape.rx * 2, h: shape.ry * 2 }
    case 'text': {
      const w = shape.text.length * shape.fontSize * TEXT_ADVANCE
      return {
        x: shape.x,
        y: shape.y - shape.fontSize * TEXT_ASCENT,
        w,
        h: shape.fontSize,
      }
    }
    case 'path': {
      if (!shape.nodes.length) return { x: 0, y: 0, w: 0, h: 0 }
      // The control hull, not the tight curve extrema. Every editor draws the
      // hull while you are editing, and it is what the node tool needs to keep
      // a dragged handle inside the selection.
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      const eat = (x: number, y: number) => {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
      for (const n of shape.nodes) {
        eat(n.p.x, n.p.y)
        eat(n.p.x + n.in.x, n.p.y + n.in.y)
        eat(n.p.x + n.out.x, n.p.y + n.out.y)
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }
  }
}

export function centreOf(shape: Shape): Point {
  const b = bounds(shape)
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/** The four corners of a shape's box after its own rotation is applied. */
export function corners(shape: Shape): Point[] {
  const b = bounds(shape)
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const raw = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ]
  const deg = shape.kind === 'foreign' ? 0 : shape.rotation
  return deg ? raw.map((p) => rotatePoint(p, c, deg)) : raw
}

/** Axis-aligned box that contains the shape *including* its rotation. */
export function worldBounds(shape: Shape): Bounds {
  const pts = corners(shape)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
}

export function unionBounds(list: Bounds[]): Bounds {
  if (!list.length) return { x: 0, y: 0, w: 0, h: 0 }
  const minX = Math.min(...list.map((b) => b.x))
  const minY = Math.min(...list.map((b) => b.y))
  const maxX = Math.max(...list.map((b) => b.x + b.w))
  const maxY = Math.max(...list.map((b) => b.y + b.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

export function translate(shape: Shape, dx: number, dy: number): Shape {
  if (!dx && !dy) return shape
  switch (shape.kind) {
    case 'foreign':
      return shape
    case 'rect':
      return { ...shape, x: shape.x + dx, y: shape.y + dy }
    case 'ellipse':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy }
    case 'text':
      return { ...shape, x: shape.x + dx, y: shape.y + dy }
    case 'path':
      return {
        ...shape,
        // Only the anchors move; the offsets are relative and stay put.
        nodes: shape.nodes.map((n) => ({ ...n, p: { x: n.p.x + dx, y: n.p.y + dy } })),
      }
  }
}

/**
 * Scale about `anchor` -- which for a handle drag is the corner or edge
 * *opposite* the one being dragged, so that corner stays exactly where it is.
 *
 * Negative factors are a flip and are kept: the caller normalises the box
 * afterwards if it wants a positive width.
 */
export function scaleShape(shape: Shape, anchor: Point, sx: number, sy: number): Shape {
  const sp = (p: Point): Point => ({
    x: anchor.x + (p.x - anchor.x) * sx,
    y: anchor.y + (p.y - anchor.y) * sy,
  })
  switch (shape.kind) {
    case 'foreign':
      return shape
    case 'rect': {
      const a = sp({ x: shape.x, y: shape.y })
      const b = sp({ x: shape.x + shape.w, y: shape.y + shape.h })
      return {
        ...shape,
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
        rx: shape.rx * Math.abs(sx),
      }
    }
    case 'ellipse': {
      const c = sp({ x: shape.cx, y: shape.cy })
      return { ...shape, cx: c.x, cy: c.y, rx: shape.rx * Math.abs(sx), ry: shape.ry * Math.abs(sy) }
    }
    case 'text': {
      const a = sp({ x: shape.x, y: shape.y })
      // A glyph cannot be stretched on one axis without a transform, so text
      // takes the vertical factor and stays proportional. CorelDRAW would
      // stretch it; doing that here would mean a matrix, and the whole model
      // is built on not having one.
      return { ...shape, x: a.x, y: a.y, fontSize: Math.max(1, shape.fontSize * Math.abs(sy)) }
    }
    case 'path':
      return {
        ...shape,
        nodes: shape.nodes.map((n) => ({
          ...n,
          p: sp(n.p),
          in: { x: n.in.x * sx, y: n.in.y * sy },
          out: { x: n.out.x * sx, y: n.out.y * sy },
        })),
      }
  }
}

/** Resize a shape so its unrotated box becomes exactly `next`. */
export function resizeTo(shape: Shape, next: Bounds): Shape {
  const b = bounds(shape)
  const sx = b.w === 0 ? 1 : next.w / b.w
  const sy = b.h === 0 ? 1 : next.h / b.h
  const scaled = scaleShape(shape, { x: b.x, y: b.y }, sx, sy)
  const after = bounds(scaled)
  return translate(scaled, next.x - after.x, next.y - after.y)
}

// ------------------------------------------------------------ convert to curves

/**
 * CorelDRAW's Ctrl+Q. A rect or an ellipse becomes an editable path so the
 * node tool has something to work on; text refuses, because there are no
 * glyph outlines here to convert to.
 */
export function toPath(shape: Shape): PathShape | null {
  switch (shape.kind) {
    case 'path':
      return shape
    case 'foreign':
    case 'text':
      return null
    case 'rect':
      return rectToPath(shape)
    case 'ellipse':
      return ellipseToPath(shape)
  }
}

function rectToPath(r: RectShape): PathShape {
  const { x, y, w, h } = r
  const rx = Math.min(r.rx, w / 2, h / 2)
  const base = { id: shapeId('p'), style: r.style, rotation: r.rotation, closed: true } as const

  if (rx <= 0) {
    return {
      ...base,
      kind: 'path',
      nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
    }
  }

  const k = rx * KAPPA
  // Eight nodes: two per corner, each with the one control point that bends
  // its own quarter-arc. The straight edges between them stay straight because
  // the facing offsets are zero.
  const nodes: PathNode[] = [
    { p: { x: x + rx, y }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false },
    { p: { x: x + w - rx, y }, in: { x: 0, y: 0 }, out: { x: k, y: 0 }, smooth: false },
    { p: { x: x + w, y: y + rx }, in: { x: 0, y: -k }, out: { x: 0, y: 0 }, smooth: false },
    { p: { x: x + w, y: y + h - rx }, in: { x: 0, y: 0 }, out: { x: 0, y: k }, smooth: false },
    { p: { x: x + w - rx, y: y + h }, in: { x: k, y: 0 }, out: { x: 0, y: 0 }, smooth: false },
    { p: { x: x + rx, y: y + h }, in: { x: 0, y: 0 }, out: { x: -k, y: 0 }, smooth: false },
    { p: { x, y: y + h - rx }, in: { x: 0, y: k }, out: { x: 0, y: 0 }, smooth: false },
    { p: { x, y: y + rx }, in: { x: 0, y: 0 }, out: { x: 0, y: -k }, smooth: false },
  ]
  // Closing back onto the first node needs that node's incoming handle.
  nodes[0].in = { x: -k, y: 0 }
  return { ...base, kind: 'path', nodes }
}

function ellipseToPath(e: EllipseShape): PathShape {
  const kx = e.rx * KAPPA
  const ky = e.ry * KAPPA
  const nodes: PathNode[] = [
    { p: { x: e.cx + e.rx, y: e.cy }, in: { x: 0, y: -ky }, out: { x: 0, y: ky }, smooth: true },
    { p: { x: e.cx, y: e.cy + e.ry }, in: { x: kx, y: 0 }, out: { x: -kx, y: 0 }, smooth: true },
    { p: { x: e.cx - e.rx, y: e.cy }, in: { x: 0, y: ky }, out: { x: 0, y: -ky }, smooth: true },
    { p: { x: e.cx, y: e.cy - e.ry }, in: { x: -kx, y: 0 }, out: { x: kx, y: 0 }, smooth: true },
  ]
  return { id: shapeId('p'), kind: 'path', style: e.style, rotation: e.rotation, nodes, closed: true }
}
