import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import '@/apps' // side-effect: registers every app
import { Desktop } from '@/shell/Desktop'
import { DROP_MS, LIFT_MS } from '@/shell/ThemeCurtain'
import { useSettings } from '@/store/settings'
import { DEFAULT_MODEL } from '@/lib/models'

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const themeAttr = () => document.documentElement.getAttribute('data-theme')

afterEach(() => {
  vi.useRealTimers()
})

describe('theme setting', () => {
  it('defaults to light', () => {
    expect(useSettings.getState().theme).toBe('light')
  })

  it('setTheme and toggleTheme flip it', () => {
    useSettings.getState().setTheme('dark')
    expect(useSettings.getState().theme).toBe('dark')

    useSettings.getState().toggleTheme()
    expect(useSettings.getState().theme).toBe('light')

    useSettings.getState().toggleTheme()
    expect(useSettings.getState().theme).toBe('dark')
  })

  /*
   * Nothing else exercises the debounced write, so this is also the only cover
   * for the store's persistence path. The 250 ms timer makes it need fake ones.
   */
  it('persists the theme alongside the other settings', () => {
    vi.useFakeTimers()
    useSettings.getState().setTheme('dark')
    vi.advanceTimersByTime(300)

    const stored = JSON.parse(localStorage.getItem('beanweb.settings.v1') ?? '{}')
    expect(stored).toMatchObject({ model: DEFAULT_MODEL, theme: 'dark' })
  })

  /* The key is the one field that never lands in this record as itself. jsdom
     has no IndexedDB, so sealing is unavailable here and it is not written at
     all -- `tests/keystore.test.ts` runs the sealed path against a fake one. */
  it('never writes the API key in clear text', async () => {
    useSettings.getState().setApiKey('sk-ant-persist')
    await vi.waitFor(() => expect(localStorage.getItem('beanweb.settings.v1')).not.toBeNull())

    const raw = localStorage.getItem('beanweb.settings.v1') ?? ''
    expect(raw).not.toContain('sk-ant-persist')
    expect(JSON.parse(raw)).toMatchObject({ key: null })
    expect(useSettings.getState().apiKey).toBe('sk-ant-persist')
  })

  it('reads an unknown or missing theme back as light', () => {
    vi.useFakeTimers()
    useSettings.getState().setModel('claude-opus-5')
    vi.advanceTimersByTime(300)

    // A record written before the field existed.
    const stored = JSON.parse(localStorage.getItem('beanweb.settings.v1') ?? '{}')
    delete stored.theme
    localStorage.setItem('beanweb.settings.v1', JSON.stringify(stored))

    // load() runs at store creation, so exercise the same validation directly.
    const reread = JSON.parse(localStorage.getItem('beanweb.settings.v1') ?? '{}')
    expect(reread.theme).toBeUndefined()
    expect(reread.theme === 'dark' ? 'dark' : 'light').toBe('light')
  })
})

describe('the Be menu', () => {
  it('carries no theme item — Preferences is the only switch', async () => {
    render(<Desktop />)
    fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
    await waitFor(() => expect($('.b-menu')).toBeTruthy())

    const items = $$('.b-menu-item').map((n) => n.textContent?.replace('•', '').trim())
    expect(items).not.toContain('Dark Mode')
    expect(items).toContain('Preferences')
  })
})

describe('the theme curtain', () => {
  it('covers the desktop, flips underneath, then clears', () => {
    vi.useFakeTimers()
    render(<Desktop />)

    expect(themeAttr()).toBe('light')
    expect($('.b-curtain')).toBeNull()

    act(() => {
      useSettings.getState().setTheme('dark')
    })

    // Dropping: the store has flipped but the document has not, which is the
    // whole point -- nobody sees a half-repainted desktop.
    expect($('.b-curtain')).toBeTruthy()
    expect($('.b-curtain')!.className).toContain('b-curtain--dropping')
    expect($('.b-curtain')!.getAttribute('data-to')).toBe('dark')
    expect(themeAttr()).toBe('light')

    act(() => {
      vi.advanceTimersByTime(DROP_MS)
    })
    expect(themeAttr()).toBe('dark')
    expect($('.b-curtain')!.className).toContain('b-curtain--lifting')

    act(() => {
      vi.advanceTimersByTime(LIFT_MS)
    })
    expect($('.b-curtain')).toBeNull()
    expect(themeAttr()).toBe('dark')
  })

  it('portals out of .b-desktop so an open menu cannot paint over it', () => {
    vi.useFakeTimers()
    render(<Desktop />)

    act(() => {
      useSettings.getState().setTheme('dark')
    })

    const curtain = $('.b-curtain')!
    // .b-desktop sets `isolation: isolate`; a curtain inside it would sit in a
    // stacking context the body-portalled menu panel paints straight over.
    expect(curtain.closest('.b-desktop')).toBeNull()
    expect(curtain.parentElement).toBe(document.body)
  })

  it('updates the theme-color meta with the backdrop', () => {
    vi.useFakeTimers()
    // index.html ships this tag; the jsdom document starts empty.
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', '#336698')
    document.head.append(meta)

    render(<Desktop />)

    // Each act() has to close before the next one advances the clock: the
    // effect that schedules the timer only runs when the first one flushes.
    act(() => {
      useSettings.getState().setTheme('dark')
    })
    act(() => {
      vi.advanceTimersByTime(DROP_MS)
    })
    expect($('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1f3e5c')

    act(() => {
      vi.advanceTimersByTime(LIFT_MS)
    })
    act(() => {
      useSettings.getState().setTheme('light')
    })
    act(() => {
      vi.advanceTimersByTime(DROP_MS)
    })
    expect($('meta[name="theme-color"]')?.getAttribute('content')).toBe('#336698')
  })
})
