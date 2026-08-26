import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import '@/apps' // side-effect: registers every app
import { Desktop } from '@/shell/Desktop'
import { useCloseGuard } from '@/lib/closeGuards'
import { useDesktop } from '@/store/desktop'

/**
 * Shut Down quits every window in turn and parks the desktop. The sequence is
 * paced by an interval in the view, so the rendered tests need fake timers; the
 * store tests step it by hand instead and need none.
 */

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const state = () => useDesktop.getState()

const alertButton = (label: string) =>
  $$<HTMLButtonElement>('.b-alert-buttons .b-button').find((b) => b.textContent === label)!
const menuItem = (label: string) =>
  $$<HTMLButtonElement>('.b-menu-item').find((n) => n.textContent?.trim() === label)!

/** Answer the confirmation without a UI, for the store-only tests. */
const answer = (index: number) => {
  const alert = state().alerts[state().alerts.length - 1]
  act(() => state().dismissAlert(alert.id, index))
}

const open = (title: string) => state().openWindow({ appId: 'terminal', title })

/** Registers a guard that always refuses, the way a dirty document does. */
function Stubborn({ windowId }: { windowId: string }) {
  useCloseGuard(windowId, () => false)
  return null
}

describe('shutdown sequence (store)', () => {
  it('parks straight away when nothing is running', async () => {
    await state().beginShutdown('shutdown')
    expect(state().shutdown).toEqual({ mode: 'shutdown', phase: 'down', quitting: null })
    expect(state().alerts).toHaveLength(0)
  })

  it('asks before quitting anything, and backing out changes nothing', async () => {
    open('Terminal')
    const done = state().beginShutdown('shutdown')
    expect(state().alerts[0].buttons).toEqual(['Cancel', 'Shut Down'])
    answer(0)
    expect(await done).toBe(false)
    expect(state().shutdown).toBeNull()
    expect(state().order).toHaveLength(1)
  })

  it('quits the front-most window first and names it while it goes', async () => {
    const back = open('Terminal')
    const front = open('StyledEdit')
    const done = state().beginShutdown('shutdown')
    answer(1)
    expect(await done).toBe(true)
    expect(state().shutdown?.phase).toBe('quitting')

    await act(() => state().quitNext())
    expect(state().windows[front]).toBeUndefined()
    expect(state().windows[back]).toBeTruthy()
    expect(state().shutdown?.quitting).toBe('StyledEdit')

    await act(() => state().quitNext())
    expect(state().order).toHaveLength(0)
    expect(state().shutdown?.phase).toBe('down')
  })

  it('abandons the shutdown when a window refuses to quit', async () => {
    const id = open('Unsaved')
    render(<Stubborn windowId={id} />)

    const done = state().beginShutdown('shutdown')
    answer(1)
    await done
    await act(() => state().quitNext())

    // R5 gave up when an application would not go, rather than killing it.
    expect(state().shutdown).toBeNull()
    expect(state().windows[id]).toBeTruthy()
  })

  it('reboot clears the session but not the disk', () => {
    open('Terminal')
    void state().beginShutdown('shutdown')
    act(() => state().reboot())
    expect(state().order).toHaveLength(0)
    expect(state().alerts).toHaveLength(0)
    expect(state().shutdown).toBeNull()
  })
})

describe('shutdown sequence (screen)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  const openBeMenu = () => act(() => { fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 }) })
  const click = (el: HTMLElement) => act(() => { fireEvent.click(el) })

  /** Boots the desktop and takes Shut Down from the Be menu, confirming it. */
  const shutDown = async (label = 'Shut Down') => {
    render(<Desktop />)
    await advance(0)
    openBeMenu()
    click(menuItem(label))
    await advance(0)
    click(alertButton(label))
    await advance(0)
  }

  it('offers Restart and Shut Down at the foot of the Be menu', async () => {
    render(<Desktop />)
    await advance(0)
    openBeMenu()
    const labels = $$('.b-menu-item').map((n) => n.textContent?.trim())
    expect(labels.slice(-2)).toEqual(['Restart', 'Shut Down'])
  })

  it('quits the windows, then says it is safe to turn off the tab', async () => {
    await shutDown()
    expect($('.b-shutdown')).toBeTruthy()
    expect($('.b-shutdown .b-window-title')?.textContent).toBe('Shutting Down')

    // One window (the boot Tracker) plus a beat to land on the parked screen.
    await advance(1000)

    expect(state().order).toHaveLength(0)
    expect($('.b-shutdown--down')).toBeTruthy()
    expect($('.b-shutdown .b-window-title')?.textContent).toBe('System is Shut Down')
    expect($('.b-shutdown-text')?.textContent).toBe(
      'It is now safe to turn off your browser tab.',
    )
  })

  it('reboots from the button, coming back up on home', async () => {
    await shutDown()
    await advance(1000)

    const reboot = $$<HTMLButtonElement>('.b-shutdown-buttons .b-button')[0]
    expect(reboot.textContent).toBe('Reboot System')
    click(reboot)
    await advance(0)

    expect($('.b-shutdown')).toBeNull()
    expect(state().order).toHaveLength(1)
    expect($$('.b-window-title').map((n) => n.textContent)).toEqual(['home'])
  })

  it('takes Enter on the parked window as Reboot System', async () => {
    await shutDown()
    await advance(1000)
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter' }) })
    await advance(0)

    expect($('.b-shutdown')).toBeNull()
    expect(state().order).toHaveLength(1)
  })

  it('leaves Enter to the Reboot button once it holds focus', async () => {
    await shutDown()
    await advance(1000)

    // The browser activates a focused button on Enter itself; the window-level
    // handler must stand down or the two of them boot two Trackers.
    const reboot = $$<HTMLButtonElement>('.b-shutdown-buttons .b-button')[0]
    reboot.focus()
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter' }) })
    await advance(0)

    expect($('.b-shutdown')).toBeTruthy()
    expect(state().order).toHaveLength(0)
  })

  it('ignores a held Enter so it cannot reboot twice', async () => {
    await shutDown()
    await advance(1000)
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter', repeat: true }) })
    await advance(0)

    expect($('.b-shutdown')).toBeTruthy()
    expect(state().order).toHaveLength(0)
  })

  it('Restart boots again without parking', async () => {
    await shutDown('Restart')
    await advance(2000)

    expect($('.b-shutdown')).toBeNull()
    expect(state().order).toHaveLength(1)
    expect($$('.b-window-title').map((n) => n.textContent)).toEqual(['home'])
  })
})
