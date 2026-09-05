import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MenuBar } from '@/widgets/Menu'
import type { MenuDef } from '@/widgets/Menu'
import { Box, Button, TextControl } from '@/widgets/controls'
import { DrawIcon } from '@/lib/icons'
import { basename, dirname, useFs } from '@/store/fs'
import { useDesktop } from '@/store/desktop'
import { useCloseGuard } from '@/lib/closeGuards'
import { exportText } from '@/lib/transfer'
import {
  addShape,
  bounds,
  centreOf,
  corners,
  deleteNode,
  duplicateShape,
  emptyDoc,
  fillRef,
  findShape,
  fitPage,
  gradientDefs,
  gradientIds,
  insertNode,
  isEditable,
  isGradient,
  lower,
  moveHandle,
  moveNode,
  parseSVG,
  pathData,
  raise,
  removeShape,
  replaceShape,
  resizeTo,
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
import type { Bounds, DrawDoc, Gradient, PathShape, Point, Shape, Style, TextShape } from '@/lib/draw'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './draw.css'

const DIR = '/boot/home/drawings'

type Tool = 'pick' | 'node' | 'rect' | 'ellipse' | 'polyline' | 'freehand' | 'text'

const TOOLS: { id: Tool; label: string; glyph: string; hint: string }[] = [
  { id: 'pick', label: 'Pick', glyph: '▲', hint: 'Pick — select, move, resize and rotate' },
  { id: 'node', label: 'Shape', glyph: '◇', hint: 'Shape — edit the nodes of a curve' },
  { id: 'rect', label: 'Rectangle', glyph: '▭', hint: 'Rectangle — drag to draw' },
  { id: 'ellipse', label: 'Ellipse', glyph: '◯', hint: 'Ellipse — drag to draw' },
  { id: 'polyline', label: 'Polyline', glyph: '╱', hint: 'Polyline — click each corner, double-click to finish' },
  { id: 'freehand', label: 'Freehand', glyph: '✎', hint: 'Freehand — drag to draw' },
  { id: 'text', label: 'Text', glyph: 'A', hint: 'Text — click to place a line of text' },
]

const PALETTE = [
  '#000000', '#515151', '#838383', '#b5b5b5', '#ffffff', '#7b1010',
  '#c04a2b', '#ffc900', '#3d7a2f', '#2f6ea8', '#336698', '#6b3a8f',
]

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4]

/** The eight resize handles, as fractions of the shape's own box. */
const HANDLES: { id: string; u: number; v: number; cursor: string }[] = [
  { id: 'nw', u: 0, v: 0, cursor: 'nwse-resize' },
  { id: 'n', u: 0.5, v: 0, cursor: 'ns-resize' },
  { id: 'ne', u: 1, v: 0, cursor: 'nesw-resize' },
  { id: 'e', u: 1, v: 0.5, cursor: 'ew-resize' },
  { id: 'se', u: 1, v: 1, cursor: 'nwse-resize' },
  { id: 's', u: 0.5, v: 1, cursor: 'ns-resize' },
  { id: 'sw', u: 0, v: 1, cursor: 'nesw-resize' },
  { id: 'w', u: 0, v: 0.5, cursor: 'ew-resize' },
]

/**
 * In-flight gesture state. Every one of these lives in a ref and is read by a
 * `requestAnimationFrame` that writes attributes straight onto the DOM -- the
 * same rule as `wm/useWindowGesture.ts`. Nothing here reaches React until
 * `pointerup`, so a drag costs one attribute write per frame and no
 * reconciliation at all.
 */
type Gesture =
  | { kind: 'none' }
  | { kind: 'draw'; start: Point; cur: Point }
  | { kind: 'free'; points: Point[] }
  | { kind: 'poly'; points: Point[]; cur: Point }
  | { kind: 'move'; id: string; start: Point; cur: Point }
  | { kind: 'resize'; id: string; handle: string; start: Point; cur: Point; box: Bounds }
  | { kind: 'rotate'; id: string; centre: Point; from: number; cur: number }
  | { kind: 'node'; id: string; index: number; part: 'p' | 'in' | 'out'; cur: Point }

const angleOf = (from: Point, to: Point) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI

/** `rotate(...)` for a shape at rest -- the value React itself renders. */
function restTransform(shape: Shape): string | undefined {
  if (!isEditable(shape) || !shape.rotation) return undefined
  const c = centreOf(shape)
  return `rotate(${shape.rotation} ${c.x} ${c.y})`
}

/** The box a resize handle drag produces, in the shape's own unrotated frame. */
function resizedBox(box: Bounds, handle: string, dx: number, dy: number): Bounds {
  let { x, y, w, h } = box
  if (handle.includes('w')) {
    x += dx
    w -= dx
  }
  if (handle.includes('e')) w += dx
  if (handle.includes('n')) {
    y += dy
    h -= dy
  }
  if (handle.includes('s')) h += dy
  // A box dragged through itself flips rather than inverting its dimensions.
  if (w < 0) {
    x += w
    w = -w
  }
  if (h < 0) {
    y += h
    h = -h
  }
  return { x, y, w: Math.max(1, w), h: Math.max(1, h) }
}

export function Draw({ windowId, args }: AppProps) {
  const [path, setPath] = useState<string | null>(args?.path ?? null)
  const [doc, setDoc] = useState<DrawDoc>(() => emptyDoc())
  /**
   * `dirty` is reference identity against the doc last written or read, not a
   * flag. Every op returns a new doc, so undoing back past the save point
   * clears the asterisk by itself and there is no flag to forget to reset.
   */
  // Seeded with the *same* object `doc` starts as, so an untitled drawing is
  // born clean rather than instantly showing an asterisk on an empty page.
  const [savedDoc, setSavedDoc] = useState<DrawDoc | null>(doc)
  const dirty = doc !== savedDoc

  const [tool, setTool] = useState<Tool>('pick')
  const [selected, setSelected] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [style, setStyleState] = useState<Style>({ fill: '#ffc900', stroke: '#000000', strokeWidth: 1 })
  /** Corner radius for rectangles drawn from now on. */
  const [corner, setCorner] = useState(0)
  const [status, setStatus] = useState('')

  const surfaceRef = useRef<SVGSVGElement>(null)
  const previewRef = useRef<SVGPathElement>(null)
  const overlayRef = useRef<SVGGElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const read = useFs((s) => s.read)
  const write = useFs((s) => s.write)
  const setTitle = useDesktop((s) => s.setTitle)
  const showAlert = useDesktop((s) => s.showAlert)
  const showSavePanel = useDesktop((s) => s.showSavePanel)
  const showOpenPanel = useDesktop((s) => s.showOpenPanel)
  const requestClose = useDesktop((s) => s.requestClose)
  const isActive = useDesktop((s) => s.activeId === windowId)

  // ------------------------------------------------------------------- history

  const history = useRef<{ past: DrawDoc[]; future: DrawDoc[] }>({ past: [], future: [] })
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })
  const UNDO_LIMIT = 50

  /**
   * Every edit goes through here, and every edit is followed by `fitPage` --
   * the page grows to hold whatever the edit put outside it. Doing it here
   * rather than at each call site is the point: it was on draw and resize but
   * not on move, so dragging a shape off the right edge clipped it against a
   * viewBox that never grew. `fitPage` returns the same document when nothing
   * moved out, so the identity check below still sees an edit that changed
   * nothing. A document arriving from disk does not come through here, so
   * opening a file never rewrites the page size it was saved with.
   */
  const commit = useCallback((next: DrawDoc | ((d: DrawDoc) => DrawDoc)) => {
    setDoc((current) => {
      const value = fitPage(typeof next === 'function' ? next(current) : next)
      if (value === current) return current
      const h = history.current
      h.past.push(current)
      if (h.past.length > UNDO_LIMIT) h.past.shift()
      h.future.length = 0
      setDepth({ undo: h.past.length, redo: 0 })
      return value
    })
  }, [])

  const undo = useCallback(() => {
    const h = history.current
    if (!h.past.length) return
    setDoc((current) => {
      h.future.push(current)
      const prev = h.past.pop()!
      setDepth({ undo: h.past.length, redo: h.future.length })
      return prev
    })
  }, [])

  const redo = useCallback(() => {
    const h = history.current
    if (!h.future.length) return
    setDoc((current) => {
      h.past.push(current)
      const next = h.future.pop()!
      setDepth({ undo: h.past.length, redo: h.future.length })
      return next
    })
  }, [])

  /** A document arriving from disk is a new history, not an undoable edit. */
  const adopt = useCallback((next: DrawDoc) => {
    history.current = { past: [], future: [] }
    setDepth({ undo: 0, redo: 0 })
    setDoc(next)
    setSavedDoc(next)
    setSelected(null)
  }, [])

  // ----------------------------------------------------------------- documents

  const loadFrom = useCallback(
    async (target: string): Promise<boolean> => {
      const text = read(target)
      if (text === undefined) {
        await showAlert('stop', 'Draw', `"${basename(target)}" is not on the disk any more.`)
        return false
      }
      try {
        const parsed = parseSVG(text)
        adopt(parsed)
        if (parsed.lossy.length) {
          // Never let a save quietly rewrite what it could not understand.
          await showAlert(
            'warn',
            'Draw',
            `"${basename(target)}" has parts Draw cannot edit:\n\n` +
              parsed.lossy.map((l) => `• ${l}`).join('\n') +
              '\n\nThey are kept and written back out, but their formatting is not.',
          )
        }
        return true
      } catch (err) {
        const why = err instanceof SvgError ? err.message : 'Draw could not read this file.'
        await showAlert('stop', 'Draw', why)
        return false
      }
    },
    [adopt, read, showAlert],
  )

  // The file named at launch. Runs once per path, like StyledEdit's.
  const loadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!path || loadedRef.current === path) return
    loadedRef.current = path
    void loadFrom(path)
  }, [loadFrom, path])

  useEffect(() => {
    const name = path ? basename(path) : 'Untitled'
    setTitle(windowId, dirty ? `${name} *` : name)
  }, [dirty, path, setTitle, windowId])

  const saveAs = useCallback(async (): Promise<string | null> => {
    const target = await showSavePanel(
      'Save drawing',
      path ? dirname(path) : DIR,
      path ? basename(path) : 'Untitled.svg',
    )
    if (!target) return null
    write(target, toSVG(doc))
    setPath(target)
    loadedRef.current = target
    setSavedDoc(doc)
    return target
  }, [doc, path, showSavePanel, write])

  const save = useCallback(async (): Promise<string | null> => {
    if (!path) return saveAs()
    write(path, toSVG(doc))
    setSavedDoc(doc)
    return path
  }, [doc, path, saveAs, write])

  const confirmDiscard = useCallback(
    async (what: string) => {
      if (!dirty) return true
      const answer = await showAlert(
        'warn',
        'Draw',
        `Save changes to "${path ? basename(path) : 'Untitled'}" ${what}`,
        ['Cancel', "Don't save", 'Save'],
        2,
      )
      if (answer === 0) return false
      if (answer === 2 && !(await save())) return false // save panel cancelled
      return true
    },
    [dirty, path, save, showAlert],
  )

  useCloseGuard(windowId, () => confirmDiscard('before closing?'))

  const open = useCallback(async () => {
    if (!(await confirmDiscard('before opening another?'))) return
    const target = await showOpenPanel('Open drawing', path ? dirname(path) : DIR)
    if (!target) return
    if (await loadFrom(target)) {
      setPath(target)
      loadedRef.current = target
    }
  }, [confirmDiscard, loadFrom, path, showOpenPanel])

  const newDrawing = useCallback(async () => {
    if (!(await confirmDiscard('before starting a new one?'))) return
    setPath(null)
    loadedRef.current = null
    adopt(emptyDoc())
  }, [adopt, confirmDiscard])

  const exportToHost = useCallback(() => {
    exportText(path ? basename(path) : 'Untitled.svg', toSVG(doc), 'image/svg+xml')
  }, [doc, path])

  // ------------------------------------------------------------------ geometry

  /**
   * Screen to document units.
   *
   * The `<svg>` is sized `doc.width * zoom` over a viewBox of `doc.width`, so
   * one CSS pixel is exactly `1/zoom` document units and the scroll container's
   * offset is already inside `getBoundingClientRect()`. Deliberately no
   * `getScreenCTM` -- jsdom does not implement one, and this is exact anyway.
   * Under jsdom the rect reads all zeros at zoom 1, which is what lets a test
   * fire pointer events with plain client coordinates and assert on the shape
   * that lands in the model.
   */
  const toDocPoint = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const svg = surfaceRef.current
      if (!svg) return { x: 0, y: 0 }
      const r = svg.getBoundingClientRect()
      return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
    },
    [zoom],
  )

  const shape = findShape(doc, selected)
  const editable = shape && isEditable(shape) ? shape : undefined
  const selBounds = editable ? bounds(editable) : null

  // ------------------------------------------------------------------ gestures

  const gesture = useRef<{ mode: Gesture; raf: number }>({ mode: { kind: 'none' }, raf: 0 })

  /** The one place a live gesture touches the DOM. */
  const flush = useCallback(() => {
    gesture.current.raf = 0
    const mode = gesture.current.mode
    const preview = previewRef.current
    const overlay = overlayRef.current
    if (!preview) return

    const showPreview = (d: string) => {
      preview.setAttribute('d', d)
      preview.removeAttribute('display')
    }

    switch (mode.kind) {
      case 'draw': {
        const { start, cur } = mode
        const x = Math.min(start.x, cur.x)
        const y = Math.min(start.y, cur.y)
        const w = Math.abs(cur.x - start.x)
        const h = Math.abs(cur.y - start.y)
        if (tool === 'ellipse') {
          const rx = w / 2
          const ry = h / 2
          const cx = x + rx
          const cy = y + ry
          showPreview(
            `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0 Z`,
          )
        } else {
          showPreview(`M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`)
        }
        break
      }
      case 'free':
        showPreview(mode.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '))
        break
      case 'poly':
        showPreview(
          [...mode.points, mode.cur].map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '),
        )
        break
      case 'move':
      case 'resize':
      case 'rotate':
      case 'node': {
        const el = surfaceRef.current?.querySelector<SVGGElement>(`[data-id="${mode.id}"]`)
        const target = findShape(doc, mode.id)
        if (!el || !target || !isEditable(target)) break
        if (mode.kind === 'node') {
          // The node tool edits the geometry itself, so the exact path is
          // cheap to recompute and looks right rather than merely close.
          const next = applyNodeDrag(target as PathShape, mode)
          el.querySelector('path')?.setAttribute('d', pathData(next))
          break
        }
        const t = previewTransform(target, mode)
        el.setAttribute('transform', t)
        // The handles ride the same transform, so all nine follow for free.
        if (overlay) overlay.setAttribute('transform', mode.kind === 'move' ? t : '')
        break
      }
      case 'none':
        break
    }
  }, [doc, tool])

  const schedule = useCallback(() => {
    if (gesture.current.raf) return
    gesture.current.raf = requestAnimationFrame(flush)
  }, [flush])

  const hidePreview = useCallback(() => {
    previewRef.current?.setAttribute('display', 'none')
    overlayRef.current?.removeAttribute('transform')
  }, [])

  /** Undo the direct DOM writes, so React's own attributes are showing again. */
  const resetElement = useCallback((id: string) => {
    const el = surfaceRef.current?.querySelector<SVGGElement>(`[data-id="${id}"]`)
    if (!el) return
    const target = findShape(doc, id)
    const rest = target ? restTransform(target) : undefined
    if (rest) el.setAttribute('transform', rest)
    else el.removeAttribute('transform')
  }, [doc])

  const finish = useCallback(() => {
    const mode = gesture.current.mode
    gesture.current.mode = { kind: 'none' }
    if (gesture.current.raf) {
      cancelAnimationFrame(gesture.current.raf)
      gesture.current.raf = 0
    }
    hidePreview()

    switch (mode.kind) {
      case 'draw': {
        const { start, cur } = mode
        const x = Math.min(start.x, cur.x)
        const y = Math.min(start.y, cur.y)
        const w = Math.abs(cur.x - start.x)
        const h = Math.abs(cur.y - start.y)
        // A stray click is not a shape.
        if (w < 2 || h < 2) return
        const id = shapeId()
        const next: Shape =
          tool === 'ellipse'
            ? { kind: 'ellipse', id, style, rotation: 0, cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 }
            : { kind: 'rect', id, style, rotation: 0, x, y, w, h, rx: corner }
        commit((d) => addShape(d, next))
        setSelected(id)
        setTool('pick')
        return
      }
      case 'free': {
        if (mode.points.length < 2) return
        const id = shapeId()
        const next: PathShape = {
          kind: 'path', id, style, rotation: 0, closed: false,
          nodes: mode.points.map((p) => ({ p, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false })),
        }
        commit((d) => addShape(d, next))
        setSelected(id)
        return
      }
      case 'move': {
        resetElement(mode.id)
        const target = findShape(doc, mode.id)
        if (!target || !isEditable(target)) return
        const dx = mode.cur.x - mode.start.x
        const dy = mode.cur.y - mode.start.y
        if (!dx && !dy) return
        commit((d) => replaceShape(d, translate(target, dx, dy)))
        return
      }
      case 'resize': {
        resetElement(mode.id)
        const target = findShape(doc, mode.id)
        if (!target || !isEditable(target)) return
        const next = resizedBox(mode.box, mode.handle, mode.cur.x - mode.start.x, mode.cur.y - mode.start.y)
        commit((d) => replaceShape(d, resizeTo(target, next)))
        return
      }
      case 'rotate': {
        resetElement(mode.id)
        const target = findShape(doc, mode.id)
        if (!target || !isEditable(target)) return
        const deg = Math.round(target.rotation + (mode.cur - mode.from))
        commit((d) => replaceShape(d, { ...target, rotation: ((deg % 360) + 360) % 360 }))
        return
      }
      case 'node': {
        const target = findShape(doc, mode.id)
        if (!target || target.kind !== 'path') return
        commit((d) => replaceShape(d, applyNodeDrag(target, mode)))
        return
      }
      default:
        return
    }
  }, [commit, corner, doc, hidePreview, resetElement, style, tool])

  const beginDrag = useCallback(
    (mode: Gesture) => {
      gesture.current.mode = mode
      const move = (ev: PointerEvent) => {
        const p = toDocPoint(ev)
        const m = gesture.current.mode
        if (m.kind === 'draw' || m.kind === 'move' || m.kind === 'resize' || m.kind === 'node') m.cur = p
        else if (m.kind === 'free') m.points.push(p)
        else if (m.kind === 'rotate') m.cur = angleOf(m.centre, p)
        schedule()
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        finish()
      }
      // Listeners go on the window, as DesktopIcons does, so a drag that
      // leaves the surface still tracks.
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [finish, schedule, toDocPoint],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const p = toDocPoint(e)
      const target = e.target as Element

      // The polyline tool is click-by-click, so it is settled before anything
      // else looks at the event.
      if (tool === 'polyline') {
        const m = gesture.current.mode
        if (m.kind === 'poly') {
          m.points.push(p)
          m.cur = p
          schedule()
        } else {
          gesture.current.mode = { kind: 'poly', points: [p], cur: p }
          const move = (ev: PointerEvent) => {
            const mm = gesture.current.mode
            if (mm.kind !== 'poly') {
              window.removeEventListener('pointermove', move)
              return
            }
            mm.cur = toDocPoint(ev)
            schedule()
          }
          window.addEventListener('pointermove', move)
        }
        return
      }

      if (tool === 'text') {
        const id = shapeId()
        const next: TextShape = {
          kind: 'text', id, style, rotation: 0, x: p.x, y: p.y,
          text: 'Text', fontSize: 24, fontFamily: 'var(--font-plain)',
        }
        commit((d) => addShape(d, next))
        setSelected(id)
        setTool('pick')
        return
      }

      if (tool === 'rect' || tool === 'ellipse') {
        e.preventDefault()
        beginDrag({ kind: 'draw', start: p, cur: p })
        return
      }

      if (tool === 'freehand') {
        e.preventDefault()
        beginDrag({ kind: 'free', points: [p] })
        return
      }

      // Pick and node share their hit-testing, and all of it is DOM: the
      // handles and nodes are real elements, so there is no geometry here.
      const handle = target.closest('[data-handle]')
      if (handle && editable) {
        e.preventDefault()
        const id = handle.getAttribute('data-handle')!
        if (id === 'rot') {
          const c = centreOf(editable)
          beginDrag({ kind: 'rotate', id: editable.id, centre: c, from: angleOf(c, p), cur: angleOf(c, p) })
        } else {
          beginDrag({ kind: 'resize', id: editable.id, handle: id, start: p, cur: p, box: bounds(editable) })
        }
        return
      }

      const nodeEl = target.closest('[data-node]')
      if (nodeEl && editable?.kind === 'path') {
        e.preventDefault()
        const [index, part] = nodeEl.getAttribute('data-node')!.split(':')
        beginDrag({
          kind: 'node', id: editable.id, index: Number(index),
          part: part as 'p' | 'in' | 'out', cur: p,
        })
        return
      }

      const shapeEl = target.closest('[data-id]')
      if (!shapeEl) {
        setSelected(null)
        return
      }
      const id = shapeEl.getAttribute('data-id')!
      setSelected(id)
      if (tool === 'pick') {
        e.preventDefault()
        beginDrag({ kind: 'move', id, start: p, cur: p })
      }
    },
    [beginDrag, commit, editable, schedule, style, toDocPoint, tool],
  )

  /** Double-click ends a polyline, and splits a segment under the node tool. */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const m = gesture.current.mode
      if (m.kind === 'poly') {
        gesture.current.mode = { kind: 'none' }
        hidePreview()
        if (m.points.length >= 2) {
          const id = shapeId()
          commit((d) =>
            addShape(d, {
              kind: 'path', id, style, rotation: 0, closed: false,
              nodes: m.points.map((p) => ({ p, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false })),
            }),
          )
          setSelected(id)
          setTool('pick')
        }
        return
      }
      if (tool === 'node' && editable?.kind === 'path') {
        const seg = (e.target as Element).closest('[data-seg]')
        if (seg) commit((d) => replaceShape(d, insertNode(editable, Number(seg.getAttribute('data-seg')))))
      }
    },
    [commit, editable, hidePreview, style, tool],
  )

  useEffect(() => () => {
    if (gesture.current.raf) cancelAnimationFrame(gesture.current.raf)
  }, [])

  // ------------------------------------------------------------------- actions

  const withSelected = useCallback(
    (fn: (d: DrawDoc, id: string) => DrawDoc) => {
      if (!selected) return
      commit((d) => fn(d, selected))
    },
    [commit, selected],
  )

  const remove = useCallback(() => {
    if (!selected) return
    commit((d) => removeShape(d, selected))
    setSelected(null)
  }, [commit, selected])

  const duplicate = useCallback(() => {
    if (!selected) return
    let created: string | null = null
    commit((d) => {
      const r = duplicateShape(d, selected)
      created = r.id
      return r.doc
    })
    if (created) setSelected(created)
  }, [commit, selected])

  const convertToCurves = useCallback(() => {
    if (!editable) return
    const p = toPath(editable)
    if (!p) return
    commit((d) => replaceShape(d, { ...p, id: editable.id }))
    setTool('node')
  }, [commit, editable])

  const setSelectedStyle = useCallback(
    (patch: Partial<Style>) => {
      setStyleState((s) => ({ ...s, ...patch }))
      if (selected) commit((d) => setStyle(d, selected, patch))
    },
    [commit, selected],
  )

  /**
   * What the side panel shows. The selection wins over the tool's own style,
   * so clicking a green rect turns the panel green rather than leaving it on
   * whatever was last drawn.
   */
  const shown: Style = editable ? editable.style : style
  const fill = shown.fill
  const fillMode: 'none' | 'flat' | 'linear' | 'radial' =
    fill === null ? 'none' : typeof fill === 'string' ? 'flat' : fill.kind

  /** Switching mode keeps the colours already chosen wherever it can. */
  const setFillMode = useCallback(
    (mode: 'flat' | 'linear' | 'radial') => {
      const from = isGradient(fill) ? fill.stops[0].color : (fill ?? '#ffc900')
      const to = isGradient(fill) ? (fill.stops[1]?.color ?? '#ffffff') : '#ffffff'
      if (mode === 'flat') {
        setSelectedStyle({ fill: from })
        return
      }
      const stops = [
        { offset: 0, color: from },
        { offset: 1, color: to },
      ]
      const next: Gradient =
        mode === 'radial'
          ? { kind: 'radial', stops }
          : { kind: 'linear', angle: isGradient(fill) && fill.kind === 'linear' ? fill.angle : 90, stops }
      setSelectedStyle({ fill: next })
    },
    [fill, setSelectedStyle],
  )

  /** A swatch sets the flat colour, or one end of the gradient ramp. */
  const setFillStop = useCallback(
    (index: 0 | 1, colour: string | null) => {
      if (!isGradient(fill)) {
        setSelectedStyle({ fill: colour })
        return
      }
      // Clearing the first swatch drops the gradient rather than leaving a
      // ramp with a hole in it; a stop has no "none".
      if (colour === null) {
        setSelectedStyle({ fill: null })
        return
      }
      setSelectedStyle({
        fill: { ...fill, stops: fill.stops.map((s, i) => (i === index ? { ...s, color: colour } : s)) },
      })
    },
    [fill, setSelectedStyle],
  )

  const cornerRadius = editable?.kind === 'rect' ? editable.rx : corner
  const setCornerRadius = useCallback(
    (n: number) => {
      const v = Math.max(0, Number.isFinite(n) ? n : 0)
      setCorner(v)
      if (editable?.kind === 'rect') commit((d) => replaceShape(d, { ...editable, rx: v }))
    },
    [commit, editable],
  )

  // ------------------------------------------------------------------- menus

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'File',
        items: [
          { label: 'New', shortcut: 'Alt+N', onSelect: () => void newDrawing() },
          { label: 'Open…', shortcut: 'Alt+O', onSelect: () => void open() },
          { separator: true },
          { label: 'Save', shortcut: 'Alt+S', disabled: !dirty && Boolean(path), onSelect: () => void save() },
          { label: 'Save as…', onSelect: () => void saveAs() },
          { separator: true },
          { label: 'Export SVG…', onSelect: exportToHost },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      {
        title: 'Edit',
        items: [
          { label: 'Undo', shortcut: 'Alt+Z', disabled: !depth.undo, onSelect: undo },
          { label: 'Redo', shortcut: 'Alt+Shift+Z', disabled: !depth.redo, onSelect: redo },
          { separator: true },
          { label: 'Duplicate', shortcut: 'Alt+D', disabled: !editable, onSelect: duplicate },
          { label: 'Delete', shortcut: 'Del', disabled: !selected, onSelect: remove },
        ],
      },
      {
        title: 'Object',
        items: [
          {
            label: 'Convert to curves',
            shortcut: 'Alt+Q',
            disabled: !editable || editable.kind === 'path' || editable.kind === 'text',
            onSelect: convertToCurves,
          },
          { separator: true },
          {
            label: 'Delete node',
            disabled: editable?.kind !== 'path',
            onSelect: () => {
              if (editable?.kind === 'path') commit((d) => replaceShape(d, deleteNode(editable, editable.nodes.length - 1)))
            },
          },
          {
            label: 'Smooth node',
            disabled: editable?.kind !== 'path',
            onSelect: () => {
              if (editable?.kind === 'path') commit((d) => replaceShape(d, setNodeSmooth(editable, 0, true)))
            },
          },
          { separator: true },
          {
            label: editable?.kind === 'path' && editable.closed ? 'Open curve' : 'Close curve',
            disabled: editable?.kind !== 'path',
            onSelect: () => {
              if (editable?.kind === 'path') commit((d) => replaceShape(d, { ...editable, closed: !editable.closed }))
            },
          },
        ],
      },
      {
        title: 'Arrange',
        items: [
          { label: 'To front', disabled: !selected, onSelect: () => withSelected(toFront) },
          { label: 'Forward one', disabled: !selected, onSelect: () => withSelected(raise) },
          { label: 'Back one', disabled: !selected, onSelect: () => withSelected(lower) },
          { label: 'To back', disabled: !selected, onSelect: () => withSelected(toBack) },
        ],
      },
      {
        title: 'View',
        items: ZOOMS.map((z) => ({
          label: `${Math.round(z * 100)}%`,
          checked: zoom === z,
          onSelect: () => setZoom(z),
        })),
      },
    ],
    [
      convertToCurves, commit, depth, dirty, duplicate, editable, exportToHost, newDrawing, open,
      path, redo, remove, requestClose, save, saveAs, selected, undo, windowId, withSelected, zoom,
    ],
  )

  // ------------------------------------------------------------------- keys

  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      // Never steal a key from the side panel's own fields.
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const key = e.key.toLowerCase()
        const bound: Record<string, () => void> = {
          s: () => void save(),
          o: () => void open(),
          n: () => void newDrawing(),
          d: duplicate,
          q: convertToCurves,
          z: () => (e.shiftKey ? redo() : undo()),
        }
        if (bound[key]) {
          e.preventDefault()
          bound[key]()
        }
        return
      }
      if (e.ctrlKey || e.metaKey) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        remove()
      } else if (e.key === 'Escape') {
        // Abandons a polyline in progress; otherwise just drops the selection.
        gesture.current.mode = { kind: 'none' }
        hidePreview()
        setSelected(null)
      } else if (e.key === 'Enter' && gesture.current.mode.kind === 'poly') {
        e.preventDefault()
        onDoubleClick({ target: e.target } as unknown as React.MouseEvent)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    convertToCurves, duplicate, hidePreview, isActive, newDrawing, onDoubleClick, open, redo,
    remove, save, undo,
  ])

  // ------------------------------------------------------------------ status

  useEffect(() => {
    if (!editable) {
      setStatus(`${doc.shapes.length} object${doc.shapes.length === 1 ? '' : 's'}`)
      return
    }
    const b = bounds(editable)
    const name = editable.kind[0].toUpperCase() + editable.kind.slice(1)
    setStatus(
      `${name}   x ${Math.round(b.x)}  y ${Math.round(b.y)}  w ${Math.round(b.w)}  h ${Math.round(b.h)}` +
        (editable.rotation ? `  ${Math.round(editable.rotation)}°` : ''),
    )
  }, [doc.shapes.length, editable])

  // ------------------------------------------------------------------ render

  const handleSize = 7 / zoom
  // The very markup `toSVG` writes, so the gradient on screen and the gradient
  // in the file cannot drift apart.
  const defs = useMemo(() => gradientDefs(doc), [doc])
  const gradIds = useMemo(() => gradientIds(doc), [doc])

  return (
    <div className="draw" ref={rootRef} data-tool={tool}>
      <MenuBar menus={menus} />
      <div className="draw-body">
        <div className="draw-tools" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="b-button draw-tool"
              data-tool={t.id}
              data-active={tool === t.id}
              aria-pressed={tool === t.id}
              title={t.hint}
              aria-label={t.label}
              onClick={() => {
                gesture.current.mode = { kind: 'none' }
                hidePreview()
                setTool(t.id)
              }}
            >
              {t.glyph}
            </button>
          ))}
        </div>

        <div className="draw-stage b-scroll">
          <svg
            ref={surfaceRef}
            className="draw-surface"
            width={doc.width * zoom}
            height={doc.height * zoom}
            viewBox={`0 0 ${doc.width} ${doc.height}`}
            onPointerDown={onPointerDown}
            onDoubleClick={onDoubleClick}
          >
            <rect className="draw-page" x={0} y={0} width={doc.width} height={doc.height} />
            {defs && <g dangerouslySetInnerHTML={{ __html: defs }} />}
            {/* Whatever came in with the file, so a url(#gradient) still resolves. */}
            {doc.preamble.length > 0 && (
              <g dangerouslySetInnerHTML={{ __html: doc.preamble.join('') }} />
            )}
            {doc.shapes.map((s) => (
              <ShapeView key={s.id} shape={s} gradId={gradIds[s.id]} />
            ))}

            <g className="draw-overlay" ref={overlayRef}>
              {editable && selBounds && tool !== 'node' && (
                <SelectionHandles shape={editable} size={handleSize} />
              )}
              {editable?.kind === 'path' && tool === 'node' && (
                <NodeHandles shape={editable} size={handleSize} />
              )}
            </g>

            <path ref={previewRef} className="draw-preview" display="none" />
          </svg>
        </div>

        <div className="draw-side">
          {/* Properties scroll; the actions below them never do. */}
          <div className="draw-props b-scroll">
          <Box label="Fill">
            <Swatches
              value={isGradient(fill) ? fill.stops[0].color : fill}
              onPick={(c) => setFillStop(0, c)}
            />
            <div className="draw-modes" role="group" aria-label="Fill type">
              {(['flat', 'linear', 'radial'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className="b-button draw-mode"
                  data-active={fillMode === m}
                  aria-pressed={fillMode === m}
                  aria-label={m === 'flat' ? 'Flat fill' : `${m} gradient`}
                  onClick={() => setFillMode(m)}
                >
                  {m === 'flat' ? 'Flat' : m === 'linear' ? 'Lin' : 'Rad'}
                </button>
              ))}
            </div>
            {isGradient(fill) && (
              <>
                <div className="draw-sublabel">to</div>
                <Swatches
                  value={fill.stops[1]?.color ?? null}
                  allowNone={false}
                  onPick={(c) => setFillStop(1, c)}
                />
                {fill.kind === 'linear' && (
                  <label className="draw-field">
                    <span>Angle</span>
                    <TextControl
                      type="number"
                      step={15}
                      value={fill.angle}
                      aria-label="Gradient angle"
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (Number.isFinite(n)) {
                          setSelectedStyle({ fill: { ...fill, angle: ((n % 360) + 360) % 360 } })
                        }
                      }}
                    />
                  </label>
                )}
              </>
            )}
          </Box>
          {(editable?.kind === 'rect' || tool === 'rect') && (
            <Box label="Corners">
              <label className="draw-field">
                <span>Radius</span>
                <TextControl
                  type="number"
                  min={0}
                  step={2}
                  value={cornerRadius}
                  aria-label="Corner radius"
                  onChange={(e) => setCornerRadius(Number(e.target.value))}
                />
              </label>
            </Box>
          )}
          <Box label="Outline">
            <Swatches value={shown.stroke} onPick={(stroke) => setSelectedStyle({ stroke })} />
            <label className="draw-field">
              <span>Width</span>
              <TextControl
                type="number"
                min={0}
                max={40}
                step={0.5}
                value={shown.strokeWidth}
                aria-label="Outline width"
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) setSelectedStyle({ strokeWidth: Math.max(0, n) })
                }}
              />
            </label>
          </Box>
          {editable?.kind === 'text' && (
            <Box label="Text">
              <TextControl
                value={editable.text}
                aria-label="Text content"
                onChange={(e) => commit((d) => replaceShape(d, { ...editable, text: e.target.value }))}
              />
            </Box>
          )}
          </div>
          <div className="draw-buttons">
            <Button disabled={!selected} onClick={duplicate}>Duplicate</Button>
            <Button disabled={!selected} onClick={remove}>Delete</Button>
          </div>
        </div>
      </div>
      <div className="draw-status">
        {status}
        <span className="b-spacer" />
        {Math.round(zoom * 100)}%
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- sub-views

function ShapeView({ shape, gradId }: { shape: Shape; gradId?: string }) {
  if (shape.kind === 'foreign') {
    // Drawn but not editable, and never a pointer target.
    return (
      <g
        data-foreign={shape.id}
        pointerEvents="none"
        dangerouslySetInnerHTML={{ __html: shape.markup }}
      />
    )
  }
  const paint = {
    fill: fillRef(shape.style.fill, gradId),
    stroke: shape.style.stroke ?? 'none',
    strokeWidth: shape.style.strokeWidth,
  }
  return (
    <g data-id={shape.id} transform={restTransform(shape)}>
      {shape.kind === 'rect' && (
        <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.rx || undefined} {...paint} />
      )}
      {shape.kind === 'ellipse' && (
        <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...paint} />
      )}
      {shape.kind === 'path' && <path d={pathData(shape)} {...paint} />}
      {shape.kind === 'text' && (
        <text x={shape.x} y={shape.y} fontFamily={shape.fontFamily} fontSize={shape.fontSize} {...paint}>
          {shape.text}
        </text>
      )}
      {/* An unfilled outline has to be grabbable by its interior too. */}
      {shape.kind !== 'text' && shape.style.fill === null && (
        <Hitbox shape={shape} />
      )}
    </g>
  )
}

/** An invisible, filled copy of the shape, purely so clicks land on it. */
function Hitbox({ shape }: { shape: Shape }) {
  if (shape.kind === 'rect') {
    return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill="transparent" stroke="none" />
  }
  if (shape.kind === 'ellipse') {
    return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill="transparent" stroke="none" />
  }
  if (shape.kind === 'path') {
    return <path d={pathData(shape)} fill="transparent" stroke="none" />
  }
  return null
}

function SelectionHandles({ shape, size }: { shape: Shape; size: number }) {
  const pts = corners(shape)
  const at = (u: number, v: number): Point => {
    // Bilinear across the (possibly rotated) corners, so an edge handle sits
    // on the edge rather than on the axis-aligned box around it.
    const top = { x: pts[0].x + (pts[1].x - pts[0].x) * u, y: pts[0].y + (pts[1].y - pts[0].y) * u }
    const bottom = { x: pts[3].x + (pts[2].x - pts[3].x) * u, y: pts[3].y + (pts[2].y - pts[3].y) * u }
    return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v }
  }
  const north = at(0.5, 0)
  const centre = centreOf(shape)
  const away = Math.hypot(north.x - centre.x, north.y - centre.y) || 1
  const grip = {
    x: north.x + ((north.x - centre.x) / away) * size * 3,
    y: north.y + ((north.y - centre.y) / away) * size * 3,
  }
  return (
    <>
      <path
        className="draw-marchers"
        d={`M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`}
        fill="none"
      />
      <line className="draw-rotstem" x1={north.x} y1={north.y} x2={grip.x} y2={grip.y} />
      <circle className="draw-handle" data-handle="rot" cx={grip.x} cy={grip.y} r={size / 1.6} />
      {HANDLES.map((h) => {
        const p = at(h.u, h.v)
        return (
          <rect
            key={h.id}
            className="draw-handle"
            data-handle={h.id}
            style={{ cursor: h.cursor }}
            x={p.x - size / 2}
            y={p.y - size / 2}
            width={size}
            height={size}
          />
        )
      })}
    </>
  )
}

function NodeHandles({ shape, size }: { shape: PathShape; size: number }) {
  const n = shape.nodes
  const segs = shape.closed ? n.length : n.length - 1
  return (
    <>
      {/* One invisible stripe per segment, so a double-click can name which. */}
      {Array.from({ length: Math.max(0, segs) }, (_, i) => {
        const a = n[i]
        const b = n[(i + 1) % n.length]
        const d =
          !a.out.x && !a.out.y && !b.in.x && !b.in.y
            ? `M ${a.p.x} ${a.p.y} L ${b.p.x} ${b.p.y}`
            : `M ${a.p.x} ${a.p.y} C ${a.p.x + a.out.x} ${a.p.y + a.out.y} ${b.p.x + b.in.x} ${b.p.y + b.in.y} ${b.p.x} ${b.p.y}`
        return <path key={`s${i}`} className="draw-seg" data-seg={i} d={d} strokeWidth={size} />
      })}
      {n.map((node, i) => (
        <g key={i}>
          {(node.in.x || node.in.y) && (
            <>
              <line className="draw-hstem" x1={node.p.x} y1={node.p.y} x2={node.p.x + node.in.x} y2={node.p.y + node.in.y} />
              <circle className="draw-grip" data-node={`${i}:in`} cx={node.p.x + node.in.x} cy={node.p.y + node.in.y} r={size / 2} />
            </>
          )}
          {(node.out.x || node.out.y) && (
            <>
              <line className="draw-hstem" x1={node.p.x} y1={node.p.y} x2={node.p.x + node.out.x} y2={node.p.y + node.out.y} />
              <circle className="draw-grip" data-node={`${i}:out`} cx={node.p.x + node.out.x} cy={node.p.y + node.out.y} r={size / 2} />
            </>
          )}
          <rect
            className="draw-node"
            data-node={`${i}:p`}
            data-smooth={node.smooth}
            x={node.p.x - size / 2}
            y={node.p.y - size / 2}
            width={size}
            height={size}
          />
        </g>
      ))}
    </>
  )
}

function Swatches({
  value,
  onPick,
  allowNone = true,
}: {
  value: string | null
  onPick: (c: string | null) => void
  allowNone?: boolean
}) {
  return (
    <div className="draw-swatches">
      {allowNone && (
        <button
          type="button"
          className="draw-swatch draw-swatch--none"
          data-active={value === null}
          aria-label="None"
          title="None"
          onClick={() => onPick(null)}
        />
      )}
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className="draw-swatch"
          data-active={value === c}
          style={{ background: c }}
          aria-label={c}
          title={c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- helpers

/** The transform that previews a move, resize or rotate without a re-render. */
function previewTransform(
  shape: Shape,
  mode: Extract<Gesture, { kind: 'move' | 'resize' | 'rotate' }>,
): string {
  const rest = isEditable(shape) ? shape.rotation : 0
  if (mode.kind === 'move') {
    const c = centreOf(shape)
    const spin = rest ? ` rotate(${rest} ${c.x} ${c.y})` : ''
    return `translate(${mode.cur.x - mode.start.x} ${mode.cur.y - mode.start.y})${spin}`
  }
  if (mode.kind === 'rotate') {
    const c = centreOf(shape)
    return `rotate(${rest + (mode.cur - mode.from)} ${c.x} ${c.y})`
  }
  const box = mode.box
  const next = resizedBox(box, mode.handle, mode.cur.x - mode.start.x, mode.cur.y - mode.start.y)
  const sx = box.w === 0 ? 1 : next.w / box.w
  const sy = box.h === 0 ? 1 : next.h / box.h
  const tx = next.x - box.x * sx
  const ty = next.y - box.y * sy
  // Rotation is about the *new* centre, because the box moved under it.
  const spin = rest ? `rotate(${rest} ${next.x + next.w / 2} ${next.y + next.h / 2}) ` : ''
  return `${spin}translate(${tx} ${ty}) scale(${sx} ${sy})`
}

function applyNodeDrag(shape: PathShape, mode: Extract<Gesture, { kind: 'node' }>): PathShape {
  if (mode.part === 'p') return moveNode(shape, mode.index, mode.cur)
  return moveHandle(shape, mode.index, mode.part, mode.cur)
}

registerApp({
  id: 'draw',
  name: 'Draw',
  component: Draw,
  icon: DrawIcon,
  // Wide enough for a 512-unit page at 100% with the toolbox and the side
  // panel either side of it, the stage's padding and the page's cast shadow --
  // eight pixels short and the pasteboard scrolls sideways on an empty page.
  defaultW: 720,
  // Tall enough for the whole property panel with a gradient's extra rows in
  // it, which is taller than the page needs.
  defaultH: 560,
  minW: 400,
  minH: 300,
})
