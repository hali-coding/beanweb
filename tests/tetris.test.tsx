import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { Tetris } from '@/apps/Tetris'
import { useDesktop } from '@/store/desktop'

/**
 * Gravity runs on an interval, so these use fake timers: without them the piece
 * would fall mid-assertion and every test would be a race.
 */

function mount() {
  const id = useDesktop.getState().openWindow({ appId: 'tetris', title: 'Tetris' })
  const view = render(<Tetris windowId={id} />)
  return { id, ...view }
}

const cells = () => [...document.querySelectorAll<HTMLElement>('.tetris-field .tetris-cell')]
/** Indices of settled/falling blocks, excluding the landing shadow. */
const solid = () =>
  cells().flatMap((c, i) => (c.dataset.kind && !c.dataset.ghost ? [i] : []))
const columns = () => solid().map((i) => i % 10)
const rows = () => solid().map((i) => Math.floor(i / 10))
const ghosts = () => cells().filter((c) => c.dataset.ghost).length
const stat = (name: string) => {
  const labels = [...document.querySelectorAll('.tetris-stats dt')]
  const i = labels.findIndex((d) => d.textContent === name)
  return Number(document.querySelectorAll('.tetris-stats dd')[i]?.textContent)
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.tetris-buttons .b-button')]
    .find((b) => b.textContent === label)!
const ghostToggle = () =>
  document.querySelector<HTMLInputElement>('.tetris-options input[type="checkbox"]')!

const press = (key: string) => act(() => { fireEvent.keyDown(window, { key }) })
const newGame = () => act(() => { fireEvent.click(button('New game')) })
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Tetris', () => {
  it('renders a 10x20 well and a 4x4 preview', () => {
    mount()
    expect(cells()).toHaveLength(200)
    expect(document.querySelectorAll('.tetris-preview .tetris-cell')).toHaveLength(16)
  })

  it('waits for New game before starting', () => {
    mount()
    expect(document.querySelector('.tetris-overlay-text')?.textContent).toBe('Press New game')
    expect(solid()).toHaveLength(0)
  })

  it('spawns exactly one four-cell piece', () => {
    mount()
    newGame()
    expect(document.querySelector('.tetris-overlay')).toBeNull()
    expect(solid()).toHaveLength(4)
    expect(document.querySelectorAll('.tetris-preview .tetris-cell[data-kind]')).toHaveLength(4)
    expect(stat('Score')).toBe(0)
    expect(stat('Level')).toBe(1)
  })

  it('moves left and right', () => {
    mount()
    newGame()
    const start = columns()
    press('ArrowLeft')
    expect(columns()).toEqual(start.map((c) => c - 1))
    press('ArrowRight')
    press('ArrowRight')
    expect(columns()).toEqual(start.map((c) => c + 1))
  })

  it('clamps at the walls instead of leaving the well', () => {
    mount()
    newGame()
    for (let i = 0; i < 12; i += 1) press('ArrowLeft')
    expect(Math.min(...columns())).toBe(0)
    expect(solid()).toHaveLength(4)

    for (let i = 0; i < 12; i += 1) press('ArrowRight')
    expect(Math.max(...columns())).toBe(9)
    expect(solid()).toHaveLength(4)
  })

  it('keeps rotations to four cells inside the well', () => {
    mount()
    newGame()
    // Drop clear of the spawn row first. An I-piece spawns at y = -1 so it sits
    // flat on the top row, and rotating it there puts one cell in the vanish
    // zone above the field, which is legal but deliberately not rendered.
    press('ArrowDown')
    press('ArrowDown')
    for (const key of ['ArrowUp', 'x', 'z', 'z']) {
      press(key)
      expect(solid()).toHaveLength(4)
      expect(Math.min(...columns())).toBeGreaterThanOrEqual(0)
      expect(Math.max(...columns())).toBeLessThanOrEqual(9)
    }
  })

  it('rotates against the left wall via a kick', () => {
    mount()
    newGame()
    press('ArrowDown')
    press('ArrowDown')
    for (let i = 0; i < 12; i += 1) press('ArrowLeft')
    press('ArrowUp')
    expect(solid()).toHaveLength(4)
    expect(Math.min(...columns())).toBeGreaterThanOrEqual(0)
  })

  it('scores one point per row of soft drop', () => {
    mount()
    newGame()
    press('ArrowDown')
    press('ArrowDown')
    expect(stat('Score')).toBe(2)
  })

  it('drops on a gravity tick', () => {
    mount()
    newGame()
    const before = rows()
    advance(800)
    expect(rows()).toEqual(before.map((r) => r + 1))
  })

  it('locks on hard drop and spawns the next piece', () => {
    mount()
    newGame()
    press(' ')
    // Four settled plus four for the freshly spawned piece.
    expect(solid()).toHaveLength(8)
    expect(stat('Score')).toBeGreaterThan(0)
  })

  it('halts gravity while paused and resumes after', () => {
    mount()
    newGame()
    press('p')
    expect(document.querySelector('.tetris-overlay-text')?.textContent).toBe('Paused')
    const frozen = solid()
    advance(5000)
    expect(solid()).toEqual(frozen)

    press('p')
    expect(document.querySelector('.tetris-overlay')).toBeNull()
    advance(800)
    expect(solid()).not.toEqual(frozen)
  })

  it('ignores keys while another window is in front', () => {
    const { id } = mount()
    newGame()
    const before = columns()
    act(() => {
      useDesktop.setState({ activeId: `${id}-other` })
    })
    press('ArrowLeft')
    expect(columns()).toEqual(before)
  })

  describe('landing outline toggle', () => {
    it('is on by default and shows a shadow', () => {
      mount()
      newGame()
      expect(ghostToggle().checked).toBe(true)
      expect(ghosts()).toBe(4)
    })

    it('hides the shadow when switched off, keeping the piece', () => {
      mount()
      newGame()
      act(() => { fireEvent.click(ghostToggle()) })
      expect(ghostToggle().checked).toBe(false)
      expect(ghosts()).toBe(0)
      expect(solid()).toHaveLength(4)
    })

    it('still plays normally with the shadow off', () => {
      mount()
      newGame()
      act(() => { fireEvent.click(ghostToggle()) })
      press('ArrowLeft')
      expect(solid()).toHaveLength(4)
      press(' ')
      expect(solid()).toHaveLength(8)
      expect(ghosts()).toBe(0)
    })

    it('restores the shadow when switched back on', () => {
      mount()
      newGame()
      act(() => { fireEvent.click(ghostToggle()) })
      act(() => { fireEvent.click(ghostToggle()) })
      expect(ghostToggle().checked).toBe(true)
      expect(ghosts()).toBe(4)
    })
  })
})
