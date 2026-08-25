import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDesktop } from '@/store/desktop'
import { useCloseGuard } from '@/lib/closeGuards'

const store = () => useDesktop.getState()
const open = (appId = 'tracker', title = 'Tracker') => store().openWindow({ appId, title })

describe('window management', () => {
  it('opens a window, focuses it, and tracks order', () => {
    const a = open()
    const b = open('terminal', 'Terminal')
    expect(store().order).toEqual([a, b])
    expect(store().activeId).toBe(b)
    expect(store().windows[a].title).toBe('Tracker')
  })

  it('cascades new windows so they never land exactly on top of each other', () => {
    const a = open()
    const b = open()
    expect(store().windows[b].rect.x).not.toBe(store().windows[a].rect.x)
    expect(store().windows[b].rect.y).not.toBe(store().windows[a].rect.y)
  })

  it('reuses the existing window for a singleton app', () => {
    const first = store().openWindow({ appId: 'about', singleton: true })
    const second = store().openWindow({ appId: 'about', singleton: true })
    expect(second).toBe(first)
    expect(store().order).toHaveLength(1)
  })

  it('raises a window above its siblings on focus', () => {
    const a = open()
    const b = open()
    expect(store().windows[b].z).toBeGreaterThan(store().windows[a].z)
    store().focusWindow(a)
    expect(store().windows[a].z).toBeGreaterThan(store().windows[b].z)
    expect(store().activeId).toBe(a)
  })

  it('passes focus to the front-most survivor when the active window closes', () => {
    const a = open()
    const b = open()
    store().focusWindow(a)
    store().closeWindow(a)
    expect(store().activeId).toBe(b)
    expect(store().order).toEqual([b])
  })

  it('leaves focus alone when a background window closes', () => {
    const a = open()
    const b = open()
    store().closeWindow(a)
    expect(store().activeId).toBe(b)
  })

  it('skips minimized windows when choosing the next focus', () => {
    const a = open()
    const b = open()
    const c = open()
    store().minimizeWindow(b, true)
    store().focusWindow(c)
    store().closeWindow(c)
    expect(store().activeId).toBe(a)
  })

  it('commits geometry and ignores a no-op commit', () => {
    const id = open()
    const before = store().windows[id]
    store().commitRect(id, before.rect)
    expect(store().windows[id]).toBe(before) // same object: no state churn
    store().commitRect(id, { x: 10, y: 20, w: 300, h: 200 })
    expect(store().windows[id].rect).toEqual({ x: 10, y: 20, w: 300, h: 200 })
  })

  it('zooms and restores the previous rect', () => {
    const id = open()
    const original = store().windows[id].rect
    store().toggleZoom(id, { w: 1000, h: 800 })
    expect(store().windows[id].zoomed).toBe(true)
    expect(store().windows[id].rect.w).toBeGreaterThan(original.w)
    store().toggleZoom(id, { w: 1000, h: 800 })
    expect(store().windows[id].zoomed).toBe(false)
    expect(store().windows[id].rect).toEqual(original)
  })

  it('leaves the Deskbar room when zooming', () => {
    const id = open()
    store().toggleZoom(id, { w: 1000, h: 800 })
    expect(store().windows[id].rect.w).toBeLessThan(1000)
  })
})

describe('alerts', () => {
  it('resolves with the index of the button pressed', async () => {
    const pending = store().showAlert('warn', 'T', 'body', ['Cancel', 'OK'], 1)
    const alert = store().alerts[0]
    expect(alert.buttons).toEqual(['Cancel', 'OK'])
    store().dismissAlert(alert.id, 1)
    await expect(pending).resolves.toBe(1)
    expect(store().alerts).toHaveLength(0)
  })

  it('queues several alerts', () => {
    void store().showAlert('info', 'A', 'a')
    void store().showAlert('info', 'B', 'b')
    expect(store().alerts).toHaveLength(2)
  })
})

describe('close guards', () => {
  it('closes immediately when no guard is registered', async () => {
    const id = open()
    await store().requestClose(id)
    expect(store().windows[id]).toBeUndefined()
  })

  it('keeps the window open when the guard refuses', async () => {
    const id = open()
    renderHook(() => useCloseGuard(id, () => false))
    await store().requestClose(id)
    expect(store().windows[id]).toBeDefined()
  })

  it('closes when the guard consents', async () => {
    const id = open()
    renderHook(() => useCloseGuard(id, () => true))
    await store().requestClose(id)
    expect(store().windows[id]).toBeUndefined()
  })

  it('awaits an async guard', async () => {
    const id = open()
    renderHook(() => useCloseGuard(id, async () => {
      await new Promise((r) => setTimeout(r, 10))
      return true
    }))
    await store().requestClose(id)
    expect(store().windows[id]).toBeUndefined()
  })

  it('does not stack a second prompt while one is pending', async () => {
    const id = open()
    let release!: (v: boolean) => void
    const guard = vi.fn(() => new Promise<boolean>((r) => { release = r }))
    renderHook(() => useCloseGuard(id, guard))

    const first = store().requestClose(id)
    const second = store().requestClose(id)
    release(false)
    await Promise.all([first, second])

    expect(guard).toHaveBeenCalledTimes(1)
    expect(store().windows[id]).toBeDefined()
  })

  it('unregisters the guard when the window unmounts', async () => {
    const id = open()
    const { unmount } = renderHook(() => useCloseGuard(id, () => false))
    unmount()
    await store().requestClose(id)
    expect(store().windows[id]).toBeUndefined()
  })

  it('reads the latest guard, not the first render closure', async () => {
    const id = open()
    let allow = false
    const { rerender } = renderHook(() => useCloseGuard(id, () => allow))
    await store().requestClose(id)
    expect(store().windows[id]).toBeDefined()

    allow = true
    rerender()
    await store().requestClose(id)
    expect(store().windows[id]).toBeUndefined()
  })
})
