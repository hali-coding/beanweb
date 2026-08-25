import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { Rect } from '@/lib/types'
import { useDesktop } from '@/store/desktop'

/**
 * Drag and resize for a window.
 *
 * The whole point of this hook is that a live gesture performs ZERO React
 * renders. pointerdown snapshots the rect, pointermove writes the new geometry
 * straight onto the DOM node inside a rAF, and only pointerup commits the final
 * rect to the store. Dragging a window with fifty other windows open therefore
 * costs one transform write per frame, no reconciliation at all.
 */

export interface ResizeDir {
  left?: boolean
  top?: boolean
  right?: boolean
  bottom?: boolean
}

type Mode = { kind: 'move' } | { kind: 'resize'; dir: ResizeDir } | { kind: 'tab' }

interface GestureArgs {
  id: string
  elRef: RefObject<HTMLDivElement | null>
  rect: Rect
  minW: number
  minH: number
  /** Slide offset of the tab along the window's top edge (R5 shift-drag). */
  tabOffsetRef: RefObject<number>
  onTabOffset: (px: number) => void
}

export function applyRect(el: HTMLElement, r: Rect) {
  el.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`
  el.style.width = `${r.w}px`
  el.style.height = `${r.h}px`
}

export function useWindowGesture({
  id,
  elRef,
  rect,
  minW,
  minH,
  tabOffsetRef,
  onTabOffset,
}: GestureArgs) {
  const commitRect = useDesktop((s) => s.commitRect)
  const focusWindow = useDesktop((s) => s.focusWindow)

  // Mutable gesture scratch space; never triggers a render.
  const g = useRef({
    active: false,
    mode: { kind: 'move' } as Mode,
    startX: 0,
    startY: 0,
    start: rect,
    startTabOffset: 0,
    next: rect,
    nextTabOffset: 0,
    frame: 0,
    maxTabOffset: 0,
  })

  // Keep the snapshot source current without re-binding listeners.
  const rectRef = useRef(rect)
  rectRef.current = rect

  const flush = useCallback(() => {
    g.current.frame = 0
    const el = elRef.current
    if (!el) return
    if (g.current.mode.kind === 'tab') {
      const tab = el.querySelector<HTMLElement>('.b-window-tab')
      if (tab) tab.style.marginLeft = `${g.current.nextTabOffset}px`
    } else {
      applyRect(el, g.current.next)
    }
  }, [elRef])

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const s = g.current
      if (!s.active) return
      const dx = e.clientX - s.startX
      const dy = e.clientY - s.startY

      if (s.mode.kind === 'tab') {
        s.nextTabOffset = Math.max(0, Math.min(s.maxTabOffset, s.startTabOffset + dx))
      } else if (s.mode.kind === 'move') {
        s.next = {
          ...s.start,
          x: s.start.x + dx,
          // Never let the tab escape above the top edge; it would be ungrabbable.
          y: Math.max(0, s.start.y + dy),
        }
      } else {
        const d = s.mode.dir
        let { x, y, w, h } = s.start
        if (d.right) w = Math.max(minW, s.start.w + dx)
        if (d.bottom) h = Math.max(minH, s.start.h + dy)
        if (d.left) {
          w = Math.max(minW, s.start.w - dx)
          x = s.start.x + (s.start.w - w)
        }
        if (d.top) {
          h = Math.max(minH, s.start.h - dy)
          y = s.start.y + (s.start.h - h)
        }
        s.next = { x, y, w, h }
      }

      // Coalesce multiple pointermoves per frame into a single style write.
      if (!s.frame) s.frame = requestAnimationFrame(flush)
    },
    [flush, minH, minW],
  )

  const onPointerUp = useCallback(() => {
    const s = g.current
    if (!s.active) return
    s.active = false
    if (s.frame) {
      cancelAnimationFrame(s.frame)
      s.frame = 0
    }
    flush()

    const el = elRef.current
    el?.classList.remove('b-window--dragging', 'b-window--resizing')

    if (s.mode.kind === 'tab') {
      onTabOffset(s.nextTabOffset)
    } else {
      commitRect(id, s.next)
    }

    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }, [commitRect, elRef, flush, id, onPointerMove, onTabOffset])

  const begin = useCallback(
    (e: React.PointerEvent, mode: Mode) => {
      // Ignore secondary buttons and any gesture already in flight.
      if (e.button !== 0 || g.current.active) return
      const el = elRef.current
      if (!el) return

      focusWindow(id)

      const s = g.current
      s.active = true
      s.mode = mode
      s.startX = e.clientX
      s.startY = e.clientY
      s.start = rectRef.current
      s.next = rectRef.current
      s.startTabOffset = tabOffsetRef.current
      s.nextTabOffset = tabOffsetRef.current

      if (mode.kind === 'tab') {
        const tab = el.querySelector<HTMLElement>('.b-window-tab')
        s.maxTabOffset = Math.max(0, el.offsetWidth - (tab?.offsetWidth ?? 0))
      }

      el.classList.add(mode.kind === 'resize' ? 'b-window--resizing' : 'b-window--dragging')

      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
      e.preventDefault()
    },
    [elRef, focusWindow, id, onPointerMove, onPointerUp, tabOffsetRef],
  )

  // A window unmounting mid-drag must not leave listeners behind.
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    },
    [onPointerMove, onPointerUp],
  )

  const onTabPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // R5 slides the tab along the top edge when the drag is modifier-held.
      begin(e, e.shiftKey ? { kind: 'tab' } : { kind: 'move' })
    },
    [begin],
  )

  const onResizePointerDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => begin(e, { kind: 'resize', dir }),
    [begin],
  )

  return { onTabPointerDown, onResizePointerDown }
}
