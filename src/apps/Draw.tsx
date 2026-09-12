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
  anchorPoints,
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
  nearestAnchor,
  parseSVG,
  pathData,
  raise,
  removeShape,
  replaceShape,
  resizeTo,
  samePoint,
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

type Tool = 'pick' | 'node' | 'rect' | 'ellipse' | 'line' | 'polyline' | 'freehand' | 'text'

/**
 * The toolbox. `hint` is the tooltip; `status` is the line the status bar
 * shows while that tool is up, which is where a tool with more than one
 * gesture in it gets to explain itself. The two tools that act on an existing
 * object have no `status` and leave the bar to the selection instead.
 */
const TOOLS: { id: Tool; label: string; hint: string; status?: string }[] = [
  { id: 'pick', label: 'Pick', hint: 'Pick — select, move, resize and rotate' },
  {
    id: 'node',
    label: 'Node',
    hint: 'Node — drag the nodes of a curve; double-click a rectangle or ellipse to convert it',
  },
  { id: 'rect', label: 'Rectangle', hint: 'Rectangle — drag to draw', status: 'Drag to draw a rectangle.' },
  { id: 'ellipse', label: 'Ellipse', hint: 'Ellipse — drag to draw', status: 'Drag to draw an ellipse.' },
  {
    id: 'line',
    label: 'Line',
    hint: 'Line — drag from one end to the other; both ends snap to nearby points',
    status: 'Drag from one end to the other. Both ends snap to nearby points.',
  },
  {
    id: 'polyline',
    label: 'Polyline',
    hint:
      'Polyline — click each corner; points snap to nearby ends and corners. ' +
      'Double-click or Enter finishes, the first point closes, Backspace takes one back',
    // The status bar is one line and clips, so it carries the two endings a
    // user cannot guess; the rest is in the tooltip above.
    status: 'Click each corner — points snap to nearby ends. Double-click to finish, first point to close.',
  },
  { id: 'freehand', label: 'Freehand', hint: 'Freehand — drag to draw', status: 'Drag to draw a freehand line.' },
  { id: 'text', label: 'Text', hint: 'Text — click to place a line of text', status: 'Click to place a line of text.' },
]

/** How near, in *screen* pixels, a click has to land before it is a snap. */
const SNAP_PX = 9

/**
 * The faces offered for text.
 *
 * Real stacks, not `var(--font-plain)`: `toSVG` writes the family into the
 * file verbatim, and a CSS variable there resolves to nothing outside this
 * page -- the drawing opened in anything else fell back to the reader's
 * default. The sans stack is the desktop's own, so nothing changes on screen.
 */
const FONTS: { label: string; value: string }[] = [
  {
    label: 'Sans',
    value: '"Bitstream Vera Sans", "DejaVu Sans", "Noto Sans", "Segoe UI", system-ui, sans-serif',
  },
  { label: 'Serif', value: 'Georgia, "Times New Roman", Times, serif' },
  {
    label: 'Mono',
    value: '"Bitstream Vera Sans Mono", "DejaVu Sans Mono", Consolas, "Courier New", monospace',
  },
]

/** What a new text object is born with, until the panel says otherwise. */
const DEFAULT_TEXT = { fontSize: 24, fontFamily: FONTS[0].value }

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
  /** `snap` is the line tool's: a rectangle dragged onto a corner is rarely meant. */
  | { kind: 'draw'; start: Point; cur: Point; snap: boolean; snapped: boolean }
  | { kind: 'free'; points: Point[] }
  | { kind: 'poly'; points: Point[]; cur: Point; snapped: boolean }
  | { kind: 'move'; id: string; start: Point; cur: Point }
  | { kind: 'resize'; id: string; handle: string; start: Point; cur: Point; box: Bounds }
  | { kind: 'rotate'; id: string; centre: Point; from: number; cur: number }
  | { kind: 'node'; id: string; index: number; part: 'p' | 'in' | 'out'; start: Point; cur: Point }

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
  /**
   * Which node of the selected path the node tool is working on.
   *
   * There was no such thing for a long time, and the Object menu had to guess:
   * *Delete node* took `nodes.length - 1` and *Smooth node* took `0`, whatever
   * you had clicked. Clicking a node only ever started a drag, so the two menu
   * items acted on a node nobody had chosen and the tool could not be used.
   */
  const [selectedNode, setSelectedNode] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [style, setStyleState] = useState<Style>({ fill: '#ffc900', stroke: '#000000', strokeWidth: 1 })
  /** Corner radius for rectangles drawn from now on. */
  const [corner, setCorner] = useState(0)
  /** Size and face for text placed from now on -- `corner`'s rule, for text. */
  const [textStyle, setTextStyle] = useState(DEFAULT_TEXT)
  /**
   * The text object being typed into on the page, and the line being typed.
   *
   * The draft is held here rather than committed per keystroke, so finishing
   * an edit is one undo step and abandoning it with Escape is free.
   */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // A node index only means anything against the path it came from.
  useEffect(() => setSelectedNode(null), [selected, tool])

  const surfaceRef = useRef<SVGSVGElement>(null)
  const previewRef = useRef<SVGPathElement>(null)
  const snapMarkRef = useRef<SVGCircleElement>(null)
  const editorRef = useRef<HTMLInputElement>(null)
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

  /**
   * `key` names what the last entry was for, so a run of edits that are one
   * change to the user can be one undo step -- see `commit`.
   */
  const history = useRef<{ past: DrawDoc[]; future: DrawDoc[]; key: string | null }>({
    past: [], future: [], key: null,
  })
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
  const commit = useCallback((next: DrawDoc | ((d: DrawDoc) => DrawDoc), coalesce?: string) => {
    setDoc((current) => {
      const value = fitPage(typeof next === 'function' ? next(current) : next)
      if (value === current) return current
      const h = history.current
      /*
       * Consecutive edits carrying the same key are one step. Typing a label
       * into the panel is one change to the person doing it; it used to push
       * an undo entry per keystroke, so undoing a word meant pressing Alt+Z
       * once per letter and the history filled with nothing else.
       */
      if (coalesce && h.key === coalesce && h.past.length) {
        h.future.length = 0
        return value
      }
      h.past.push(current)
      if (h.past.length > UNDO_LIMIT) h.past.shift()
      h.future.length = 0
      h.key = coalesce ?? null
      setDepth({ undo: h.past.length, redo: 0 })
      return value
    })
  }, [])

  const undo = useCallback(() => {
    const h = history.current
    h.key = null
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
    h.key = null
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
    history.current = { past: [], future: [], key: null }
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

  /**
   * What a gesture may snap to, in document units.
   *
   * A live gesture never re-renders, so this is read through a ref rather
   * than closed over -- and it is kept current during render rather than in
   * an effect, because a gesture that began before the effect ran would
   * otherwise snap against the previous document. `radius` is a screen
   * distance divided by the zoom, so the snap feels the same size at every
   * magnification instead of growing with the picture.
   */
  const anchors = useMemo(() => anchorPoints(doc.shapes), [doc.shapes])
  const snapState = useRef<{ points: Point[]; radius: number }>({ points: [], radius: SNAP_PX })
  snapState.current.points = anchors
  snapState.current.radius = SNAP_PX / zoom

  /**
   * `extra` is offered ahead of the document's own anchors and so wins a tie.
   * It carries the points of the polyline being clicked out, and landing back
   * on its first point -- which is how the shape closes -- has to beat any
   * corner that happens to lie under it.
   */
  const snapPoint = useCallback(
    (p: Point, extra: readonly Point[] = []): { p: Point; hit: boolean } => {
      const { points, radius } = snapState.current
      const hit = nearestAnchor(extra.length ? [...extra, ...points] : points, p, radius)
      return hit ? { p: hit, hit: true } : { p, hit: false }
    },
    [],
  )

  const shape = findShape(doc, selected)
  const editable = shape && isEditable(shape) ? shape : undefined
  const selBounds = editable ? bounds(editable) : null

  // ------------------------------------------------------------------ gestures

  const gesture = useRef<{ mode: Gesture; raf: number; detach: (() => void) | null }>({
    mode: { kind: 'none' }, raf: 0, detach: null,
  })

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

    /** The ring that says the next point will land on an existing one. */
    const showSnap = (at: Point | null) => {
      const mark = snapMarkRef.current
      if (!mark) return
      if (!at) {
        mark.setAttribute('display', 'none')
        return
      }
      mark.setAttribute('cx', String(at.x))
      mark.setAttribute('cy', String(at.y))
      mark.removeAttribute('display')
    }

    switch (mode.kind) {
      case 'draw': {
        const { start, cur } = mode
        if (tool === 'line') {
          showPreview(`M ${start.x} ${start.y} L ${cur.x} ${cur.y}`)
          showSnap(mode.snapped ? cur : null)
          break
        }
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
        showSnap(mode.snapped ? mode.cur : null)
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
    snapMarkRef.current?.setAttribute('display', 'none')
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
        if (tool === 'line') {
          /*
           * Length, not the box: a horizontal line is zero units tall and a
           * vertical one zero wide, so the `w < 2 || h < 2` test below would
           * throw away exactly the two lines people draw most.
           */
          if (Math.hypot(cur.x - start.x, cur.y - start.y) < 2) return
          const id = shapeId()
          commit((d) =>
            addShape(d, {
              kind: 'path',
              id,
              // A line is a stroke. It has no interior to fill, and `null` is
              // also what puts a grabbable hitbox under it -- see `Hitbox`.
              style: { ...style, fill: null },
              rotation: 0,
              closed: false,
              nodes: [start, cur].map((q) => ({
                p: { ...q }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false,
              })),
            }),
          )
          setSelected(id)
          setTool('pick')
          return
        }
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
        // Clicking a node to select it must not also nudge it to the exact
        // pixel clicked -- and leave an undo step behind for doing so. The
        // `move` gesture has always refused a zero-distance drag; this one
        // did not, so merely choosing a node moved it a pixel or two.
        if (samePoint(mode.cur, mode.start)) return
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
        if (m.kind === 'draw') {
          const s = m.snap ? snapPoint(p) : { p, hit: false }
          m.cur = s.p
          m.snapped = s.hit
        } else if (m.kind === 'move' || m.kind === 'resize' || m.kind === 'node') m.cur = p
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
    [finish, schedule, snapPoint, toDocPoint],
  )

  /**
   * Commit the polyline being clicked out. `closed` comes from the last click
   * having landed back on the first point -- every drawing program closes a
   * shape that way, and *Object -> Close curve* afterwards is the long road to
   * the same place.
   */
  const endPolyline = useCallback(
    (points: Point[], closed: boolean) => {
      gesture.current.mode = { kind: 'none' }
      hidePreview()
      if (points.length < 2) return
      const id = shapeId()
      commit((d) =>
        addShape(d, {
          kind: 'path', id, style, rotation: 0, closed,
          nodes: points.map((p) => ({ p, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, smooth: false })),
        }),
      )
      setSelected(id)
      setTool('pick')
    },
    [commit, hidePreview, style],
  )

  /**
   * Type into a text object where it sits on the page.
   *
   * Editing only through the side panel was the whole of it for a long time,
   * and the two gestures a person actually reaches for -- double-click the
   * words, or pick the text tool and click them -- did nothing and silently
   * stacked a second "Text" on top respectively. The field in the panel stays;
   * this is the way that does not have to be found first.
   */
  const beginTextEdit = useCallback((shape: TextShape) => {
    setSelected(shape.id)
    setEditing(shape.id)
    setDraft(shape.text)
  }, [])

  const endTextEdit = useCallback(
    (keep: boolean) => {
      const id = editing
      setEditing(null)
      if (!id || !keep) return
      const shape = findShape(doc, id)
      if (!shape || shape.kind !== 'text' || draft === shape.text) return
      // Emptied on purpose: a text object with no text has no width, cannot be
      // clicked and cannot be seen, so it goes rather than becoming a ghost.
      commit((d) => (draft ? replaceShape(d, { ...shape, text: draft }) : removeShape(d, id)))
      if (!draft) setSelected(null)
    },
    [commit, doc, draft, editing],
  )

  // The input is mounted by the render that starts the edit, so the focus has
  // to wait for it. Selecting the line means typing replaces the placeholder.
  useEffect(() => {
    if (!editing) return
    const el = editorRef.current
    el?.focus()
    el?.select()
  }, [editing])

  /**
   * CorelDRAW's Alt+Q. It lives up here with the gestures rather than with the
   * other menu actions because the node tool's double-click needs it, and a
   * callback declared below this one could not be named in these deps.
   */
  const convertToCurves = useCallback(() => {
    if (!editable) return
    const p = toPath(editable)
    if (!p) return
    commit((d) => replaceShape(d, { ...p, id: editable.id }))
    setTool('node')
  }, [commit, editable])

  /** The path and node the node tool is on, or nothing. */
  const nodePath = editable?.kind === 'path' ? editable : undefined
  const activeNode =
    nodePath && selectedNode !== null ? nodePath.nodes[selectedNode] : undefined

  /**
   * Whether a node op would actually do anything where the selection is.
   *
   * Every one of them hands back the *very same shape* at its boundary --
   * `insertNode` on the last node of an open path has no segment to split,
   * `deleteNode` at the minimum node count has nothing it may remove. Asking
   * the op is exactly right and cannot drift from the rule it enforces, which
   * re-stating the boundary here would.
   */
  const nodeOpApplies = useCallback(
    (fn: (shape: PathShape, index: number) => PathShape) => {
      if (!nodePath || selectedNode === null || !nodePath.nodes[selectedNode]) return false
      return fn(nodePath, selectedNode) !== nodePath
    },
    [nodePath, selectedNode],
  )

  const editNode = useCallback(
    (fn: (shape: PathShape, index: number) => PathShape, after?: number | null) => {
      if (!nodePath || selectedNode === null) return
      const next = fn(nodePath, selectedNode)
      /*
       * Nothing to do, and nothing to record. `replaceShape` builds a new
       * document around even an identical shape, and a new object is what
       * `commit` reads as an edit -- so refusing at the boundary used to cost
       * an undo step that changed nothing, and `after` then moved the
       * selection to a node the op never made.
       */
      if (next === nodePath) return
      commit((d) => replaceShape(d, next))
      if (after !== undefined) setSelectedNode(after)
    },
    [commit, nodePath, selectedNode],
  )

  const toggleSmooth = useCallback(
    (index: number) => {
      if (!nodePath) return
      const node = nodePath.nodes[index]
      if (!node) return
      commit((d) => replaceShape(d, setNodeSmooth(nodePath, index, !node.smooth)))
      setSelectedNode(index)
    },
    [commit, nodePath],
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
          const snap = snapPoint(p, m.points)
          // Back on the first point: close the shape and finish, rather than
          // leaving the user to find *Object -> Close curve*.
          if (m.points.length >= 2 && samePoint(snap.p, m.points[0])) {
            endPolyline(m.points, true)
            return
          }
          // A double-click's own first press lands on the point just placed,
          // and so does a second click on the same snap. Neither is a node.
          if (!samePoint(snap.p, m.points[m.points.length - 1])) m.points.push(snap.p)
          m.cur = snap.p
          m.snapped = snap.hit
          schedule()
        } else {
          const snap = snapPoint(p)
          gesture.current.mode = { kind: 'poly', points: [snap.p], cur: snap.p, snapped: snap.hit }
          // The rubber band has to follow the pointer *between* clicks, so
          // this listener cannot end on the pointerup after its own press the
          // way `beginDrag`'s does -- it lives as long as the line does. That
          // leaves three ways off the window, and it needs all three: it drops
          // itself the moment the gesture stops being a poly, `detach` in the
          // ref is how the unmount cleanup gets it when no move ever comes,
          // and starting a second line detaches the first rather than leaving
          // two listeners writing the same `cur`.
          gesture.current.detach?.()
          const move = (ev: PointerEvent) => {
            const mm = gesture.current.mode
            if (mm.kind !== 'poly') {
              gesture.current.detach?.()
              return
            }
            const s = snapPoint(toDocPoint(ev), mm.points)
            mm.cur = s.p
            mm.snapped = s.hit
            schedule()
          }
          const detach = () => {
            window.removeEventListener('pointermove', move)
            gesture.current.detach = null
          }
          window.addEventListener('pointermove', move)
          gesture.current.detach = detach
        }
        return
      }

      if (tool === 'text') {
        // On an existing line of text, the tool edits it. It used to drop a
        // fresh "Text" on top of it instead, which is what "I cannot edit the
        // text" looks like from the outside.
        const hit = target.closest('[data-id]')
        const under = hit ? findShape(doc, hit.getAttribute('data-id')) : undefined
        if (under?.kind === 'text') {
          e.preventDefault()
          beginTextEdit(under)
          return
        }
        // Without this the browser's own mousedown action moves focus to the
        // body *after* the handler has mounted and focused the editor, and the
        // new object opens for typing and is blurred in the same breath --
        // the Terminal's click-to-focus rule, one more time.
        e.preventDefault()
        const id = shapeId()
        const next: TextShape = {
          kind: 'text', id, style, rotation: 0, x: p.x, y: p.y,
          text: 'Text', ...textStyle,
        }
        commit((d) => addShape(d, next))
        setSelected(id)
        setTool('pick')
        // Straight into the new object, so the placeholder can be typed over
        // rather than hunted for in the panel.
        setEditing(id)
        setDraft('Text')
        return
      }

      if (tool === 'rect' || tool === 'ellipse' || tool === 'line') {
        e.preventDefault()
        const snap = tool === 'line'
        const from = snap ? snapPoint(p) : { p, hit: false }
        beginDrag({ kind: 'draw', start: from.p, cur: from.p, snap, snapped: from.hit })
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
        setSelectedNode(Number(index))
        beginDrag({
          kind: 'node', id: editable.id, index: Number(index),
          part: part as 'p' | 'in' | 'out', start: p, cur: p,
        })
        return
      }

      /*
       * The overlay is the selected shape's own chrome and it paints *over*
       * the artwork -- the node tool's segment stripes are seven document
       * units wide and lie along the curve. A press on one is a press on the
       * shape it belongs to, never on the background behind it. Letting it
       * fall through to the deselect below is what made clicking your own
       * curve throw the nodes away, and what stopped a double-click from ever
       * inserting one: the double-click's own first press deselected the path,
       * so `onDoubleClick` found nothing to split.
       */
      if (target.closest('.draw-overlay') && editable) {
        e.preventDefault()
        if (tool === 'pick') beginDrag({ kind: 'move', id: editable.id, start: p, cur: p })
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
    [
      beginDrag, beginTextEdit, commit, doc, editable, endPolyline, schedule, snapPoint, style,
      textStyle, toDocPoint, tool,
    ],
  )

  /**
   * Double-click ends a polyline, splits a segment under the node tool, and --
   * on a shape that has no nodes to split -- converts it to curves, which is
   * what a double-click with the shape tool means in CorelDRAW too. Without
   * that last one the node tool does nothing at all to the two shapes people
   * draw most, and so reads as broken.
   */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const m = gesture.current.mode
      if (m.kind === 'poly') {
        endPolyline(m.points, false)
        return
      }
      // Double-click is "edit this" everywhere else here, and on a line of
      // text that means typing it, whichever tool is up.
      if (editable?.kind === 'text') {
        beginTextEdit(editable)
        return
      }
      if (tool !== 'node' || !editable) return
      if (editable.kind === 'path') {
        // A node double-clicked is a node made smooth, or made a cusp again --
        // the gesture that pairs with double-clicking a segment to add one.
        const nodeEl = (e.target as Element).closest('[data-node]')
        if (nodeEl) {
          toggleSmooth(Number(nodeEl.getAttribute('data-node')!.split(':')[0]))
          return
        }
        const seg = (e.target as Element).closest('[data-seg]')
        if (!seg) return
        const at = Number(seg.getAttribute('data-seg'))
        commit((d) => replaceShape(d, insertNode(editable, at)))
        // `insertNode` puts the new node just after the segment it split, and
        // it is the one you now want to drag.
        setSelectedNode(at + 1)
        return
      }
      convertToCurves()
    },
    [beginTextEdit, commit, convertToCurves, editable, endPolyline, toggleSmooth, tool],
  )

  useEffect(() => () => {
    if (gesture.current.raf) cancelAnimationFrame(gesture.current.raf)
    gesture.current.detach?.()
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

  /**
   * Size and face, the same bargain `setSelectedStyle` strikes: the panel
   * keeps what was last chosen and hands it to the next text placed, and a
   * selected object takes the change immediately. Keyed so that nudging the
   * size spinner is one undo step rather than one per press.
   */
  const setText = useCallback(
    (patch: Partial<typeof DEFAULT_TEXT>) => {
      setTextStyle((t) => ({ ...t, ...patch }))
      if (editable?.kind === 'text') {
        commit((d) => replaceShape(d, { ...editable, ...patch }), `text-style:${editable.id}`)
      }
    },
    [commit, editable],
  )

  /** The selection wins over the tool's own, as it does for fill and outline. */
  const shownText = editable?.kind === 'text' ? editable : textStyle

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
          /*
           * All three act on the node the node tool has selected, and are
           * disabled until there is one. They used to act on a hardcoded index
           * -- the last node for delete, the first for smooth -- so they moved
           * a node nobody had pointed at.
           */
          {
            label: 'Insert node',
            disabled: !nodeOpApplies(insertNode),
            onSelect: () => editNode(insertNode, (selectedNode ?? 0) + 1),
          },
          {
            label: 'Delete node',
            disabled: !nodeOpApplies(deleteNode),
            onSelect: () => editNode(deleteNode, null),
          },
          {
            label: activeNode?.smooth ? 'Cusp node' : 'Smooth node',
            disabled: !activeNode,
            onSelect: () => {
              if (selectedNode !== null) toggleSmooth(selectedNode)
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
      activeNode, convertToCurves, commit, depth, dirty, duplicate, editNode, editable, exportToHost,
      newDrawing, nodeOpApplies, open, path, redo, remove, requestClose, save, saveAs, selected,
      selectedNode, toggleSmooth, undo, windowId, withSelected, zoom,
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
        const m = gesture.current.mode
        // While a polyline is being clicked out, Backspace takes back the last
        // point. Deleting the selected object instead would be a surprise, and
        // there is no other way to undo a mis-aimed click mid-line.
        if (m.kind === 'poly') {
          m.points.pop()
          if (!m.points.length) {
            gesture.current.mode = { kind: 'none' }
            hidePreview()
            return
          }
          m.cur = m.points[m.points.length - 1]
          m.snapped = false
          schedule()
          return
        }
        // Under the node tool a chosen node is the smaller thing to delete,
        // and deleting the whole path instead would be a nasty surprise.
        if (tool === 'node' && nodePath && selectedNode !== null) {
          editNode(deleteNode, null)
          return
        }
        remove()
      } else if (e.key === 'Escape') {
        // Abandons a polyline in progress; otherwise just drops the selection.
        gesture.current.mode = { kind: 'none' }
        hidePreview()
        setSelected(null)
      } else if (e.key === 'Enter' && gesture.current.mode.kind === 'poly') {
        e.preventDefault()
        endPolyline(gesture.current.mode.points, false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    convertToCurves, duplicate, editNode, endPolyline, hidePreview, isActive, newDrawing, nodePath,
    open, redo, remove, save, schedule, selectedNode, tool, undo,
  ])

  // ------------------------------------------------------------------ status

  /**
   * The status line, derived rather than stored -- there is nothing in it that
   * is not already a render's worth of state.
   *
   * A drawing tool says what to do with it, because until the first click
   * there is nothing else worth showing and the polyline's several endings
   * have to be written down somewhere. Pick and the node tool describe the
   * selection instead, since that is what they act on -- and the node tool
   * adds the one sentence that turns "this tool does nothing" into an
   * instruction.
   */
  const status = useMemo(() => {
    const hint = TOOLS.find((t) => t.id === tool)?.status
    if (hint) return hint
    if (!editable) {
      if (tool === 'node') return 'Click a curve to edit its nodes.'
      return `${doc.shapes.length} object${doc.shapes.length === 1 ? '' : 's'}`
    }
    const b = bounds(editable)
    const name = editable.kind[0].toUpperCase() + editable.kind.slice(1)
    const geometry =
      `${name}   x ${Math.round(b.x)}  y ${Math.round(b.y)}  w ${Math.round(b.w)}  h ${Math.round(b.h)}` +
      (editable.rotation ? `  ${Math.round(editable.rotation)}°` : '')
    if (tool === 'node' && editable.kind === 'path') {
      const count = editable.nodes.length
      if (activeNode && selectedNode !== null) {
        return (
          `${geometry}   —   node ${selectedNode + 1} of ${count}, ` +
          `${activeNode.smooth ? 'smooth' : 'a cusp'} — double-click it to change that`
        )
      }
      return `${geometry}   —   click a node, or double-click the curve to add one`
    }
    if (tool !== 'node') return geometry
    return editable.kind === 'text'
      ? `${geometry}   —   text has no nodes to edit`
      : `${geometry}   —   double-click to convert it to curves`
  }, [activeNode, doc.shapes.length, editable, selectedNode, tool])

  // ------------------------------------------------------------------ render

  /**
   * The text being typed into, and the box the editor sits in. The width
   * follows the *draft*, so the field grows with the line instead of being
   * clipped at whatever the old text measured.
   */
  const editingShape = findShape(doc, editing)
  const editingText = editingShape?.kind === 'text' ? editingShape : undefined
  const editBox = useMemo(() => {
    if (!editingText) return { x: 0, y: 0, w: 0, h: 0 }
    const b = bounds(editingText)
    const wide = Math.max(b.w, draft.length * editingText.fontSize * 0.6)
    return { x: b.x, y: b.y, w: wide + editingText.fontSize * 2, h: editingText.fontSize * 1.6 }
  }, [draft, editingText])

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
              <ToolGlyph id={t.id} />
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
              <ShapeView key={s.id} shape={s} gradId={gradIds[s.id]} muted={editing === s.id} />
            ))}

            <g className="draw-overlay" ref={overlayRef}>
              {editable &&
                selBounds &&
                (tool !== 'node' ? (
                  <SelectionHandles shape={editable} size={handleSize} />
                ) : editable.kind === 'path' ? (
                  <NodeHandles shape={editable} size={handleSize} active={selectedNode} />
                ) : (
                  /*
                   * The node tool has nothing to edit on a rect, an ellipse or
                   * a line of text -- but drawing nothing at all is what made
                   * it look broken. The selection stays outlined and the
                   * status line says how to get nodes out of it.
                   */
                  <SelectionOutline shape={editable} />
                ))}
            </g>

            <path ref={previewRef} className="draw-preview" display="none" />
            {/* The snap ring: one element, moved by the gesture, never re-rendered. */}
            <circle ref={snapMarkRef} className="draw-snap" r={5 / zoom} display="none" />

            {/*
              * Typing happens inside the `<svg>`, in document units, so the
              * viewBox does the zoom arithmetic and there is no screen-space
              * maths to get wrong -- the same reason `toDocPoint` is arithmetic
              * rather than a CTM. The box is sized from the draft rather than
              * the shape, or it would stop growing as you type.
              */}
            {editingText && (
              <foreignObject
                x={editBox.x}
                y={editBox.y}
                width={editBox.w}
                height={editBox.h}
              >
                <input
                  ref={editorRef}
                  className="draw-textedit"
                  aria-label="Edit text"
                  value={draft}
                  style={{
                    fontFamily: editingText.fontFamily,
                    fontSize: `${editingText.fontSize}px`,
                  }}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => endTextEdit(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      endTextEdit(true)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      endTextEdit(false)
                    }
                  }}
                />
              </foreignObject>
            )}
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
          {(editable?.kind === 'text' || tool === 'text') && (
            <Box label="Text">
              {editable?.kind === 'text' && (
                <TextControl
                  value={editable.text}
                  aria-label="Text content"
                  onChange={(e) =>
                    commit(
                      (d) => replaceShape(d, { ...editable, text: e.target.value }),
                      `text:${editable.id}`,
                    )
                  }
                />
              )}
              <label className="draw-field">
                <span>Size</span>
                <TextControl
                  type="number"
                  min={1}
                  max={400}
                  step={2}
                  value={shownText.fontSize}
                  aria-label="Font size"
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n) && n > 0) setText({ fontSize: Math.min(400, n) })
                  }}
                />
              </label>
              {/* Three faces, drawn as the Fill box draws Flat / Lin / Rad. */}
              <div className="draw-sublabel">Font</div>
              <div className="draw-modes" role="group" aria-label="Font">
                {FONTS.map((f) => (
                  <button
                    key={f.label}
                    type="button"
                    className="b-button draw-mode"
                    data-active={shownText.fontFamily === f.value}
                    aria-pressed={shownText.fontFamily === f.value}
                    aria-label={f.label}
                    onClick={() => setText({ fontFamily: f.value })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
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

/**
 * The toolbox glyphs, drawn on a 16-unit grid.
 *
 * They were single characters once, and `◇` for the node tool sat between
 * `▭` and `◯` and read as "draw a diamond": people picked it, dragged, and got
 * nothing, because it edits the nodes of a curve that already exists. No
 * character in the font says "a curve with nodes on it", so these are drawn --
 * original artwork, like `lib/icons.tsx`, and for the same reason.
 *
 * Colour comes from `currentColor`, so a disabled or inverted button takes the
 * glyph with it and neither theme needs a second copy.
 */
function ToolGlyph({ id }: { id: Tool }) {
  const box = { viewBox: '0 0 16 16', className: 'draw-glyph', 'aria-hidden': true } as const
  switch (id) {
    case 'pick':
      // The arrow cursor itself, which is what the tool hands back.
      return (
        <svg {...box}>
          <path
            className="draw-glyph-solid"
            d="M4 2 L4 13.2 L6.9 10.5 L8.7 14.3 L10.6 13.4 L8.8 9.7 L12.4 9.4 Z"
          />
        </svg>
      )
    case 'node':
      // A curve with a node at each end: what the tool acts on, and what it
      // gives you the moment a shape is converted.
      return (
        <svg {...box}>
          <path className="draw-glyph-line" d="M3 12.4 C3 5.4 13 10.6 13 3.6" />
          <rect className="draw-glyph-solid" x="1.4" y="10.8" width="3.2" height="3.2" />
          <rect className="draw-glyph-solid" x="11.4" y="2" width="3.2" height="3.2" />
        </svg>
      )
    case 'rect':
      return (
        <svg {...box}>
          <rect className="draw-glyph-line" x="2.5" y="4" width="11" height="8" />
        </svg>
      )
    case 'ellipse':
      return (
        <svg {...box}>
          <circle className="draw-glyph-line" cx="8" cy="8" r="5.5" />
        </svg>
      )
    case 'line':
      // Straight, against the polyline's bend: that is the whole difference
      // between the two, so it is the whole difference between the glyphs.
      return (
        <svg {...box}>
          <path className="draw-glyph-line" d="M3.4 12.6 L12.6 3.4" />
          <circle className="draw-glyph-solid" cx="3.4" cy="12.6" r="1.7" />
          <circle className="draw-glyph-solid" cx="12.6" cy="3.4" r="1.7" />
        </svg>
      )
    case 'polyline':
      // The vertices are drawn, because they are also what a click snaps to.
      return (
        <svg {...box}>
          <path className="draw-glyph-line" d="M2.9 12.6 L6.9 4.3 L13.1 9.2" />
          <circle className="draw-glyph-solid" cx="2.9" cy="12.6" r="1.7" />
          <circle className="draw-glyph-solid" cx="6.9" cy="4.3" r="1.7" />
          <circle className="draw-glyph-solid" cx="13.1" cy="9.2" r="1.7" />
        </svg>
      )
    case 'freehand':
      return (
        <svg {...box}>
          <path className="draw-glyph-line" d="M2.6 13.4 L3.7 10.1 L10.4 3.4 L12.6 5.6 L5.9 12.3 Z" />
          <path className="draw-glyph-line" d="M3.7 10.1 L5.9 12.3" />
        </svg>
      )
    case 'text':
      return (
        <svg {...box}>
          <path className="draw-glyph-line" d="M3.4 13.2 L8 2.8 L12.6 13.2 M5.3 9.4 L10.7 9.4" />
        </svg>
      )
  }
}

function ShapeView({
  shape,
  gradId,
  muted,
}: {
  shape: Shape
  gradId?: string
  /** Being typed into: the editor stands in for it, so it is not drawn twice. */
  muted?: boolean
}) {
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
    <g data-id={shape.id} transform={restTransform(shape)} visibility={muted ? 'hidden' : undefined}>
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

/** How wide a click target an unfilled path gets, in document units. */
const HIT_WIDTH = 8

/** An invisible, filled copy of the shape, purely so clicks land on it. */
function Hitbox({ shape }: { shape: Shape }) {
  if (shape.kind === 'rect') {
    return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill="transparent" stroke="none" />
  }
  if (shape.kind === 'ellipse') {
    return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill="transparent" stroke="none" />
  }
  if (shape.kind === 'path') {
    /*
     * Along the stroke, not just inside it. An unfilled path encloses no area
     * -- a line encloses none at all -- so a filled copy catches nothing and
     * the only target was the stroke itself, one document unit wide by
     * default. This lays a fat transparent stroke over the same curve.
     */
    return (
      <path
        d={pathData(shape)}
        fill="transparent"
        stroke="transparent"
        strokeWidth={Math.max(HIT_WIDTH, shape.style.strokeWidth)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  }
  return null
}

/** The marching-ants outline on its own, with no handles around it. */
function SelectionOutline({ shape }: { shape: Shape }) {
  const pts = corners(shape)
  return (
    <path
      className="draw-marchers"
      d={`M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`}
      fill="none"
    />
  )
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
      <SelectionOutline shape={shape} />
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

function NodeHandles({
  shape,
  size,
  active,
}: {
  shape: PathShape
  size: number
  active: number | null
}) {
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
          {/* The chosen node is drawn larger as well as marked, because the
              menu and the Delete key act on it and nothing else says which. */}
          <rect
            className="draw-node"
            data-node={`${i}:p`}
            data-smooth={node.smooth}
            data-active={i === active}
            x={node.p.x - (i === active ? size * 0.7 : size / 2)}
            y={node.p.y - (i === active ? size * 0.7 : size / 2)}
            width={i === active ? size * 1.4 : size}
            height={i === active ? size * 1.4 : size}
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
  extensions: ['.svg'],
})
