import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label?: string
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  onSelect?: () => void
}

export interface MenuDef {
  title: string
  items: MenuItem[]
}

interface MenuPanelProps {
  items: MenuItem[]
  anchor: DOMRect
  onClose: () => void
  /** Align the panel under the anchor (menu bar) or to its left edge (Deskbar). */
  align?: 'below' | 'left-of'
}

/**
 * The dropdown itself. Rendered into document.body so it is never clipped by a
 * window's `overflow: hidden` content box.
 */
export function MenuPanel({ items, anchor, onClose, align = 'below' }: MenuPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: align === 'below' ? anchor.left : anchor.left,
    top: align === 'below' ? anchor.bottom : anchor.top,
  })

  // Measure once mounted, then nudge back on-screen if the panel overflows.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    let left = align === 'below' ? anchor.left : anchor.left - width
    let top = align === 'below' ? anchor.bottom : anchor.top

    if (left + width > window.innerWidth - 4) left = window.innerWidth - width - 4
    if (left < 4) left = 4
    if (top + height > window.innerHeight - 4) {
      top = align === 'below' ? anchor.top - height : window.innerHeight - height - 4
    }
    if (top < 4) top = 4
    setPos({ left, top })
  }, [anchor, align])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture phase: close before the click can land on whatever is underneath.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="b-menu" style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="b-menu-separator" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className="b-menu-item"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect?.()
            }}
          >
            <span className="b-menu-item-mark">{item.checked ? '•' : ''}</span>
            <span>{item.label}</span>
            {item.shortcut ? (
              <span className="b-menu-item-shortcut">{item.shortcut}</span>
            ) : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

/** A window's menu bar. Once open, hovering a sibling title switches menus. */
export function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const openAt = useCallback((index: number, el: HTMLElement) => {
    setAnchor(el.getBoundingClientRect())
    setOpen(index)
  }, [])

  const close = useCallback(() => {
    setOpen(null)
    setAnchor(null)
  }, [])

  return (
    <div className="b-menubar" ref={barRef} role="menubar">
      {menus.map((menu, i) => (
        <button
          key={menu.title}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === i}
          className="b-menubar-item"
          data-open={open === i}
          onPointerDown={(e) => {
            e.preventDefault()
            if (open === i) close()
            else openAt(i, e.currentTarget)
          }}
          onPointerEnter={(e) => {
            if (open !== null && open !== i) openAt(i, e.currentTarget)
          }}
        >
          {menu.title}
        </button>
      ))}
      {open !== null && anchor ? (
        <MenuPanel items={menus[open].items} anchor={anchor} onClose={close} />
      ) : null}
    </div>
  )
}
