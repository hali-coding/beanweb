import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { DEFAULT_RATE, Pulse, RATES } from '@/apps/Pulse'
import { useDesktop } from '@/store/desktop'

/**
 * The window, not the model -- that is `pulse.test.ts`.
 *
 * Pulse samples on an interval, so these need fake timers for the same reason
 * Tetris and Bean Challenge do: on the real clock a sample lands mid-assertion.
 *
 * jsdom has no canvas and never runs the rAF loop, so nothing here can look at
 * a bar. Each sample publishes its percentages to the canvas element's dataset
 * and that is what these read; how any of it is drawn -- and whether the easing
 * actually makes it look animated -- has to be checked in a real browser.
 */

const CORES = 4
/** The rate the window opens on, so these do not restate its numbers. */
const PERIOD = RATES[DEFAULT_RATE].period
const SLOW = RATES[RATES.length - 1].period

function mount() {
  const id = useDesktop.getState().openWindow({ appId: 'pulse', title: 'Pulse' })
  const view = render(<Pulse windowId={id} />)
  return { id, ...view }
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const $$ = <T extends HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]

const canvas = () => $<HTMLCanvasElement>('.pulse-canvas')
const sample = () => canvas().dataset.load
const readout = () => $$('.pulse-cpu').map((el) => el.textContent)

const advance = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms)
})

/** Open the one menu and click an item by its label. */
const choose = (label: string) => {
  act(() => {
    fireEvent.pointerDown($('.b-menubar-item'), { button: 0 })
  })
  // The mark span comes first in a menu item's text, so this matches inside it.
  const item = $$('.b-menu-item').find((el) => el.textContent?.includes(label))!
  expect(item).toBeTruthy()
  act(() => {
    fireEvent.click(item)
  })
}

const menuLabels = () => {
  act(() => {
    fireEvent.pointerDown($('.b-menubar-item'), { button: 0 })
  })
  const items = $$('.b-menu-item').map((el) => el.textContent ?? '')
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' })
  })
  return items
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: CORES })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Pulse window', () => {
  it('publishes one figure per core', () => {
    mount()
    advance(PERIOD)

    const loads = sample()!.split(',')
    expect(loads).toHaveLength(CORES)
    for (const n of loads) expect(Number(n)).toBeGreaterThanOrEqual(0)
    expect(readout()).toHaveLength(CORES)
    expect(readout()[0]).toMatch(/^\d+%$/)
  })

  it('moves: the sample after a tick is not the sample before it', () => {
    mount()
    advance(PERIOD)
    const first = sample()
    advance(PERIOD * 20)
    expect(sample()).not.toBe(first)
  })

  it('names the machine it found in the status line', () => {
    mount()
    expect($('.pulse-status').textContent).toContain(`${CORES} CPUs`)
  })

  it('samples at the rate the menu chose', () => {
    mount()
    advance(PERIOD)
    const before = sample()

    choose('Slow')
    // Slow is the longest period, so anything shorter must produce nothing.
    advance(SLOW - 1)
    expect(sample()).toBe(before)
    advance(1)
    expect(sample()).not.toBe(before)
  })

  it('marks the chosen rate, and Normal to begin with', () => {
    mount()
    expect(menuLabels().some((l) => l.includes('Normal'))).toBe(true)

    const marked = () => {
      act(() => {
        fireEvent.pointerDown($('.b-menubar-item'), { button: 0 })
      })
      const items = $$('.b-menu-item')
      const hit = items.find((el) => el.querySelector('.b-menu-item-mark')?.textContent === '•')
      const label = hit?.textContent ?? ''
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' })
      })
      return label
    }

    expect(marked()).toContain('Normal')
    choose('Fast')
    expect(marked()).toContain('Fast')
  })

  it('does not sample while the tab is hidden', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    mount()
    advance(PERIOD * 10)
    expect(sample()).toBeUndefined()

    // ...and picks up again when it comes back.
    hidden.mockReturnValue(false)
    act(() => {
      fireEvent(document, new Event('visibilitychange'))
    })
    advance(PERIOD)
    expect(sample()!.split(',')).toHaveLength(CORES)
    hidden.mockRestore()
  })

  it('stops sampling when the window goes away', () => {
    const { unmount } = mount()
    advance(PERIOD)
    const last = sample()
    const node = canvas()
    unmount()

    advance(PERIOD * 10)
    expect(node.dataset.load).toBe(last)
  })

  it('closes through requestClose, not closeWindow', async () => {
    const { id } = mount()
    choose('Close')
    await act(async () => {})
    expect(useDesktop.getState().windows[id]).toBeUndefined()
  })
})
