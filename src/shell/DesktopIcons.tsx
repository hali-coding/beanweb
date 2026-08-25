import { useCallback, useRef, useState } from 'react'
import { DiskIcon, FolderIcon, TerminalIcon, TrashIcon } from '@/lib/icons'
import type { IconProps } from '@/lib/icons'
import { launchApp } from '@/apps/registry'
import { useDesktop } from '@/store/desktop'

interface DeskIcon {
  id: string
  label: string
  Icon: (props: IconProps) => React.JSX.Element
  x: number
  y: number
  open: () => void | Promise<void>
}

const openTrash = () =>
  useDesktop
    .getState()
    .showAlert('info', 'Trash', 'The Trash is empty.\n\nNothing you delete here is recoverable anyway.')

const INITIAL: DeskIcon[] = [
  {
    id: 'disk',
    label: 'beanweb',
    Icon: DiskIcon,
    x: 16,
    y: 16,
    open: () => void launchApp('tracker', { path: '/' }, 'beanweb'),
  },
  {
    id: 'home',
    label: 'home',
    Icon: FolderIcon,
    x: 16,
    y: 92,
    open: () => void launchApp('tracker', { path: '/boot/home' }, 'home'),
  },
  {
    id: 'terminal',
    label: 'Terminal',
    Icon: TerminalIcon,
    x: 16,
    y: 168,
    open: () => void launchApp('terminal'),
  },
  { id: 'trash', label: 'Trash', Icon: TrashIcon, x: 16, y: 244, open: () => void openTrash() },
]

/** True when the primary input has no hover, i.e. a touchscreen. */
const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

export function DesktopIcons() {
  const [icons, setIcons] = useState(INITIAL)
  const [selected, setSelected] = useState<string | null>(null)

  // Same approach as windows: the DOM leads during the drag, state trails.
  const drag = useRef({ id: '', startX: 0, startY: 0, baseX: 0, baseY: 0, x: 0, y: 0, moved: false })

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, icon: DeskIcon) => {
      if (e.button !== 0) return
      setSelected(icon.id)
      const el = e.currentTarget
      const d = drag.current
      Object.assign(d, {
        id: icon.id,
        startX: e.clientX,
        startY: e.clientY,
        baseX: icon.x,
        baseY: icon.y,
        x: icon.x,
        y: icon.y,
        moved: false,
      })

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - d.startX
        const dy = ev.clientY - d.startY
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
        d.moved = true
        d.x = Math.max(0, d.baseX + dx)
        d.y = Math.max(0, d.baseY + dy)
        el.style.transform = `translate3d(${d.x}px, ${d.y}px, 0)`
      }

      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        if (d.moved) {
          setIcons((prev) => prev.map((i) => (i.id === d.id ? { ...i, x: d.x, y: d.y } : i)))
        } else if (coarse) {
          // A tap is an open on touch; there is no double-click to wait for.
          void icon.open()
        }
      }

      window.addEventListener('pointermove', move, { passive: true })
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [],
  )

  return (
    <div className="b-desktop-icons" onPointerDown={() => setSelected(null)}>
      {icons.map((icon) => (
        <button
          key={icon.id}
          type="button"
          className="b-desktop-icon"
          data-selected={selected === icon.id}
          style={{ transform: `translate3d(${icon.x}px, ${icon.y}px, 0)` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            onPointerDown(e, icon)
          }}
          onDoubleClick={() => void icon.open()}
        >
          <icon.Icon size={32} className="b-desktop-icon-glyph" />
          <span className="b-desktop-icon-label">{icon.label}</span>
        </button>
      ))}
    </div>
  )
}
