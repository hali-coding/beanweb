import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'
import { useSettings } from '@/store/settings'
import { DEFAULT_MODEL } from '@/lib/models'

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

// BasicScreen observes its stage for resizes. Nothing reaches that line today
// -- the effect returns at getContext('2d'), which jsdom does not implement --
// but installing the canvas package would let it through to a ReferenceError
// far from anything the test was about. Same reasoning as matchMedia above.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

beforeEach(() => {
  localStorage.clear()
  useDesktop.setState({
    windows: {},
    order: [],
    activeId: null,
    alerts: [],
    savePanels: [],
    keyPrompts: [],
    shutdown: null,
  })
  useFs.getState().reset()
  // Explicit literal, not a reset() action: a new persisted field keeps its
  // previous value across tests until it is added here.
  useSettings.setState({ apiKey: '', model: DEFAULT_MODEL, theme: 'light' })
  document.documentElement.removeAttribute('data-theme')
})

afterEach(() => {
  cleanup()
})
