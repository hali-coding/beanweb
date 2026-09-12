/**
 * Every change to a document, as a pure `(doc, ...) => DrawDoc`.
 *
 * The same shape as `step(game, input) => Game` in `lib/beanchallenge/engine.ts`,
 * and for the same two reasons: it is trivially testable, and it makes undo a
 * stack of snapshots rather than twenty hand-written inverse commands. Objects
 * that did not change are shared by reference, so a snapshot costs one array.
 */

import type { DrawDoc, PathNode, PathShape, Point, Shape, Style } from './types'
import { isEditable, shapeId } from './types'
import { bounds, translate } from './geom'

export function addShape(doc: DrawDoc, shape: Shape): DrawDoc {
  return { ...doc, shapes: [...doc.shapes, shape] }
}

export function replaceShape(doc: DrawDoc, next: Shape): DrawDoc {
  return { ...doc, shapes: doc.shapes.map((s) => (s.id === next.id ? next : s)) }
}

export function removeShape(doc: DrawDoc, id: string): DrawDoc {
  return { ...doc, shapes: doc.shapes.filter((s) => s.id !== id) }
}

export function findShape(doc: DrawDoc, id: string | null): Shape | undefined {
  return id ? doc.shapes.find((s) => s.id === id) : undefined
}

/** Offset so the copy is visible rather than exactly on top of the original. */
export const DUPLICATE_OFFSET = 10

export function duplicateShape(doc: DrawDoc, id: string): { doc: DrawDoc; id: string | null } {
  const shape = findShape(doc, id)
  if (!shape || !isEditable(shape)) return { doc, id: null }
  const copy = { ...translate(shape, DUPLICATE_OFFSET, DUPLICATE_OFFSET), id: shapeId() }
  return { doc: addShape(doc, copy), id: copy.id }
}

export function setStyle(doc: DrawDoc, id: string, patch: Partial<Style>): DrawDoc {
  const shape = findShape(doc, id)
  if (!shape || !isEditable(shape)) return doc
  return replaceShape(doc, { ...shape, style: { ...shape.style, ...patch } })
}

// ------------------------------------------------------------------- z-order

/** Front is the *end* of the list, because SVG paints in document order. */
function moveTo(doc: DrawDoc, id: string, to: (i: number, n: number) => number): DrawDoc {
  const i = doc.shapes.findIndex((s) => s.id === id)
  if (i < 0) return doc
  const target = to(i, doc.shapes.length)
  if (target === i) return doc
  const shapes = [...doc.shapes]
  const [s] = shapes.splice(i, 1)
  shapes.splice(target, 0, s)
  return { ...doc, shapes }
}

export const toFront = (doc: DrawDoc, id: string) => moveTo(doc, id, (_, n) => n - 1)
export const toBack = (doc: DrawDoc, id: string) => moveTo(doc, id, () => 0)
export const raise = (doc: DrawDoc, id: string) => moveTo(doc, id, (i, n) => Math.min(n - 1, i + 1))
export const lower = (doc: DrawDoc, id: string) => moveTo(doc, id, (i) => Math.max(0, i - 1))

// -------------------------------------------------------------- node editing

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

export function moveNode(shape: PathShape, index: number, to: Point): PathShape {
  const nodes = shape.nodes.map((n, i) => (i === index ? { ...n, p: { ...to } } : n))
  return { ...shape, nodes }
}

/**
 * Drag one control handle. A smooth node keeps the other handle opposite --
 * direction mirrored, its own length untouched, which is what stops a smooth
 * node from snapping to a symmetric one the moment you touch it.
 */
export function moveHandle(shape: PathShape, index: number, which: 'in' | 'out', to: Point): PathShape {
  const nodes = shape.nodes.map((n, i) => {
    if (i !== index) return n
    const offset = { x: to.x - n.p.x, y: to.y - n.p.y }
    const next: PathNode = { ...n, [which]: offset } as PathNode
    if (!n.smooth) return next
    const other = which === 'in' ? 'out' : 'in'
    const len = Math.hypot(n[other].x, n[other].y)
    const mag = Math.hypot(offset.x, offset.y)
    if (mag < 1e-6) return next
    // Length is preserved, so only the tangent's direction is being edited.
    const scale = (len || mag) / mag
    return { ...next, [other]: { x: -offset.x * scale, y: -offset.y * scale } } as PathNode
  })
  return { ...shape, nodes }
}

/** How far a smoothed corner reaches toward each neighbour. */
const NEIGHBOUR_PULL = 1 / 3

/** The nodes either side of `index`, wrapping only if the path is closed. */
function neighbours(shape: PathShape, index: number): { prev?: PathNode; next?: PathNode } {
  const n = shape.nodes
  const prev = index > 0 ? n[index - 1] : shape.closed ? n[n.length - 1] : undefined
  const next = index < n.length - 1 ? n[index + 1] : shape.closed ? n[0] : undefined
  // A closed path of one or two nodes would otherwise call a node its own
  // neighbour and derive a zero-length tangent from itself.
  return { prev: prev === n[index] ? undefined : prev, next: next === n[index] ? undefined : next }
}

/**
 * Give a node with no handles at all a pair, aimed along the line from the
 * node before it to the node after -- the smoothing every drawing program
 * does. An endpoint of an open path has one neighbour and so gets the one
 * handle it actually uses.
 */
function smoothCorner(shape: PathShape, index: number): PathNode {
  const node = shape.nodes[index]
  const { prev, next } = neighbours(shape, index)
  const from = prev?.p ?? node.p
  const to = next?.p ?? node.p
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return { ...node, smooth: true }
  const ux = dx / len
  const uy = dy / len
  const back = prev ? Math.hypot(node.p.x - prev.p.x, node.p.y - prev.p.y) * NEIGHBOUR_PULL : 0
  const ahead = next ? Math.hypot(next.p.x - node.p.x, next.p.y - node.p.y) * NEIGHBOUR_PULL : 0
  // `back`/`ahead` are zero at an endpoint, and `-ux * 0` is -0 -- which is
  // falsy everywhere it is tested but would still be written into a saved
  // file as "-0". Keep the absent handle an honest zero.
  return {
    ...node,
    smooth: true,
    in: back ? { x: -ux * back, y: -uy * back } : { x: 0, y: 0 },
    out: ahead ? { x: ux * ahead, y: uy * ahead } : { x: 0, y: 0 },
  }
}

/**
 * Make a node smooth, or return it to a cusp.
 *
 * A node that already has handles simply has them aligned -- becoming smooth
 * has to actually align them, or the flag is a lie.
 *
 * A *corner* node has no handles at all, which is every node of a polygon, a
 * converted rectangle and anything the polyline tool drew. This used to set
 * the flag and stop: the path did not move, no grip appeared, and there was
 * no way anywhere in the app to turn a straight line into a curve -- the one
 * thing the node tool exists for. Such a node now takes its tangent from its
 * neighbours instead.
 */
export function setNodeSmooth(shape: PathShape, index: number, smooth: boolean): PathShape {
  const node = shape.nodes[index]
  if (!node) return shape
  if (!smooth) {
    if (!node.smooth) return shape
    return { ...shape, nodes: shape.nodes.map((n, i) => (i === index ? { ...n, smooth: false } : n)) }
  }

  const bare = !node.in.x && !node.in.y && !node.out.x && !node.out.y
  let next: PathNode
  if (bare) {
    next = smoothCorner(shape, index)
  } else {
    const dx = node.out.x - node.in.x
    const dy = node.out.y - node.in.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) {
      next = { ...node, smooth: true }
    } else {
      const inLen = Math.hypot(node.in.x, node.in.y) || len / 3
      const outLen = Math.hypot(node.out.x, node.out.y) || len / 3
      next = {
        ...node,
        smooth: true,
        in: { x: (-dx / len) * inLen, y: (-dy / len) * inLen },
        out: { x: (dx / len) * outLen, y: (dy / len) * outLen },
      }
    }
  }
  return { ...shape, nodes: shape.nodes.map((n, i) => (i === index ? next : n)) }
}

/**
 * Split the segment leaving node `index` at `t`, by de Casteljau -- so the
 * curve through the new node is exactly the curve that was there before. A
 * node insert that visibly moved the path would be useless.
 */
export function insertNode(shape: PathShape, index: number, t = 0.5): PathShape {
  const n = shape.nodes
  const nextIndex = index + 1 < n.length ? index + 1 : shape.closed ? 0 : -1
  if (nextIndex < 0) return shape

  const a = n[index]
  const b = n[nextIndex]
  const p0 = a.p
  const p1 = { x: a.p.x + a.out.x, y: a.p.y + a.out.y }
  const p2 = { x: b.p.x + b.in.x, y: b.p.y + b.in.y }
  const p3 = b.p

  const q0 = lerp(p0, p1, t)
  const q1 = lerp(p1, p2, t)
  const q2 = lerp(p2, p3, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  const mid = lerp(r0, r1, t)

  const straight = !a.out.x && !a.out.y && !b.in.x && !b.in.y
  const inserted: PathNode = straight
    ? { p: mid, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false }
    : {
        p: mid,
        in: { x: r0.x - mid.x, y: r0.y - mid.y },
        out: { x: r1.x - mid.x, y: r1.y - mid.y },
        smooth: true,
      }

  const nodes = n.map((node, i) => {
    if (straight) return node
    if (i === index) return { ...node, out: { x: q0.x - node.p.x, y: q0.y - node.p.y } }
    if (i === nextIndex) return { ...node, in: { x: q2.x - node.p.x, y: q2.y - node.p.y } }
    return node
  })
  nodes.splice(index + 1, 0, inserted)
  return { ...shape, nodes }
}

/** Removing a node below the minimum would leave a shape with no path at all. */
export function deleteNode(shape: PathShape, index: number): PathShape {
  const min = shape.closed ? 3 : 2
  if (shape.nodes.length <= min) return shape
  return { ...shape, nodes: shape.nodes.filter((_, i) => i !== index) }
}

/** The page grows to hold anything drawn outside it, so nothing is ever lost. */
export function fitPage(doc: DrawDoc): DrawDoc {
  let width = doc.width
  let height = doc.height
  for (const s of doc.shapes) {
    if (!isEditable(s)) continue
    const b = bounds(s)
    width = Math.max(width, Math.ceil(b.x + b.w))
    height = Math.max(height, Math.ceil(b.y + b.h))
  }
  return width === doc.width && height === doc.height ? doc : { ...doc, width, height }
}
