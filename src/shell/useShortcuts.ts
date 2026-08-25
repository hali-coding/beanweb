import { useEffect } from 'react'
import { useDesktop } from '@/store/desktop'

/**
 * Desktop-wide keys. R5 used Alt where most systems use Control, so these
 * deliberately bind Alt and leave Ctrl alone for the browser.
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return
      const state = useDesktop.getState()

      if (e.key.toLowerCase() === 'w') {
        if (!state.activeId) return
        e.preventDefault()
        void state.requestClose(state.activeId)
        return
      }

      if (e.key === 'Tab') {
        const live = state.order
          .map((id) => state.windows[id])
          .filter((w) => w && !w.minimized)
          .sort((a, b) => a.z - b.z)
        if (live.length < 2) return
        e.preventDefault()
        // Front-most is last; Alt+Tab sends it back and raises the next one.
        const next = e.shiftKey ? live[live.length - 2] : live[0]
        state.focusWindow(next.id)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
