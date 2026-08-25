import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { LeafIcon } from '@/lib/icons'
import { MenuPanel } from '@/widgets/Menu'
import type { MenuItem } from '@/widgets/Menu'
import { getApp, launchApp, listApps } from '@/apps/registry'
import { useDesktop } from '@/store/desktop'
import { useViewport } from '@/wm/useViewport'

/** Ticks once a second, isolated so the rest of the Deskbar never re-renders. */
function Clock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    // Align the first tick to the next whole second so the display never
    // visibly skips a number.
    let interval: number | undefined
    const timeout = setTimeout(() => {
      setNow(new Date())
      interval = setInterval(() => setNow(new Date()), 1000) as unknown as number
    }, 1000 - (Date.now() % 1000)) as unknown as number

    return () => {
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [])

  return (
    <>
      <time className="b-deskbar-clock" dateTime={now.toISOString()}>
        {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </time>
      <span className="b-deskbar-date">
        {now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
      </span>
    </>
  )
}

export function Deskbar() {
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const logoRef = useRef<HTMLButtonElement>(null)
  const viewport = useViewport()

  // Select the raw slices and derive here. Mapping to fresh objects *inside* a
  // useShallow selector would allocate new elements on every call, so the
  // shallow compare could never match and the store would look permanently
  // dirty -- an infinite render loop.
  const order = useDesktop(useShallow((s) => s.order))
  const windows = useDesktop((s) => s.windows)
  const running = useMemo(
    () => order.map((id) => windows[id]).filter(Boolean),
    [order, windows],
  )
  const activeId = useDesktop((s) => s.activeId)
  const focusWindow = useDesktop((s) => s.focusWindow)
  const minimizeWindow = useDesktop((s) => s.minimizeWindow)

  const items: MenuItem[] = useMemo(
    () => [
      ...listApps().map((app) => ({
        label: app.name,
        onSelect: () => launchApp(app.id),
      })),
      { separator: true },
      { label: 'About BeanWeb…', onSelect: () => launchApp('about') },
    ],
    [],
  )

  const onAppClick = useCallback(
    (id: string, minimized: boolean) => {
      // Clicking the active entry hides it again, the way the Deskbar behaves.
      if (id === activeId && !minimized) minimizeWindow(id, true)
      else {
        minimizeWindow(id, false)
        focusWindow(id)
      }
    },
    [activeId, focusWindow, minimizeWindow],
  )

  return (
    <div className="b-deskbar">
      <button
        ref={logoRef}
        type="button"
        className="b-deskbar-logo"
        data-open={Boolean(menuAnchor)}
        aria-haspopup="menu"
        aria-expanded={Boolean(menuAnchor)}
        aria-label="Applications"
        onPointerDown={(e) => {
          e.preventDefault()
          setMenuAnchor(menuAnchor ? null : e.currentTarget.getBoundingClientRect())
        }}
      >
        <LeafIcon size={16} />
        <span className="b-deskbar-logo-text">BeanWeb</span>
      </button>

      <div className="b-deskbar-tray">
        <Clock />
      </div>

      <div className="b-deskbar-apps">
        {running.map((win) => {
          const app = getApp(win.appId)
          const Icon = app?.icon
          return (
            <button
              key={win.id}
              type="button"
              className="b-deskbar-app"
              data-active={win.id === activeId && !win.minimized}
              title={win.title}
              onClick={() => onAppClick(win.id, win.minimized)}
            >
              {Icon ? <Icon size={16} className="b-deskbar-app-icon" /> : null}
              <span className="b-deskbar-app-name">{win.title}</span>
            </button>
          )
        })}
      </div>

      {menuAnchor ? (
        <MenuPanel
          items={items}
          anchor={menuAnchor}
          align={viewport.mobile ? 'below' : 'left-of'}
          onClose={() => setMenuAnchor(null)}
        />
      ) : null}
    </div>
  )
}
