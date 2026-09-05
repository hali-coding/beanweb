/**
 * Draw's file format: real SVG, in and out.
 *
 * `toSVG` is a hand-rolled string emitter rather than `XMLSerializer`, for the
 * same reason `formatLevel` in `lib/beanchallenge/level.ts` is hand-written:
 * the element and attribute order has to be deterministic, or `parseSVG` is
 * not its exact inverse and a drawing degrades a little on every save.
 *
 * `parseSVG` reads the subset the emitter writes plus the obvious neighbours a
 * real file uses, and returns everything it could *not* represent in
 * `dropped`. The app raises an alert from that list, because silently throwing
 * away half of somebody's file on the next save is the worst thing this app
 * could do.
 */

import type { DrawDoc, Fill, Gradient, GradientStop, PathNode, PathShape, Point, Shape, Style } from './types'
import { isGradient, PAGE_H, PAGE_W, shapeId } from './types'
import { centreOf, toPath } from './geom'

const SVG_NS = 'http://www.w3.org/2000/svg'

// ---------------------------------------------------------------- emitting

/** Three decimals, no trailing zeros, and never the string "-0". */
function num(v: number): string {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;')
}

/**
 * Six decimals, for gradient vectors only.
 *
 * A gradient's direction is stored as one angle and rebuilt from its two
 * endpoints on the way back in. At three decimals that round trip drifts --
 * 37 degrees returns as 37.02 -- and the exact-inverse contract dies. Six is
 * enough that every whole-degree angle comes back exactly.
 */
function num6(v: number): string {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? '0' : String(r)
}

/** What a shape's `fill` attribute says: a colour, `none`, or `url(#id)`. */
export function fillRef(fill: Fill, gradId?: string): string {
  if (fill === null) return 'none'
  if (typeof fill === 'string') return fill
  return gradId ? `url(#${gradId})` : 'none'
}

/**
 * Which gradient element each shape's fill points at.
 *
 * Numbered by position among the gradient-filled shapes rather than derived
 * from the shape's id, because shape ids are regenerated on every parse and
 * `toSVG(parseSVG(s)) === s` has to hold.
 */
export function gradientIds(doc: DrawDoc): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  for (const shape of doc.shapes) {
    if (shape.kind !== 'foreign' && isGradient(shape.style.fill)) out[shape.id] = `bw-grad-${n++}`
  }
  return out
}

function stopsMarkup(stops: GradientStop[]): string {
  return stops.map((s) => `<stop offset="${num(s.offset)}" stop-color="${s.color}"/>`).join('')
}

export function gradientElement(id: string, g: Gradient): string {
  if (g.kind === 'radial') {
    return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stopsMarkup(g.stops)}</radialGradient>`
  }
  // Centred on the box and one unit long, so the ramp spans the shape whatever
  // its size. Only the direction and the projection along it matter to SVG.
  const rad = (g.angle * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  return (
    `<linearGradient id="${id}"` +
    ` x1="${num6(0.5 - dx / 2)}" y1="${num6(0.5 - dy / 2)}"` +
    ` x2="${num6(0.5 + dx / 2)}" y2="${num6(0.5 + dy / 2)}">` +
    `${stopsMarkup(g.stops)}</linearGradient>`
  )
}

/**
 * The `<defs>` the document's own gradients need, or ''.
 *
 * Shared by `toSVG` and the live SVG in `apps/Draw.tsx`, which renders this
 * string directly -- so the gradient on screen and the gradient in the file
 * cannot drift apart.
 */
export function gradientDefs(doc: DrawDoc): string {
  const ids = gradientIds(doc)
  const parts: string[] = []
  for (const shape of doc.shapes) {
    const id = ids[shape.id]
    if (id && shape.kind !== 'foreign' && isGradient(shape.style.fill)) {
      parts.push(gradientElement(id, shape.style.fill))
    }
  }
  return parts.length ? `<defs>${parts.join('')}</defs>` : ''
}

function styleAttrs(style: Style, fill: string): string {
  return (
    ` fill="${fill}"` +
    ` stroke="${style.stroke ?? 'none'}"` +
    ` stroke-width="${num(style.strokeWidth)}"`
  )
}

/** The one place rotation leaves the model, as `rotate(deg cx cy)`. */
function transformAttr(shape: Shape): string {
  if (shape.kind === 'foreign' || !shape.rotation) return ''
  const c = centreOf(shape)
  return ` transform="rotate(${num(shape.rotation)} ${num(c.x)} ${num(c.y)})"`
}

/**
 * A path's `d`. A segment whose two facing control offsets are both zero is a
 * line, so a polygon comes out as `M ... L ... Z` rather than as cubics.
 */
export function pathData(shape: PathShape): string {
  const n = shape.nodes
  if (!n.length) return ''
  const parts: string[] = [`M ${num(n[0].p.x)} ${num(n[0].p.y)}`]

  const segment = (a: PathNode, b: PathNode) => {
    const straight = !a.out.x && !a.out.y && !b.in.x && !b.in.y
    if (straight) return `L ${num(b.p.x)} ${num(b.p.y)}`
    return (
      `C ${num(a.p.x + a.out.x)} ${num(a.p.y + a.out.y)}` +
      ` ${num(b.p.x + b.in.x)} ${num(b.p.y + b.in.y)}` +
      ` ${num(b.p.x)} ${num(b.p.y)}`
    )
  }

  for (let i = 1; i < n.length; i++) parts.push(segment(n[i - 1], n[i]))

  if (shape.closed && n.length > 1) {
    const last = n[n.length - 1]
    const first = n[0]
    // Z alone closes with a straight line, so the closing curve only needs
    // spelling out when it actually bends.
    const straight = !last.out.x && !last.out.y && !first.in.x && !first.in.y
    if (!straight) parts.push(segment(last, first))
    parts.push('Z')
  }
  return parts.join(' ')
}

function shapeToElement(shape: Shape, gradId?: string): string {
  // Written back exactly as it arrived, which is the whole point of it.
  if (shape.kind === 'foreign') return shape.markup
  const t = transformAttr(shape)
  const s = styleAttrs(shape.style, fillRef(shape.style.fill, gradId))
  switch (shape.kind) {
    case 'rect':
      return (
        `<rect x="${num(shape.x)}" y="${num(shape.y)}"` +
        ` width="${num(shape.w)}" height="${num(shape.h)}"` +
        (shape.rx > 0 ? ` rx="${num(shape.rx)}"` : '') +
        t + s + '/>'
      )
    case 'ellipse':
      return `<ellipse cx="${num(shape.cx)}" cy="${num(shape.cy)}" rx="${num(shape.rx)}" ry="${num(shape.ry)}"${t}${s}/>`
    case 'path':
      return `<path d="${pathData(shape)}"${t}${s}/>`
    case 'text':
      return (
        `<text x="${num(shape.x)}" y="${num(shape.y)}"` +
        ` font-family="${escapeAttr(shape.fontFamily)}" font-size="${num(shape.fontSize)}"` +
        t + s + `>${escapeText(shape.text)}</text>`
      )
  }
}

export function toSVG(doc: DrawDoc): string {
  const ids = gradientIds(doc)
  // Definitions go first, ours then the file's own, so every `url(#id)` fill
  // below them resolves.
  const defs = gradientDefs(doc)
  const head = [...(defs ? [defs] : []), ...doc.preamble].map((p) => '  ' + p).join('\n')
  const body = doc.shapes.map((s) => '  ' + shapeToElement(s, ids[s.id])).join('\n')
  return (
    `<svg xmlns="${SVG_NS}" width="${num(doc.width)}" height="${num(doc.height)}"` +
    ` viewBox="0 0 ${num(doc.width)} ${num(doc.height)}">\n` +
    (head ? head + '\n' : '') +
    (body ? body + '\n' : '') +
    '</svg>\n'
  )
}

// ------------------------------------------------------------------ matrices

/** `x' = a x + c y + e`, `y' = b x + d y + f` -- SVG's own ordering. */
export type Mat = [number, number, number, number, number, number]

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

export function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

const isIdentity = (m: Mat) =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0

const applyPoint = (m: Mat, p: Point): Point => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
})

/** An offset carries no translation -- only the linear part applies. */
const applyVec = (m: Mat, p: Point): Point => ({
  x: m[0] * p.x + m[2] * p.y,
  y: m[1] * p.x + m[3] * p.y,
})

const NUMBER = String.raw`[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?`

export function parseTransform(text: string): Mat {
  let m: Mat = IDENTITY
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const args = (match[2].match(new RegExp(NUMBER, 'g')) ?? []).map(Number)
    m = matMul(m, transformToMatrix(match[1], args))
  }
  return m
}

function transformToMatrix(name: string, a: number[]): Mat {
  switch (name) {
    case 'matrix':
      return a.length >= 6 ? ([a[0], a[1], a[2], a[3], a[4], a[5]] as Mat) : IDENTITY
    case 'translate':
      return [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
    case 'scale': {
      const sx = a[0] ?? 1
      return [sx, 0, 0, a.length > 1 ? a[1] : sx, 0, 0]
    }
    case 'rotate': {
      const rad = ((a[0] ?? 0) * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const rot: Mat = [cos, sin, -sin, cos, 0, 0]
      if (a.length < 3) return rot
      return matMul(matMul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]])
    }
    case 'skewX':
      return [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]
    case 'skewY':
      return [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]
    default:
      return IDENTITY
  }
}

/**
 * A transform that is exactly one `rotate(deg cx cy)` -- which is all this
 * emitter ever writes. Recognising it is what keeps a rotated rect a rect
 * through a save/open cycle instead of decaying into a path.
 */
function soleRotate(text: string): { deg: number; cx: number; cy: number } | null {
  const m = /^\s*rotate\s*\(([^)]*)\)\s*$/.exec(text)
  if (!m) return null
  const a = (m[1].match(new RegExp(NUMBER, 'g')) ?? []).map(Number)
  if (a.length !== 3) return null
  return { deg: a[0], cx: a[1], cy: a[2] }
}

/**
 * Bake a matrix into a shape's coordinates.
 *
 * A translate-and-scale keeps the shape's kind, because an axis-aligned box
 * stays one. Anything with rotation or shear in it cannot, so the shape is
 * converted to curves first -- a path's nodes absorb any affine exactly.
 */
function applyMatrix(shape: Shape, m: Mat): Shape {
  if (isIdentity(m)) return shape
  const axisAligned = m[1] === 0 && m[2] === 0

  if (axisAligned) {
    switch (shape.kind) {
      case 'rect': {
        const a = applyPoint(m, { x: shape.x, y: shape.y })
        const b = applyPoint(m, { x: shape.x + shape.w, y: shape.y + shape.h })
        return {
          ...shape,
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w: Math.abs(b.x - a.x),
          h: Math.abs(b.y - a.y),
          rx: shape.rx * Math.abs(m[0]),
        }
      }
      case 'ellipse': {
        const c = applyPoint(m, { x: shape.cx, y: shape.cy })
        return { ...shape, cx: c.x, cy: c.y, rx: shape.rx * Math.abs(m[0]), ry: shape.ry * Math.abs(m[3]) }
      }
      case 'text': {
        const p = applyPoint(m, { x: shape.x, y: shape.y })
        return { ...shape, x: p.x, y: p.y, fontSize: Math.max(1, shape.fontSize * Math.abs(m[3])) }
      }
      case 'path':
        return transformPath(shape, m)
    }
  }

  if (shape.kind === 'text') {
    // No glyph outlines here, so a sheared or rotated text can only keep its
    // position and scale. Reported by the caller as a limitation.
    const p = applyPoint(m, { x: shape.x, y: shape.y })
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
    return { ...shape, x: p.x, y: p.y, fontSize: Math.max(1, shape.fontSize * scale) }
  }

  const path = toPath(shape)
  return path ? transformPath(path, m) : shape
}

function transformPath(shape: PathShape, m: Mat): PathShape {
  return {
    ...shape,
    nodes: shape.nodes.map((n) => ({
      ...n,
      p: applyPoint(m, n.p),
      in: applyVec(m, n.in),
      out: applyVec(m, n.out),
    })),
  }
}

// ------------------------------------------------------------------ parsing

/** `d` is scanned by hand: an arc's two flags may be written without separators. */
class ArgScanner {
  private i = 0
  private readonly s: string

  constructor(source: string) {
    this.s = source
  }

  private skip() {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++
  }

  get done(): boolean {
    this.skip()
    return this.i >= this.s.length
  }

  number(): number {
    this.skip()
    const m = new RegExp(`^${NUMBER}`).exec(this.s.slice(this.i))
    if (!m) {
      this.i = this.s.length
      return NaN
    }
    this.i += m[0].length
    return Number(m[0])
  }

  /** A flag is a single character, and "011" is three of them. */
  flag(): number {
    this.skip()
    const c = this.s[this.i]
    if (c === '0' || c === '1') {
      this.i++
      return Number(c)
    }
    return this.number() ? 1 : 0
  }
}

interface Builder {
  nodes: PathNode[]
  closed: boolean
}

/**
 * Turn a `d` string into one or more node lists. Each subpath becomes its own
 * shape -- the model has no notion of holes, and splitting is the honest way
 * to say so rather than dropping the extra rings.
 */
export function parsePathData(d: string): Builder[] {
  const out: Builder[] = []
  let cur: Builder | null = null
  let start: Point = { x: 0, y: 0 }
  let pos: Point = { x: 0, y: 0 }
  /** The previous cubic's second control point, for S; quadratic's, for T. */
  let lastCubic: Point | null = null
  let lastQuad: Point | null = null

  const push = (p: Point) => {
    const node: PathNode = { p: { ...p }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false }
    cur!.nodes.push(node)
    return node
  }
  const tip = () => cur!.nodes[cur!.nodes.length - 1]

  const begin = (p: Point) => {
    cur = { nodes: [], closed: false }
    out.push(cur)
    start = { ...p }
    push(p)
  }

  const segments = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) ?? []

  for (const seg of segments) {
    const cmd = seg[0]
    const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z'
    const scan = new ArgScanner(seg.slice(1))
    let first = true

    if (cmd === 'Z' || cmd === 'z') {
      // Read back off `out` rather than through `cur`: `cur` is only ever
      // assigned inside begin(), so the checker cannot see it become non-null.
      const open = out[out.length - 1]
      if (open) {
        open.closed = true
        // `... L x0 y0 Z` is the same ring as `... Z`; keeping the duplicate
        // anchor would show a stray node under the first one in the editor.
        const n = open.nodes
        if (n.length > 1) {
          const last = n[n.length - 1]
          if (Math.abs(last.p.x - n[0].p.x) < 1e-9 && Math.abs(last.p.y - n[0].p.y) < 1e-9) {
            n[0].in = { ...last.in }
            n.pop()
          }
        }
        pos = { ...start }
      }
      continue
    }

    while (!scan.done) {
      const px = pos.x
      const py = pos.y
      switch (cmd.toUpperCase()) {
        case 'M': {
          const x = scan.number() + (rel ? px : 0)
          const y = scan.number() + (rel ? py : 0)
          if (Number.isNaN(x) || Number.isNaN(y)) break
          pos = { x, y }
          // Only the first pair is a move; the rest are implicit lines.
          if (first) begin(pos)
          else if (cur) push(pos)
          lastCubic = lastQuad = null
          break
        }
        case 'L':
        case 'H':
        case 'V': {
          if (!cur) begin(pos)
          let x = px
          let y = py
          if (cmd.toUpperCase() === 'L') {
            x = scan.number() + (rel ? px : 0)
            y = scan.number() + (rel ? py : 0)
          } else if (cmd.toUpperCase() === 'H') {
            x = scan.number() + (rel ? px : 0)
          } else {
            y = scan.number() + (rel ? py : 0)
          }
          if (Number.isNaN(x) || Number.isNaN(y)) break
          pos = { x, y }
          push(pos)
          lastCubic = lastQuad = null
          break
        }
        case 'C':
        case 'S': {
          if (!cur) begin(pos)
          let c1: Point
          if (cmd.toUpperCase() === 'C') {
            c1 = { x: scan.number() + (rel ? px : 0), y: scan.number() + (rel ? py : 0) }
          } else {
            // S reflects the previous cubic's second control through the point.
            c1 = lastCubic ? { x: 2 * px - lastCubic.x, y: 2 * py - lastCubic.y } : { x: px, y: py }
          }
          const c2 = { x: scan.number() + (rel ? px : 0), y: scan.number() + (rel ? py : 0) }
          const p = { x: scan.number() + (rel ? px : 0), y: scan.number() + (rel ? py : 0) }
          if (Number.isNaN(p.x) || Number.isNaN(p.y)) break
          tip().out = { x: c1.x - px, y: c1.y - py }
          const node = push(p)
          node.in = { x: c2.x - p.x, y: c2.y - p.y }
          pos = p
          lastCubic = c2
          lastQuad = null
          break
        }
        case 'Q':
        case 'T': {
          if (!cur) begin(pos)
          let q: Point
          if (cmd.toUpperCase() === 'Q') {
            q = { x: scan.number() + (rel ? px : 0), y: scan.number() + (rel ? py : 0) }
          } else {
            q = lastQuad ? { x: 2 * px - lastQuad.x, y: 2 * py - lastQuad.y } : { x: px, y: py }
          }
          const p = { x: scan.number() + (rel ? px : 0), y: scan.number() + (rel ? py : 0) }
          if (Number.isNaN(p.x) || Number.isNaN(p.y)) break
          // Quadratics have no exact cubic-free home in the model, and every
          // quadratic *is* exactly one cubic, so raise the degree.
          tip().out = { x: ((q.x - px) * 2) / 3, y: ((q.y - py) * 2) / 3 }
          const node = push(p)
          node.in = { x: ((q.x - p.x) * 2) / 3, y: ((q.y - p.y) * 2) / 3 }
          pos = p
          lastQuad = q
          lastCubic = null
          break
        }
        case 'A': {
          if (!cur) begin(pos)
          const rx = scan.number()
          const ry = scan.number()
          const rot = scan.number()
          const large = scan.flag()
          const sweep = scan.flag()
          const p = { x: scan.number() + (rel ? px : 0), y: scan.number() + (rel ? py : 0) }
          if (Number.isNaN(p.x) || Number.isNaN(p.y)) break
          // Arcs are converted rather than dropped: the model has no arc, but
          // dropping one silently is exactly what `dropped` exists to prevent.
          for (const c of arcToCubics({ x: px, y: py }, rx, ry, rot, large, sweep, p)) {
            tip().out = { x: c.c1.x - tip().p.x, y: c.c1.y - tip().p.y }
            const node = push(c.p)
            node.in = { x: c.c2.x - c.p.x, y: c.c2.y - c.p.y }
          }
          pos = p
          lastCubic = lastQuad = null
          break
        }
      }
      first = false
    }
  }

  return out.filter((b) => b.nodes.length > 0)
}

/** Endpoint-parameterised arc to a run of cubic segments. */
function arcToCubics(
  from: Point,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  large: number,
  sweep: number,
  to: Point,
): { c1: Point; c2: Point; p: Point }[] {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (!rx || !ry || (from.x === to.x && from.y === to.y)) {
    return [{ c1: { ...from }, c2: { ...to }, p: { ...to } }]
  }
  const phi = (rotDeg * Math.PI) / 180
  const cosP = Math.cos(phi)
  const sinP = Math.sin(phi)

  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  const x1 = cosP * dx + sinP * dy
  const y1 = -sinP * dx + cosP * dy

  // Radii too small to span the chord are scaled up, per the SVG spec.
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }

  const sign = large === sweep ? -1 : 1
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const coef = sign * Math.sqrt(denominator === 0 ? 0 : numerator / denominator)
  const cx1 = (coef * rx * y1) / ry
  const cy1 = (-coef * ry * x1) / rx

  const cx = cosP * cx1 - sinP * cy1 + (from.x + to.x) / 2
  const cy = sinP * cx1 + cosP * cy1 + (from.y + to.y) / 2

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    const a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)))
    return ux * vy - uy * vx < 0 ? -a : a
  }

  const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI

  // One cubic per quarter turn keeps the error well under a pixel.
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
  const step = delta / count
  const k = (4 / 3) * Math.tan(step / 4)

  const at = (t: number): Point => ({
    x: cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
    y: cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
  })
  const deriv = (t: number): Point => ({
    x: -rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP,
    y: -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP,
  })

  const segs: { c1: Point; c2: Point; p: Point }[] = []
  for (let i = 0; i < count; i++) {
    const t0 = theta1 + i * step
    const t1 = t0 + step
    const p0 = at(t0)
    const p1 = at(t1)
    const d0 = deriv(t0)
    const d1 = deriv(t1)
    segs.push({
      c1: { x: p0.x + k * d0.x, y: p0.y + k * d0.y },
      c2: { x: p1.x - k * d1.x, y: p1.y - k * d1.y },
      p: p1,
    })
  }
  // Land exactly on the requested endpoint rather than a rounding of it.
  if (segs.length) segs[segs.length - 1].p = { ...to }
  return segs
}

// -------------------------------------------------------------- colour

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  lime: '#00ff00', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff',
  aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080',
  grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000',
  navy: '#000080', purple: '#800080', teal: '#008080', orange: '#ffa500',
}

/**
 * Normalise to `#rrggbb` where we can, and **pass anything else through
 * untouched**. That last rule is what lets a gradient-filled shape survive:
 * `url(#grad1)` is not a colour we understand, its `<defs>` is sitting in the
 * preamble, and leaving both alone means the shape still paints and still
 * saves.
 */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim()
  if (!v || v === 'none' || v === 'transparent') return null
  const lower = v.toLowerCase()
  if (NAMED[lower]) return NAMED[lower]
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  if (/^#[0-9a-f]{6}$/i.test(v)) return lower
  const rgb = /^rgba?\(([^)]*)\)$/i.exec(v)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      const hex = parts
        .slice(0, 3)
        .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
        .join('')
      return `#${hex}`
    }
  }
  return v
}

// -------------------------------------------------------------- parsing

export class SvgError extends Error {}

/** SVG's own initial values, which a file is entitled to rely on. */
const ROOT_STYLE: Style = { fill: '#000000', stroke: null, strokeWidth: 1 }

/** Kept verbatim in the preamble rather than modelled. */
const PREAMBLE_TAGS = new Set(['defs', 'style', 'title', 'desc', 'metadata'])

/** A `<g>` carrying one of these cannot have its transform pushed down. */
const OPAQUE_GROUP_ATTRS = ['clip-path', 'mask', 'filter', 'opacity']

/** Elements that execute or embed something; none of them draw. */
const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'base', 'meta', 'handler'])

/** Attributes that carry a URL, and so carry a scheme worth checking. */
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'poster', 'data'])

/** A URL with no scheme at all: a fragment (`#grad`) or a relative path. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/

/**
 * The only schemes a drawing needs. `data:` is allowed for the raster formats
 * an SVG legitimately embeds and refused for everything else -- notably
 * `data:image/svg+xml`, which is a document and can carry script of its own.
 */
const SAFE_SCHEME = /^(?:https?:|mailto:|data:image\/(?:png|jpeg|jpg|gif|webp)[;,])/

/**
 * Strip anything executable out of markup we are going to re-render.
 *
 * A foreign object is drawn by handing its markup to the DOM, so a `<script>`
 * or an `onload=` in a file the user opened would run on this page. The file
 * came off their own disk, but "probably theirs" is not a security model.
 *
 * This works on the parsed element rather than on its serialisation: a regex
 * over markup has to re-implement the parser to know where a tag ends or what
 * an attribute value is, and every such sanitiser is eventually wrong about
 * some case the browser reads differently. The DOM already did that parse, so
 * walk it, drop what executes, and serialise afterwards.
 */
function sanitize(el: Element): string {
  if (isExecutable(el)) return ''
  const clone = el.cloneNode(true) as Element
  scrub(clone)
  return clone.outerHTML
}

function isExecutable(el: Element): boolean {
  if (FORBIDDEN_TAGS.has(el.localName.toLowerCase())) return true
  // SMIL puts back what the attribute pass takes out: an <animate> or <set>
  // aimed at `onload` or `href` writes it at document time, not parse time.
  const target = el.getAttribute('attributeName')?.toLowerCase()
  return target !== undefined && target !== null && (target.startsWith('on') || target.endsWith('href'))
}

function scrub(el: Element): void {
  for (const child of Array.from(el.children)) {
    if (isExecutable(child)) child.remove()
    else scrub(child)
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (name.startsWith('on')) el.removeAttributeNode(attr)
    else if (URL_ATTRS.has(name) && !isSafeUrl(attr.value)) el.removeAttributeNode(attr)
  }
}

function isSafeUrl(value: string): boolean {
  // A parser ignores whitespace and control characters inside a scheme, so
  // `java\tscript:` and a leading newline both still run. Take them out before
  // looking at the scheme rather than trying to match around them.
  const url = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  return HAS_SCHEME.test(url) ? SAFE_SCHEME.test(url) : true
}

function readNumberAttr(el: Element, name: string, fallback = 0): number {
  const raw = el.getAttribute(name)
  if (raw === null) return fallback
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Presentation attributes first, then an inline `style=""` on top -- CSS wins
 * over attributes, which is the rule real files are written against.
 */
function readStyle(el: Element, inherited: Style, gradients: Map<string, Gradient> = new Map()): Style {
  const declared: Record<string, string> = {}
  for (const name of ['fill', 'stroke', 'stroke-width']) {
    const v = el.getAttribute(name)
    if (v !== null) declared[name] = v
  }
  const inline = el.getAttribute('style')
  if (inline) {
    for (const decl of inline.split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      declared[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim()
    }
  }
  const width = declared['stroke-width']
  return {
    fill: 'fill' in declared ? resolveFill(declared.fill, gradients) : inherited.fill,
    stroke: 'stroke' in declared ? normalizeColor(declared.stroke) : inherited.stroke,
    strokeWidth: width !== undefined && Number.isFinite(parseFloat(width)) ? parseFloat(width) : inherited.strokeWidth,
  }
}

/** `url(#id)` becomes a real gradient only if we adopted that one. */
function resolveFill(raw: string, gradients: Map<string, Gradient>): Fill {
  const ref = /^url\(\s*#([^)\s]+)\s*\)$/.exec(raw.trim())
  const found = ref ? gradients.get(ref[1]) : undefined
  // Not adopted: the string passes through untouched and its definition stays
  // in the preamble, so the shape still paints and still saves.
  return found ?? normalizeColor(raw)
}

// ------------------------------------------------------- reading gradients

/** "50%" and "0.5" are the same offset; so are "1" and "100%". */
function ratio(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  const v = raw.trim()
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return fallback
  return v.endsWith('%') ? n / 100 : n
}

function readStops(el: Element): GradientStop[] | null {
  const stops: GradientStop[] = []
  for (const stop of Array.from(el.children)) {
    if (stop.localName !== 'stop') return null
    const inline: Record<string, string> = {}
    for (const decl of (stop.getAttribute('style') ?? '').split(';')) {
      const i = decl.indexOf(':')
      if (i > 0) inline[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim()
    }
    // Partly transparent stops are not modelled, so a gradient using them is
    // left alone rather than silently flattened to opaque.
    const opacity = inline['stop-opacity'] ?? stop.getAttribute('stop-opacity')
    if (opacity !== null && opacity !== undefined && parseFloat(opacity) !== 1) return null
    const color = normalizeColor(inline['stop-color'] ?? stop.getAttribute('stop-color') ?? '#000000')
    if (!color || color.startsWith('url(')) return null
    stops.push({ offset: ratio(stop.getAttribute('offset'), 0), color })
  }
  return stops.length >= 2 ? stops : null
}

/**
 * Adopt a gradient into the model, or refuse it.
 *
 * Only a gradient this emitter could write back out identically is adopted:
 * box-relative, unit-length, centred on its own axis, two or more opaque
 * stops, and not inheriting from another gradient. Everything else keeps its
 * `url(#id)` fill and its definition in the preamble -- it still paints and
 * still saves, it just cannot be edited. Refusing is what keeps the round trip
 * exact instead of approximate.
 */
function readGradient(el: Element): Gradient | null {
  const units = el.getAttribute('gradientUnits')
  if (units && units !== 'objectBoundingBox') return null
  if (el.getAttribute('href') || el.getAttribute('xlink:href')) return null
  if (el.getAttribute('gradientTransform')) return null
  if (el.getAttribute('spreadMethod') && el.getAttribute('spreadMethod') !== 'pad') return null

  const stops = readStops(el)
  if (!stops) return null

  if (el.localName === 'radialGradient') {
    const cx = ratio(el.getAttribute('cx'), 0.5)
    const cy = ratio(el.getAttribute('cy'), 0.5)
    const r = ratio(el.getAttribute('r'), 0.5)
    if (el.getAttribute('fx') || el.getAttribute('fy')) return null
    if (Math.abs(cx - 0.5) > 1e-3 || Math.abs(cy - 0.5) > 1e-3 || Math.abs(r - 0.5) > 1e-3) return null
    return { kind: 'radial', stops }
  }

  if (el.localName !== 'linearGradient') return null
  const x1 = ratio(el.getAttribute('x1'), 0)
  const y1 = ratio(el.getAttribute('y1'), 0)
  const x2 = ratio(el.getAttribute('x2'), 1)
  const y2 = ratio(el.getAttribute('y2'), 0)
  const dx = x2 - x1
  const dy = y2 - y1
  if (Math.abs(Math.hypot(dx, dy) - 1) > 1e-3) return null
  // Only the direction and the midpoint's projection along it matter, so the
  // spec's default (0,0)->(1,0) is accepted as the same ramp as our own
  // (0,0.5)->(1,0.5) rather than refused for sitting off centre.
  const alongAxis = ((x1 + x2) / 2 - 0.5) * dx + ((y1 + y2) / 2 - 0.5) * dy
  if (Math.abs(alongAxis) > 1e-3) return null

  const deg = (Math.atan2(dy, dx) * 180) / Math.PI
  const angle = Math.round(((deg % 360) + 360) % 360 * 1000) / 1000
  return { kind: 'linear', angle, stops }
}

function pointsToNodes(raw: string): PathNode[] {
  const n = (raw.match(new RegExp(NUMBER, 'g')) ?? []).map(Number)
  const out: PathNode[] = []
  for (let i = 0; i + 1 < n.length; i += 2) {
    out.push({ p: { x: n[i], y: n[i + 1] }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false })
  }
  return out
}

/** The geometry of one leaf element, before any transform is considered. */
function elementToShapes(el: Element, style: Style): Shape[] | null {
  const base = { style, rotation: 0 }
  switch (el.localName) {
    case 'rect': {
      const w = readNumberAttr(el, 'width')
      const h = readNumberAttr(el, 'height')
      if (w <= 0 || h <= 0) return []
      const rx = el.hasAttribute('rx') ? readNumberAttr(el, 'rx') : readNumberAttr(el, 'ry')
      return [{ ...base, kind: 'rect', id: shapeId(), x: readNumberAttr(el, 'x'), y: readNumberAttr(el, 'y'), w, h, rx }]
    }
    case 'circle': {
      const r = readNumberAttr(el, 'r')
      if (r <= 0) return []
      return [{ ...base, kind: 'ellipse', id: shapeId(), cx: readNumberAttr(el, 'cx'), cy: readNumberAttr(el, 'cy'), rx: r, ry: r }]
    }
    case 'ellipse': {
      const rx = readNumberAttr(el, 'rx')
      const ry = readNumberAttr(el, 'ry')
      if (rx <= 0 || ry <= 0) return []
      return [{ ...base, kind: 'ellipse', id: shapeId(), cx: readNumberAttr(el, 'cx'), cy: readNumberAttr(el, 'cy'), rx, ry }]
    }
    case 'line':
      return [{
        ...base, kind: 'path', id: shapeId(), closed: false,
        nodes: pointsToNodes(
          `${readNumberAttr(el, 'x1')} ${readNumberAttr(el, 'y1')} ${readNumberAttr(el, 'x2')} ${readNumberAttr(el, 'y2')}`,
        ),
      }]
    case 'polyline':
    case 'polygon': {
      const nodes = pointsToNodes(el.getAttribute('points') ?? '')
      if (nodes.length < 2) return []
      return [{ ...base, kind: 'path', id: shapeId(), nodes, closed: el.localName === 'polygon' }]
    }
    case 'path': {
      const subs = parsePathData(el.getAttribute('d') ?? '')
      // A `d` with several subpaths becomes several shapes: the model has no
      // notion of a hole, and splitting says so rather than dropping the rings.
      return subs.map((sub) => ({ ...base, kind: 'path' as const, id: shapeId(), nodes: sub.nodes, closed: sub.closed }))
    }
    case 'text': {
      // A <text> with <tspan> children positions each run separately; there is
      // no model for that, so it stays foreign rather than being flattened.
      if (el.children.length) return null
      const text = el.textContent ?? ''
      if (!text.trim()) return []
      return [{
        ...base, kind: 'text', id: shapeId(),
        x: readNumberAttr(el, 'x'), y: readNumberAttr(el, 'y'), text,
        fontSize: readNumberAttr(el, 'font-size', 16),
        fontFamily: el.getAttribute('font-family') ?? 'sans-serif',
      }]
    }
    default:
      return null
  }
}

interface WalkState {
  shapes: Shape[]
  preamble: string[]
  lossy: Set<string>
  /** Gradients adopted into the model, by the id the file gave them. */
  gradients: Map<string, Gradient>
}

function walk(el: Element, style: Style, matrix: Mat, state: WalkState): void {
  for (const child of Array.from(el.children)) {
    const tag = child.localName

    if (PREAMBLE_TAGS.has(tag)) {
      if (tag === 'defs') {
        // An adopted gradient is re-emitted from the model, so keeping the
        // original here as well would duplicate it and grow the file on every
        // save. Everything else in the <defs> is kept exactly as it came.
        const kept = Array.from(child.children)
          .filter((d) => !state.gradients.has(d.getAttribute('id') ?? ''))
          .map((d) => sanitize(d))
          .filter((markup) => markup !== '')
        if (kept.length) state.preamble.push(`<defs>${kept.join('')}</defs>`)
        continue
      }
      // Only meaningful at the top; a <defs> nested in a group still resolves
      // from the root, so hoisting it is correct rather than merely convenient.
      const hoisted = sanitize(child)
      if (hoisted) state.preamble.push(hoisted)
      continue
    }

    const childStyle = readStyle(child, style, state.gradients)
    const own = parseTransform(child.getAttribute('transform') ?? '')

    if (tag === 'g') {
      const opaque = OPAQUE_GROUP_ATTRS.some((a) => child.hasAttribute(a))
      if (opaque) {
        state.shapes.push({ kind: 'foreign', id: shapeId('f'), markup: sanitize(child) })
        state.lossy.add(`a <g> with ${OPAQUE_GROUP_ATTRS.filter((a) => child.hasAttribute(a)).join('/')} is kept but not editable`)
        continue
      }
      // Flatten: an Inkscape file wraps everything in a layer <g>, and treating
      // that as one lump would make the whole drawing a single unselectable
      // blob. The group's transform and style push down into its children.
      walk(child, childStyle, matMul(matrix, own), state)
      state.lossy.add('groups were flattened; the drawing is one level deep')
      continue
    }

    const shapes = elementToShapes(child, childStyle)
    if (shapes === null) {
      // A <script> sanitises to nothing; keeping it would put an object in the
      // drawing that has no markup, no bounds and nothing to select.
      const markup = sanitize(child)
      if (markup) {
        state.shapes.push({ kind: 'foreign', id: shapeId('f'), markup })
        state.lossy.add(`<${tag}> is kept but not editable`)
      } else {
        state.lossy.add(`<${tag}> was dropped; it cannot be drawn`)
      }
      continue
    }

    const combined = matMul(matrix, own)
    const rot = isIdentity(matrix) ? soleRotate(child.getAttribute('transform') ?? '') : null

    for (const shape of shapes) {
      if (rot && shape.kind !== 'foreign') {
        const c = centreOf(shape)
        // Only a rotation about the shape's own centre is what this emitter
        // writes, and recognising it is what keeps a rotated rect a rect
        // through a save/open cycle instead of decaying into a path.
        if (Math.abs(c.x - rot.cx) < 0.01 && Math.abs(c.y - rot.cy) < 0.01) {
          state.shapes.push({ ...shape, rotation: rot.deg })
          continue
        }
      }
      const baked = applyMatrix(shape, combined)
      if (baked.kind === 'path' && shape.kind !== 'path') {
        state.lossy.add(`a rotated or skewed <${tag}> became a path`)
      }
      state.shapes.push(baked)
    }
  }
}

/**
 * Read an SVG file. Throws only on markup that is not well-formed XML or has
 * no `<svg>` root -- everything else parses, with whatever could not be
 * modelled surviving as a `foreign` shape or a preamble entry and noted in
 * `lossy`.
 */
export function parseSVG(text: string): DrawDoc {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (parsed.getElementsByTagName('parsererror').length) throw new SvgError('This is not a well-formed SVG file.')
  const root = parsed.documentElement
  if (!root || root.localName !== 'svg') throw new SvgError('This file has no <svg> element in it.')

  // width/height win; a file with only a viewBox gets its size from that.
  const viewBox = (root.getAttribute('viewBox')?.match(new RegExp(NUMBER, 'g')) ?? []).map(Number)
  const width = readNumberAttr(root, 'width', viewBox.length === 4 ? viewBox[2] : PAGE_W) || PAGE_W
  const height = readNumberAttr(root, 'height', viewBox.length === 4 ? viewBox[3] : PAGE_H) || PAGE_H

  // Gradients are collected before the walk, because a shape may refer to one
  // that is defined further down the file.
  const gradients = new Map<string, Gradient>()
  let refused = false
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    if (el.localName !== 'linearGradient' && el.localName !== 'radialGradient') continue
    const id = el.getAttribute('id')
    if (!id) continue
    const g = readGradient(el)
    if (g) gradients.set(id, g)
    else refused = true
  }

  const state: WalkState = { shapes: [], preamble: [], lossy: new Set(), gradients }
  if (refused) state.lossy.add('a gradient is kept and still paints, but cannot be edited')
  walk(root, readStyle(root, ROOT_STYLE, gradients), IDENTITY, state)

  return { width, height, shapes: state.shapes, preamble: state.preamble, lossy: [...state.lossy] }
}
