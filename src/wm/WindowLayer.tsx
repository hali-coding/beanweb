import { useShallow } from 'zustand/react/shallow'
import { useDesktop } from '@/store/desktop'
import { BWindow } from './BWindow'

/**
 * Renders every open window.
 *
 * Selects only the id list (shallow-compared) plus the active id, so moving or
 * resizing a window never re-renders this component -- just the one window that
 * actually changed.
 */
export function WindowLayer() {
  const order = useDesktop(useShallow((s) => s.order))
  const activeId = useDesktop((s) => s.activeId)

  // On mobile only one window is visible; it is the highest-z live window.
  // Returns a plain id, so the default Object.is comparison is enough.
  const frontId = useDesktop((s) => {
    let best: string | null = null
    let bestZ = -1
    for (const id of s.order) {
      const w = s.windows[id]
      if (w && !w.minimized && w.z > bestZ) {
        bestZ = w.z
        best = id
      }
    }
    return best
  })

  return (
    <div className="b-window-layer">
      {order.map((id) => (
        <BWindow key={id} id={id} active={id === activeId} front={id === frontId} />
      ))}
    </div>
  )
}
