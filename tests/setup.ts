import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'

/**
 * Both Zustand stores are module singletons, so state written by one test would
 * otherwise leak into the next. Reset them between every test.
 */

// DesktopIcons reads this at module scope to decide tap-to-open; jsdom has no
// implementation, so stub it before any component module is imported.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  localStorage.clear()
  useDesktop.setState({ windows: {}, order: [], activeId: null, alerts: [], savePanels: [] })
  useFs.getState().reset()
})

afterEach(() => {
  cleanup()
})
