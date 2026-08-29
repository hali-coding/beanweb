import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { BeanChallenge } from '@/apps/BeanChallenge'
import { useDesktop } from '@/store/desktop'
import { CLASSIC, readProgress, TICK_MS } from '@/lib/beanchallenge'

/**
 * The window, not the rules -- those are in `beanchallenge.test.ts`.
 *
 * The game runs on an interval, so these need fake timers for the same reason
 * Tetris does: on the real clock the player would walk on mid-assertion.
 *
 * jsdom has no canvas, so nothing here can look at the board. The player's
 * square is published to the canvas element's dataset by the tick, and that is
 * what the movement tests read; how any of it is actually *drawn* has to be
 * checked in a real browser.
 */

function mount() {
  const id = useDesktop.getState().openWindow({ appId: 'beanchallenge', title: 'Bean Challenge' })
  const view = render(<BeanChallenge windowId={id} />)
  return { id, ...view }
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const $$ = <T extends HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]

const board = () => $<HTMLCanvasElement>('.bean-canvas')
const where = () => [Number(board().dataset.x), Number(board().dataset.y)]

const stat = (name: string) => {
  const labels = $$('.bean-stats dt')
  const i = labels.findIndex((d) => d.textContent === name)
  return $$('.bean-stats dd')[i]?.textContent
}

const button = (label: string) =>
  $$<HTMLButtonElement>('.bean-buttons .b-button').find((b) => b.textContent === label)!

/** One player move is two ticks. */
const moves = (n = 1) => act(() => { vi.advanceTimersByTime(TICK_MS * 2 * n) })

const press = (key: string) => act(() => { fireEvent.keyDown(window, { key }) })
const release = (key: string) => act(() => { fireEvent.keyUp(window, { key }) })

/** Tap a direction and let the tick spend it. */
const walk = (key: string, times = 1) => {
  for (let i = 0; i < times; i += 1) {
    press(key)
    release(key)
    moves()
  }
}

const openMenu = (title: string) => {
  act(() => {
    fireEvent.pointerDown(
      $$('.bean .b-menubar-item').find((n) => n.textContent === title)!,
      { button: 0 },
    )
  })
  return $$<HTMLButtonElement>('.b-menu-item')
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Bean Challenge', () => {
  it('opens on the first level with its beans still on the floor', () => {
    mount()
    const first = CLASSIC.levels[0]
    expect($('.bean-level').textContent).toContain(first.name)
    expect(stat('Beans')).toBe('4')
    expect(stat('Time')).toBe('--')
    expect($('.bean-status')?.textContent).toContain('Arrows move')
  })

  // Level one's top row is open; the row below it is mostly wall, which is what
  // the second half of this test leans on.
  it('walks the player around with the arrow keys, and stops at a wall', () => {
    mount()
    const [x, y] = where()
    walk('ArrowRight', 2)
    expect(where()).toEqual([x + 2, y])
    walk('ArrowLeft')
    expect(where()).toEqual([x + 1, y])
    walk('ArrowDown', 2)
    expect(where()).toEqual([x + 1, y])
  })

  it('keeps walking while a key is held, and stops when it is let go', () => {
    mount()
    const [x, y] = where()
    press('ArrowRight')
    moves(2)
    expect(where()).toEqual([x + 2, y])
    release('ArrowRight')
    moves(2)
    expect(where()).toEqual([x + 2, y])
  })

  it('counts a bean off the total when it is picked up', () => {
    mount()
    // Level one opens two squares to the left of its first bean.
    walk('ArrowRight', 4)
    expect(stat('Beans')).toBe('3')
  })

  it('ignores keys while another window is in front', () => {
    const { id } = mount()
    const before = where()
    act(() => {
      useDesktop.setState({ activeId: `${id}-other` })
    })
    walk('ArrowDown', 2)
    expect(where()).toEqual(before)
  })

  it('puts the player back at the start on Restart', () => {
    mount()
    const start = where()
    walk('ArrowRight', 4)
    expect(where()).not.toEqual(start)
    expect(stat('Beans')).toBe('3')

    act(() => { fireEvent.click(button('Restart')) })
    expect(where()).toEqual(start)
    // The beans go back on the floor too, not just the player.
    expect(stat('Beans')).toBe('4')
  })

  it('freezes the game while paused and thaws it after', () => {
    mount()
    act(() => { fireEvent.click(button('Pause')) })
    expect($('.bean-plaque-text')?.textContent).toBe('Paused')

    const frozen = where()
    press('ArrowDown')
    moves(4)
    expect(where()).toEqual(frozen)

    act(() => { fireEvent.click(button('Resume')) })
    expect($('.bean-plaque')).toBeNull()
    moves(2)
    expect(where()).not.toEqual(frozen)
  })

  it('shows the level hint when the player stands on a hint square', () => {
    mount()
    // The hint square is the bottom-left corner of level one.
    walk('ArrowDown', 4)
    expect($('.bean-status')?.textContent).toBe(CLASSIC.levels[0].hint)
  })

  describe('the level menu', () => {
    it('lists the whole pack with everything past the first locked', () => {
      mount()
      const items = openMenu('Level')
      expect(items).toHaveLength(CLASSIC.levels.length)
      expect(items[0].textContent).toContain(CLASSIC.levels[0].name)
      expect(items[0].disabled).toBe(false)
      expect(items[1].disabled).toBe(true)
    })

    it('unlocks the next level once the first is finished, and remembers it', () => {
      mount()
      // Play the recorded solution: one key press per move, one tick pair each.
      for (const move of CLASSIC.levels[0].solution!) {
        walk({ U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight' }[move]!)
      }
      expect($('.bean-plaque-text')?.textContent).toBe('Level complete')
      expect(readProgress().classic.completed).toContain(CLASSIC.levels[0].id)

      const items = openMenu('Level')
      expect(items[1].disabled).toBe(false)
      expect(items[2].disabled).toBe(true)
    })

    it('carries on into the next level from the plaque', () => {
      mount()
      for (const move of CLASSIC.levels[0].solution!) {
        walk({ U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight' }[move]!)
      }
      act(() => { fireEvent.click($<HTMLButtonElement>('.bean-plaque .b-button')) })
      expect($('.bean-level').textContent).toContain(CLASSIC.levels[1].name)
      expect($('.bean-plaque')).toBeNull()
    })

    it('resumes where it left off when the window is opened again', () => {
      const first = mount()
      for (const move of CLASSIC.levels[0].solution!) {
        walk({ U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight' }[move]!)
      }
      act(() => { fireEvent.click($<HTMLButtonElement>('.bean-plaque .b-button')) })
      first.unmount()

      mount()
      expect($('.bean-level').textContent).toContain(CLASSIC.levels[1].name)
    })
  })
})
