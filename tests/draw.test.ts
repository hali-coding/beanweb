import { describe, expect, it } from 'vitest'
import {
  bounds,
  centreOf,
  corners,
  deleteNode,
  duplicateShape,
  emptyDoc,
  insertNode,
  isGradient,
  KAPPA,
  lower,
  moveHandle,
  normalizeColor,
  parsePathData,
  parseSVG,
  pathData,
  raise,
  removeShape,
  resizeTo,
  rotatePoint,
  scaleShape,
  setNodeSmooth,
  setStyle,
  shapeId,
  SvgError,
  toBack,
  toFront,
  toPath,
  toSVG,
  translate,
} from '@/lib/draw'
import type { DrawDoc, EllipseShape, Gradient, PathShape, RectShape, Shape, TextShape } from '@/lib/draw'

const style = { fill: '#ffc900', stroke: '#000000', strokeWidth: 2 }

const rect = (over: Partial<RectShape> = {}): RectShape => ({
  kind: 'rect', id: shapeId(), style, rotation: 0, x: 10, y: 20, w: 100, h: 50, rx: 0, ...over,
})
const ellipse = (over: Partial<EllipseShape> = {}): EllipseShape => ({
  kind: 'ellipse', id: shapeId(), style, rotation: 0, cx: 200, cy: 150, rx: 60, ry: 40, ...over,
})
const text = (over: Partial<TextShape> = {}): TextShape => ({
  kind: 'text', id: shapeId(), style, rotation: 0, x: 30, y: 300, text: 'Bean', fontSize: 16,
  fontFamily: 'sans-serif', ...over,
})
const poly = (over: Partial<PathShape> = {}): PathShape => ({
  kind: 'path', id: shapeId(), style, rotation: 0, closed: true,
  nodes: [
    { p: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false },
    { p: { x: 40, y: 0 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false },
    { p: { x: 40, y: 30 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false },
  ],
  ...over,
})

const docOf = (...shapes: Shape[]): DrawDoc => ({ ...emptyDoc(), shapes })

/** Ids are per-session and not part of the file, so compare without them. */
const strip = (d: DrawDoc) => ({
  ...d,
  shapes: d.shapes.map((s) => ({ ...s, id: '' })),
})

describe('geometry', () => {
  it('measures each kind of shape', () => {
    expect(bounds(rect())).toEqual({ x: 10, y: 20, w: 100, h: 50 })
    expect(bounds(ellipse())).toEqual({ x: 140, y: 110, w: 120, h: 80 })
    // Path bounds are the control hull, which for a polygon is the anchors.
    expect(bounds(poly())).toEqual({ x: 0, y: 0, w: 40, h: 30 })
  })

  it('rotates a point about a centre', () => {
    const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(10)
  })

  it('rotates the corners of a shape about its own centre', () => {
    const r = rect({ x: 0, y: 0, w: 100, h: 100, rotation: 90 })
    const c = centreOf(r)
    expect(c).toEqual({ x: 50, y: 50 })
    // A square turned a quarter turn covers exactly the same ground.
    const pts = corners(r)
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-0.001)
      expect(p.x).toBeLessThanOrEqual(100.001)
    }
  })

  it('scales about an anchor and leaves that anchor where it was', () => {
    const r = rect({ x: 10, y: 20, w: 100, h: 50 })
    const anchor = { x: 10, y: 20 }
    const scaled = scaleShape(r, anchor, 2, 3) as RectShape
    expect(scaled.x).toBe(10)
    expect(scaled.y).toBe(20)
    expect(scaled.w).toBe(200)
    expect(scaled.h).toBe(150)
  })

  it('resizes a path to an exact box', () => {
    const out = resizeTo(poly(), { x: 100, y: 100, w: 80, h: 60 })
    expect(bounds(out)).toEqual({ x: 100, y: 100, w: 80, h: 60 })
  })

  it('translates a path by moving anchors, not handles', () => {
    const p = poly({
      nodes: [
        { p: { x: 0, y: 0 }, in: { x: -5, y: 0 }, out: { x: 5, y: 0 }, smooth: true },
        { p: { x: 40, y: 0 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false },
      ],
    })
    const moved = translate(p, 10, 10) as PathShape
    expect(moved.nodes[0].p).toEqual({ x: 10, y: 10 })
    expect(moved.nodes[0].out).toEqual({ x: 5, y: 0 })
  })
})

describe('convert to curves', () => {
  it('turns a plain rect into four corners covering the same box', () => {
    const p = toPath(rect())!
    expect(p.kind).toBe('path')
    expect(p.nodes).toHaveLength(4)
    expect(p.closed).toBe(true)
    expect(bounds(p)).toEqual(bounds(rect()))
  })

  it('turns a rounded rect into eight nodes', () => {
    const p = toPath(rect({ rx: 10 }))!
    expect(p.nodes).toHaveLength(8)
    expect(bounds(p)).toEqual({ x: 10, y: 20, w: 100, h: 50 })
  })

  it('turns an ellipse into four kappa-weighted nodes', () => {
    const e = ellipse()
    const p = toPath(e)!
    expect(p.nodes).toHaveLength(4)
    expect(p.nodes[0].out.y).toBeCloseTo(e.ry * KAPPA)
    expect(bounds(p)).toEqual(bounds(e))
  })

  it('refuses text, which has no outlines to convert', () => {
    expect(toPath(text())).toBeNull()
  })
})

describe('document operations', () => {
  it('reorders shapes, with the front at the end of the list', () => {
    const [a, b, c] = [rect(), ellipse(), poly()]
    const doc = docOf(a, b, c)
    expect(toFront(doc, a.id).shapes.map((s) => s.id)).toEqual([b.id, c.id, a.id])
    expect(toBack(doc, c.id).shapes.map((s) => s.id)).toEqual([c.id, a.id, b.id])
    expect(raise(doc, a.id).shapes.map((s) => s.id)).toEqual([b.id, a.id, c.id])
    expect(lower(doc, c.id).shapes.map((s) => s.id)).toEqual([a.id, c.id, b.id])
    // Already at the front, so nothing moves and the doc is handed straight back.
    expect(toFront(doc, c.id)).toBe(doc)
  })

  it('duplicates with a fresh id and a visible offset', () => {
    const r = rect()
    const { doc, id } = duplicateShape(docOf(r), r.id)
    expect(id).not.toBe(r.id)
    expect(doc.shapes).toHaveLength(2)
    expect(bounds(doc.shapes[1])).toEqual({ x: 20, y: 30, w: 100, h: 50 })
  })

  it('removes a shape and patches style', () => {
    const r = rect()
    expect(removeShape(docOf(r), r.id).shapes).toHaveLength(0)
    const styled = setStyle(docOf(r), r.id, { fill: '#ff0000' })
    expect((styled.shapes[0] as RectShape).style).toEqual({ ...style, fill: '#ff0000' })
  })
})

describe('node editing', () => {
  it('inserts a node without moving the curve', () => {
    const curve = poly({
      closed: false,
      nodes: [
        { p: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 30, y: 0 }, smooth: false },
        { p: { x: 100, y: 0 }, in: { x: -30, y: 40 }, out: { x: 0, y: 0 }, smooth: false },
      ],
    })
    const before = bounds(curve)
    const after = insertNode(curve, 0, 0.5)
    expect(after.nodes).toHaveLength(3)
    // De Casteljau splits the curve exactly, so the hull cannot grow.
    expect(after.nodes[1].p.x).toBeGreaterThan(0)
    expect(after.nodes[1].p.x).toBeLessThan(100)
    expect(bounds(after).w).toBeLessThanOrEqual(before.w + 0.001)
  })

  it('splits a straight segment into two straight segments', () => {
    const line = poly({ closed: false, nodes: poly().nodes.slice(0, 2) })
    const after = insertNode(line, 0, 0.5)
    expect(after.nodes[1].p).toEqual({ x: 20, y: 0 })
    expect(after.nodes[1].out).toEqual({ x: 0, y: 0 })
  })

  it('refuses to delete below a drawable minimum', () => {
    const tri = poly()
    expect(deleteNode(tri, 0)).toBe(tri)
    const quad = poly({ nodes: [...poly().nodes, { p: { x: 0, y: 30 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false }] })
    expect(deleteNode(quad, 0).nodes).toHaveLength(3)
  })

  it('mirrors the opposite handle on a smooth node, keeping its length', () => {
    const p = poly({
      nodes: [{ p: { x: 0, y: 0 }, in: { x: -10, y: 0 }, out: { x: 20, y: 0 }, smooth: true }],
    })
    const moved = moveHandle(p, 0, 'out', { x: 0, y: 30 })
    expect(moved.nodes[0].out).toEqual({ x: 0, y: 30 })
    expect(moved.nodes[0].in.x).toBeCloseTo(0)
    expect(moved.nodes[0].in.y).toBeCloseTo(-10)
  })

  it('aligns the handles when a node is made smooth', () => {
    const p = poly({
      nodes: [{ p: { x: 0, y: 0 }, in: { x: -10, y: 5 }, out: { x: 10, y: -20 }, smooth: false }],
    })
    const n = setNodeSmooth(p, 0, true).nodes[0]
    const cross = n.in.x * n.out.y - n.in.y * n.out.x
    expect(cross).toBeCloseTo(0)
    expect(Math.hypot(n.in.x, n.in.y)).toBeCloseTo(Math.hypot(-10, 5))
  })
})

describe('colour', () => {
  it('normalises the forms a file might use', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc')
    expect(normalizeColor('#FFC900')).toBe('#ffc900')
    expect(normalizeColor('rgb(255, 201, 0)')).toBe('#ffc900')
    expect(normalizeColor('red')).toBe('#ff0000')
    expect(normalizeColor('none')).toBeNull()
    expect(normalizeColor(null)).toBeNull()
  })

  it('passes through what it cannot resolve, so a gradient survives', () => {
    expect(normalizeColor('url(#grad1)')).toBe('url(#grad1)')
  })
})

describe('path data', () => {
  const roundTrip = (d: string) => {
    const subs = parsePathData(d)
    return subs.map((s) => pathData({ ...poly(), nodes: s.nodes, closed: s.closed })).join(' ')
  }

  it('is a fixed point over the forms it emits', () => {
    for (const d of [
      'M 0 0 L 40 0 L 40 30 Z',
      'M 0 0 C 10 0 30 0 40 0 Z',
      'M 10 10 L 90 10 L 90 90 L 10 90 Z',
    ]) {
      expect(roundTrip(d)).toBe(roundTrip(roundTrip(d)))
    }
  })

  it('reads relative commands, H and V', () => {
    const subs = parsePathData('m 10 10 h 20 v 20 z')
    expect(subs).toHaveLength(1)
    expect(subs[0].closed).toBe(true)
    expect(subs[0].nodes.map((n) => n.p)).toEqual([
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
    ])
  })

  it('treats extra pairs after a moveto as implicit linetos', () => {
    const subs = parsePathData('M0 0 10 0 10 10')
    expect(subs[0].nodes).toHaveLength(3)
  })

  it('reflects the control point for S', () => {
    const subs = parsePathData('M0 0 C 10 0 20 10 30 10 S 50 20 60 20')
    const n = subs[0].nodes
    expect(n).toHaveLength(3)
    // S mirrors the previous C's second control through the shared point.
    expect(n[1].out).toEqual({ x: 10, y: 0 })
  })

  it('raises a quadratic to the equivalent cubic', () => {
    const n = parsePathData('M0 0 Q 30 30 60 0')[0].nodes
    expect(n[0].out).toEqual({ x: 20, y: 20 })
    expect(n[1].in).toEqual({ x: -20, y: 20 })
  })

  it('reads arc flags written without separators', () => {
    // The classic SVG trap: "a1 1 0 011 1" is rx ry rot 0 1 1 1.
    const n = parsePathData('M10 10 a5 5 0 011 1')[0].nodes
    expect(n.length).toBeGreaterThan(1)
    const last = n[n.length - 1].p
    expect(last.x).toBeCloseTo(11)
    expect(last.y).toBeCloseTo(11)
  })

  it('converts an arc into cubics that land on the endpoint', () => {
    const n = parsePathData('M0 0 A 50 50 0 0 1 100 0')[0].nodes
    expect(n[n.length - 1].p.x).toBeCloseTo(100)
    expect(n[n.length - 1].p.y).toBeCloseTo(0)
  })

  it('splits several subpaths so no ring is dropped', () => {
    const subs = parsePathData('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z')
    expect(subs).toHaveLength(2)
    expect(subs.every((s) => s.closed)).toBe(true)
  })

  it('merges a closing anchor that repeats the first point', () => {
    const subs = parsePathData('M0 0 L10 0 L10 10 L0 0 Z')
    expect(subs[0].nodes).toHaveLength(3)
  })
})

describe('SVG round trip', () => {
  it('is an exact inverse for every editable kind', () => {
    const doc = docOf(rect({ rx: 6 }), ellipse(), poly(), text())
    const parsed = parseSVG(toSVG(doc))
    expect(strip(parsed)).toEqual(strip(doc))
  })

  it('is a fixed point on its own output', () => {
    const doc = docOf(rect({ rotation: 30 }), ellipse(), poly())
    const once = toSVG(doc)
    expect(toSVG(parseSVG(once))).toBe(once)
  })

  it('keeps a rotated rect a rect rather than decaying it into a path', () => {
    const doc = docOf(rect({ rotation: 45 }))
    const back = parseSVG(toSVG(doc)).shapes[0]
    expect(back.kind).toBe('rect')
    expect((back as RectShape).rotation).toBeCloseTo(45)
  })

  it('writes no fill as none and reads it back as null', () => {
    const doc = docOf(rect({ style: { fill: null, stroke: '#000000', strokeWidth: 1 } }))
    expect(toSVG(doc)).toContain('fill="none"')
    expect((parseSVG(toSVG(doc)).shapes[0] as RectShape).style.fill).toBeNull()
  })

  it('escapes text content rather than emitting broken markup', () => {
    const doc = docOf(text({ text: 'a < b & c' }))
    expect(toSVG(doc)).toContain('a &lt; b &amp; c')
    expect((parseSVG(toSVG(doc)).shapes[0] as TextShape).text).toBe('a < b & c')
  })

  it('emits a polygon as lines, not as degenerate cubics', () => {
    expect(toSVG(docOf(poly()))).toContain('d="M 0 0 L 40 0 L 40 30 Z"')
  })
})

describe('rounded corners', () => {
  it('emits rx only when there is a radius, and reads it back', () => {
    expect(toSVG(docOf(rect()))).not.toContain('rx=')
    const round = docOf(rect({ rx: 8 }))
    expect(toSVG(round)).toContain('rx="8"')
    expect((parseSVG(toSVG(round)).shapes[0] as RectShape).rx).toBe(8)
  })

  it('reads a radius given only as ry', () => {
    const doc = parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" ry="5"/></svg>')
    expect((doc.shapes[0] as RectShape).rx).toBe(5)
  })

  it('scales the radius with the shape', () => {
    const scaled = scaleShape(rect({ rx: 10 }), { x: 0, y: 0 }, 2, 2) as RectShape
    expect(scaled.rx).toBe(20)
  })

  it('clamps a radius larger than half the shape when converting to curves', () => {
    // rx 500 on a 100x50 rect is a stadium, not a malformed path.
    const p = toPath(rect({ rx: 500 }))!
    expect(p.nodes).toHaveLength(8)
    expect(bounds(p)).toEqual({ x: 10, y: 20, w: 100, h: 50 })
  })
})

describe('gradients', () => {
  const linear = (angle = 90): Gradient => ({
    kind: 'linear',
    angle,
    stops: [
      { offset: 0, color: '#ffc900' },
      { offset: 1, color: '#c04a2b' },
    ],
  })
  const radial: Gradient = {
    kind: 'radial',
    stops: [
      { offset: 0, color: '#ffffff' },
      { offset: 1, color: '#336698' },
    ],
  }

  it('emits a defs block and points the shape at it', () => {
    const out = toSVG(docOf(rect({ style: { ...style, fill: linear() } })))
    expect(out).toContain('<linearGradient id="bw-grad-0"')
    expect(out).toContain('fill="url(#bw-grad-0)"')
    // Definitions must come before the shape that refers to them.
    expect(out.indexOf('linearGradient')).toBeLessThan(out.indexOf('<rect'))
  })

  it('round-trips a linear and a radial gradient', () => {
    const doc = docOf(
      rect({ style: { ...style, fill: linear() } }),
      ellipse({ style: { ...style, fill: radial } }),
    )
    expect(strip(parseSVG(toSVG(doc)))).toEqual(strip(doc))
  })

  it('round-trips awkward angles exactly', () => {
    // Three decimals is not enough here: 37 degrees comes back as 37.02 and
    // the drawing drifts a little on every save. Hence num6 in the emitter.
    for (const angle of [0, 1, 37, 45, 90, 137, 180, 270, 359]) {
      const doc = docOf(rect({ style: { ...style, fill: linear(angle) } }))
      const back = parseSVG(toSVG(doc)).shapes[0] as RectShape
      expect((back.style.fill as { angle: number }).angle).toBe(angle)
    }
  })

  it('is a fixed point on its own output, and does not grow the file', () => {
    const doc = docOf(rect({ style: { ...style, fill: linear(30) } }), ellipse({ style: { ...style, fill: radial } }))
    const once = toSVG(doc)
    const twice = toSVG(parseSVG(once))
    expect(twice).toBe(once)
    // An adopted gradient must not also be kept in the preamble, or every
    // save would stack another copy of it.
    expect(parseSVG(once).preamble).toEqual([])
    expect(toSVG(parseSVG(twice))).toBe(once)
  })

  it('adopts the plain horizontal gradient a real file writes', () => {
    // The spec default is (0,0)->(1,0), which is the same ramp as our own
    // (0,0.5)->(1,0.5) and must not be refused for sitting off centre.
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<defs><linearGradient id="g"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></linearGradient></defs>' +
        '<rect width="10" height="10" fill="url(#g)"/></svg>',
    )
    const fill = (doc.shapes[0] as RectShape).style.fill as { kind: string; angle: number; stops: unknown[] }
    expect(fill.kind).toBe('linear')
    expect(fill.angle).toBe(0)
    expect(fill.stops).toEqual([
      { offset: 0, color: '#ffffff' },
      { offset: 1, color: '#000000' },
    ])
    expect(doc.preamble).toEqual([])
    expect(doc.lossy).toEqual([])
  })

  it('reads a gradient defined after the shape that uses it', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="10" height="10" fill="url(#g)"/>' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs></svg>',
    )
    expect(typeof (doc.shapes[0] as RectShape).style.fill).toBe('object')
  })

  for (const [what, markup] of [
    ['page-relative units', '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">'],
    ['a gradientTransform', '<linearGradient id="g" gradientTransform="rotate(20)">'],
    ['an off-centre radial focus', '<radialGradient id="g" fx="0.2" fy="0.3">'],
  ] as const) {
    it(`refuses a gradient with ${what}, keeping it whole`, () => {
      const doc = parseSVG(
        '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
          markup +
          '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>' +
          (markup.startsWith('<radial') ? '</radialGradient>' : '</linearGradient>') +
          '</defs><rect width="10" height="10" fill="url(#g)"/></svg>',
      )
      // Not modelled, so the fill stays a reference and the definition stays
      // in the preamble -- it still paints, and it still saves.
      expect((doc.shapes[0] as RectShape).style.fill).toBe('url(#g)')
      expect(doc.preamble.join()).toContain('id="g"')
      expect(doc.lossy.join()).toContain('cannot be edited')
      expect(toSVG(doc)).toContain('url(#g)')
    })
  }

  it('refuses a gradient with a transparent stop rather than flattening it', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g">' +
        '<stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#000"/>' +
        '</linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
    )
    expect((doc.shapes[0] as RectShape).style.fill).toBe('url(#g)')
  })

  it('keeps the rest of a defs block when it adopts one gradient out of it', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
        '<linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
        '<filter id="f"/></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
    )
    // Preserved markup comes back through outerHTML, which spells out the SVG
    // namespace it inherited. Harmless, and it settles after one pass -- the
    // fixed-point check below is what actually matters.
    expect(doc.preamble.join()).toContain('<filter')
    expect(doc.preamble.join()).toContain('id="f"')
    expect(doc.preamble.join()).not.toContain('linearGradient')
    expect(toSVG(doc)).toContain('id="f"')
  })

  it('settles after one pass even though preserved markup gains an xmlns', () => {
    const first = toSVG(
      parseSVG(
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="f"/></defs>' +
          '<rect width="10" height="10"/><image href="a.png" width="4" height="4"/></svg>',
      ),
    )
    expect(toSVG(parseSVG(first))).toBe(first)
  })

  it('numbers gradients by position, so two shapes get their own', () => {
    const doc = docOf(
      rect({ style: { ...style, fill: linear() } }),
      ellipse({ style: { ...style, fill: '#ff0000' } }),
      poly({ style: { ...style, fill: radial } }),
    )
    const out = toSVG(doc)
    expect(out).toContain('url(#bw-grad-0)')
    expect(out).toContain('url(#bw-grad-1)')
    expect(out).not.toContain('bw-grad-2')
  })

  it('keeps the gradient when a shape is converted to curves', () => {
    const converted = toPath(rect({ style: { ...style, fill: linear() } }))!
    expect(isGradient(converted.style.fill)).toBe(true)
  })
})

describe('reading a foreign file', () => {
  it('accepts circle, line, polyline and polygon', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<circle cx="50" cy="50" r="20"/>' +
        '<line x1="0" y1="0" x2="10" y2="10"/>' +
        '<polyline points="0,0 5,5 10,0"/>' +
        '<polygon points="0,0 5,5 10,0"/>' +
        '</svg>',
    )
    expect(doc.shapes.map((s) => s.kind)).toEqual(['ellipse', 'path', 'path', 'path'])
    expect((doc.shapes[3] as PathShape).closed).toBe(true)
    expect((doc.shapes[2] as PathShape).closed).toBe(false)
  })

  it('takes the page size from a viewBox when width and height are missing', () => {
    const doc = parseSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="10" height="10"/></svg>')
    expect(doc.width).toBe(320)
    expect(doc.height).toBe(240)
  })

  it('lets an inline style override a presentation attribute', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red" style="fill:#00ff00"/></svg>',
    )
    expect((doc.shapes[0] as RectShape).style.fill).toBe('#00ff00')
  })

  it('inherits paint down from a group and bakes the group transform', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<g fill="#0000ff" transform="translate(100 50)"><rect x="10" y="10" width="20" height="20"/></g>' +
        '</svg>',
    )
    const r = doc.shapes[0] as RectShape
    expect(r.style.fill).toBe('#0000ff')
    expect({ x: r.x, y: r.y }).toEqual({ x: 110, y: 60 })
    expect(doc.lossy.join()).toContain('flattened')
  })

  it('turns a sheared shape into a path rather than mispositioning it', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" transform="matrix(1 0.5 0 1 0 0)"/></svg>',
    )
    expect(doc.shapes[0].kind).toBe('path')
    expect(doc.lossy.join()).toContain('became a path')
  })

  it('keeps what it cannot edit instead of dropping it', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="10" height="10"/><image href="a.png" width="10" height="10"/>' +
        '</svg>',
    )
    expect(doc.shapes.map((s) => s.kind)).toEqual(['rect', 'foreign'])
    expect(doc.lossy.join()).toContain('<image>')
    // And it comes back out on the next save.
    expect(toSVG(doc)).toContain('a.png')
  })

  it('hoists defs into the preamble so a gradient still resolves', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)"/>' +
        '</svg>',
    )
    expect(doc.preamble).toHaveLength(1)
    expect((doc.shapes[0] as RectShape).style.fill).toBe('url(#g)')
    const out = toSVG(doc)
    expect(out).toContain('linearGradient')
    expect(out.indexOf('linearGradient')).toBeLessThan(out.indexOf('<rect'))
  })

  it('strips anything executable out of markup it will re-render', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#a" onload="alert(1)"/></svg>',
    )
    const markup = (doc.shapes[0] as { markup: string }).markup
    expect(markup).not.toContain('onload')
    expect(markup).toContain('href="#a"')
  })

  it('drops a script rather than keeping an object with nothing in it', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<script>alert(1)</script><rect width="10" height="10"/>' +
        '</svg>',
    )
    expect(doc.shapes.map((s) => s.kind)).toEqual(['rect'])
    expect(toSVG(doc)).not.toContain('alert')
  })

  it('refuses a link scheme that is not one a drawing needs', () => {
    // Every one of these is a scheme the old regex sanitiser let through:
    // it only knew the literal string "javascript:".
    const hostile = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' java\tscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;',
      'data:image/svg+xml,&lt;svg onload=&quot;alert(1)&quot;/&gt;',
    ]
    for (const href of hostile) {
      const doc = parseSVG(
        `<svg xmlns="http://www.w3.org/2000/svg"><a href="${href}"><rect width="10" height="10"/></a></svg>`,
      )
      const markup = doc.shapes.map((s) => (s as { markup?: string }).markup ?? '').join()
      expect(markup).not.toContain('script')
      expect(markup).not.toContain('href=')
    }
  })

  it('keeps the links and embedded rasters a real file uses', () => {
    for (const href of ['#a', 'other.svg', 'https://example.com/a.png', 'data:image/png;base64,AAAA']) {
      const doc = parseSVG(
        `<svg xmlns="http://www.w3.org/2000/svg"><image href="${href}" width="10" height="10"/></svg>`,
      )
      expect((doc.shapes[0] as { markup: string }).markup).toContain(href)
    }
  })

  it('strips a SMIL animation that writes an event handler back in', () => {
    const doc = parseSVG(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<use href="#a"><set attributeName="onload" to="alert(1)"/></use>' +
        '</svg>',
    )
    expect((doc.shapes[0] as { markup: string }).markup).not.toContain('onload')
  })

  it('refuses markup that is not an SVG file', () => {
    expect(() => parseSVG('<html><body>no</body></html>')).toThrow(SvgError)
    expect(() => parseSVG('<svg><unclosed>')).toThrow(SvgError)
  })

  it('has nothing to warn about in a file it wrote itself', () => {
    expect(parseSVG(toSVG(docOf(rect(), ellipse()))).lossy).toEqual([])
  })
})
