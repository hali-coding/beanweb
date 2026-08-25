import { useSyncExternalStore } from 'react'

/**
 * Viewport size, read through useSyncExternalStore so every consumer shares a
 * single resize listener and a single cached snapshot.
 */

let snapshot = { w: 0, h: 0, mobile: false }
const listeners = new Set<() => void>()

function read() {
  const w = window.innerWidth
  const h = window.innerHeight
  const mobile = w < 768
  if (w !== snapshot.w || h !== snapshot.h || mobile !== snapshot.mobile) {
    snapshot = { w, h, mobile }
  }
  return snapshot
}

let bound = false
let frame = 0

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!bound) {
    bound = true
    const onResize = () => {
      // Resize storms (mobile URL bar, rotation) collapse to one update a frame.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        read()
        listeners.forEach((l) => l())
      })
    }
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('orientationchange', onResize, { passive: true })
  }
  return () => listeners.delete(cb)
}

const getSnapshot = () => {
  if (!snapshot.w) read()
  return snapshot
}

/** Server snapshot is only reached if this is ever prerendered; keep it stable. */
const getServerSnapshot = () => snapshot

export function useViewport() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
