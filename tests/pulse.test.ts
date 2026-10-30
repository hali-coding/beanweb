import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CORES, coreCount, createPulse, jitterPressure, pressureOf, step } from '@/lib/pulse'

/** Run `n` samples at a fixed pressure and hand back the final state. */
function run(cores: number, pressure: number, n: number, seed?: number) {
  let s = createPulse(cores, seed)
  for (let i = 0; i < n; i += 1) s = step(s, pressure)
  return s
}

const mean = (xs: number[]) => xs.reduce((sum, n) => sum + n, 0) / xs.length

describe('pulse model', () => {
  it('starts with one entry per core', () => {
    expect(createPulse(4).cores).toHaveLength(4)
    expect(createPulse(1).cores).toHaveLength(1)
  })

  it('clamps a silly core count rather than believing it', () => {
    expect(createPulse(0).cores).toHaveLength(1)
    expect(createPulse(-3).cores).toHaveLength(1)
    expect(createPulse(999).cores).toHaveLength(MAX_CORES)
  })

  it('never leaves 0..1, at either extreme of pressure', () => {
    for (const pressure of [0, 0.5, 1]) {
      let s = createPulse(8)
      for (let i = 0; i < 3000; i += 1) {
        s = step(s, pressure)
        for (const load of s.cores) {
          expect(load).toBeGreaterThanOrEqual(0)
          expect(load).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('is deterministic for a seed, and different across seeds', () => {
    expect(run(4, 0.3, 200, 12345).cores).toEqual(run(4, 0.3, 200, 12345).cores)
    expect(run(4, 0.3, 200, 12345).cores).not.toEqual(run(4, 0.3, 200, 999).cores)
  })

  it('does not mutate the state it was handed', () => {
    const before = createPulse(4, 7)
    const snapshot = [...before.cores]
    const after = step(before, 0.8)

    expect(before.cores).toEqual(snapshot)
    expect(before.seed).toBe(createPulse(4, 7).seed)
    expect(after).not.toBe(before)
    expect(after.cores).not.toBe(before.cores)
    expect(after.version).toBe(before.version + 1)
  })

  it('carries pressure into the load: a busy thread reads higher', () => {
    const idle = mean(run(8, 0, 400, 42).cores)
    const busy = mean(run(8, 1, 400, 42).cores)
    expect(busy).toBeGreaterThan(idle + 0.3)
  })

  it('settles low when nothing is holding the thread', () => {
    // A resting desktop should read as a low hum, not as a third busy. The
    // bound is tight on purpose: it is the only thing watching the five walk
    // constants, which are easy to nudge upward one at a time.
    expect(mean(run(8, 0, 600, 42).cores)).toBeLessThan(0.1)
  })

  describe('pressureOf', () => {
    it('is zero for a tick that arrived on time or early', () => {
      expect(pressureOf(0, 500)).toBe(0)
      expect(pressureOf(-40, 500)).toBe(0)
    })

    it('is the lateness as a fraction of the period', () => {
      expect(pressureOf(250, 500)).toBeCloseTo(0.5)
      expect(pressureOf(125, 250)).toBeCloseTo(0.5)
    })

    it('saturates rather than running past 1', () => {
      expect(pressureOf(5000, 500)).toBe(1)
    })

    it('refuses a nonsense period instead of returning NaN', () => {
      expect(pressureOf(100, 0)).toBe(0)
      expect(pressureOf(Number.NaN, 500)).toBe(0)
    })
  })

  describe('jitterPressure', () => {
    /*
     * The figures behind these are the ones a real browser produced: an idle
     * desktop holds 16.6-16.8 ms a frame, and the same desktop running a BASIC
     * loop swings between 12 and 24. Both present 60 frames a second, which is
     * why what is counted is how many stuttered and not what they averaged.
     */
    it('is zero when no frame ran long', () => {
      expect(jitterPressure(0, 60)).toBe(0)
    })

    it('shrugs off the stray long frame every idle second has', () => {
      // The reading that sent this measure back to the drawing board: one
      // outlier in a window used to put an idle machine at 15%.
      expect(jitterPressure(1, 60)).toBe(0)
      expect(jitterPressure(2, 60)).toBe(0)
    })

    it('rises once a good share of the window is stuttering', () => {
      expect(jitterPressure(20, 60)).toBeGreaterThan(0.5)
      expect(jitterPressure(30, 60)).toBe(1)
    })

    it('is a fraction, so the display rate does not enter into it', () => {
      // A 144 Hz panel stuttering as often must read the same as a 60 Hz one.
      expect(jitterPressure(20, 60)).toBe(jitterPressure(48, 144))
    })

    it('ignores a window too short to count anything', () => {
      expect(jitterPressure(1, 1)).toBe(0)
      expect(jitterPressure(4, 7)).toBe(0)
    })

    it('refuses nonsense instead of returning NaN', () => {
      expect(jitterPressure(0, 0)).toBe(0)
      expect(jitterPressure(Number.NaN, 60)).toBe(0)
    })
  })

  describe('coreCount', () => {
    // Shadows the prototype getter; deleting the own property restores it, or
    // the stub would outlive this block for the rest of the file.
    afterEach(() => {
      delete (navigator as { hardwareConcurrency?: number }).hardwareConcurrency
    })

    const stub = (value: unknown) =>
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        configurable: true,
        value,
      })

    it('clamps both ends of what the browser reports', () => {
      stub(0)
      expect(coreCount()).toBe(1)
      stub(64)
      expect(coreCount()).toBe(MAX_CORES)
      stub(4)
      expect(coreCount()).toBe(4)
      stub(undefined)
      expect(coreCount()).toBe(1)
    })
  })
})
