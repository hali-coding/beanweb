import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { selectWindow, useDesktop } from '@/store/desktop'
import { getApp } from '@/apps/registry'
import { useViewport } from './useViewport'
import { useWindowGesture, applyRect } from './useWindowGesture'

interface Props {
  id: string
  active: boolean
  front: boolean
}

/**
 * One R5 window: a partial-width yellow tab sitting on a beveled grey frame.
 *
 * Memoised on (id, active, front). Because gestures write to the DOM directly,
 * this component only re-renders when the window is focused, retitled, zoomed,
 * or when a drag commits -- never during one.
 */
function BWindowImpl({ id, active, front }: Props) {
  const win = useDesktop(selectWindow(id))
  const requestClose = useDesktop((s) => s.requestClose)
  const focusWindow = useDesktop((s) => s.focusWindow)
  const toggleZoom = useDesktop((s) => s.toggleZoom)
  const viewport = useViewport()

  const elRef = useRef<HTMLDivElement>(null)
  const [tabOffset, setTabOffset] = useState(0)
  const tabOffsetRef = useRef(0)
  tabOffsetRef.current = tabOffset

  const { onTabPointerDown, onResizePointerDown } = useWindowGesture({
    id,
    elRef,
    rect: win?.rect ?? { x: 0, y: 0, w: 0, h: 0 },
    minW: win?.minW ?? 220,
    minH: win?.minH ?? 120,
    tabOffsetRef,
    onTabOffset: setTabOffset,
  })

  // Re-assert geometry after any render that changed it (zoom, restore, open).
  // The DOM is the source of truth mid-drag, so this only runs between drags.
  useEffect(() => {
    const el = elRef.current
    if (el && win && !viewport.mobile) applyRect(el, win.rect)
  }, [win, viewport.mobile])

  const onZoom = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      toggleZoom(id, viewport)
    },
    [id, toggleZoom, viewport],
  )

  const onClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void requestClose(id)
    },
    [requestClose, id],
  )

  if (!win) return null

  const app = getApp(win.appId)
  const Content = app?.component

  const className = [
    'b-window',
    active && 'b-window--active',
    front && 'b-window--front',
    win.minimized && 'b-window--minimized',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={elRef}
      className={className}
      style={{
        transform: `translate3d(${win.rect.x}px, ${win.rect.y}px, 0)`,
        width: win.rect.w,
        height: win.rect.h,
        zIndex: win.z,
      }}
      onPointerDownCapture={() => focusWindow(id)}
      role="dialog"
      aria-label={win.title}
      aria-modal={false}
    >
      <div className="b-window-tabrow">
        <div
          className="b-window-tab"
          style={{ marginLeft: tabOffset }}
          onPointerDown={onTabPointerDown}
          onDoubleClick={onZoom}
        >
          <button
            type="button"
            className="b-window-widget b-window-close"
            aria-label={`Close ${win.title}`}
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <span className="b-window-title">{win.title}</span>
          <button
            type="button"
            className="b-window-widget b-window-zoom"
            aria-label={`Zoom ${win.title}`}
            onClick={onZoom}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>

      <div className="b-window-frame">
        <div className="b-window-content">
          {Content ? <Content windowId={id} args={win.args} /> : null}
        </div>

        <div className="b-resize-edge b-resize-edge--n" onPointerDown={onResizePointerDown({ top: true })} />
        <div className="b-resize-edge b-resize-edge--s" onPointerDown={onResizePointerDown({ bottom: true })} />
        <div className="b-resize-edge b-resize-edge--w" onPointerDown={onResizePointerDown({ left: true })} />
        <div className="b-resize-edge b-resize-edge--e" onPointerDown={onResizePointerDown({ right: true })} />
        <div
          className="b-window-resize"
          onPointerDown={onResizePointerDown({ right: true, bottom: true })}
          aria-hidden
        />
      </div>
    </div>
  )
}

export const BWindow = memo(BWindowImpl)
