/**
 * Pulse's model: what the bars are showing.
 *
 * A browser tab has no kernel to ask, so this is honest about the split. The
 * *core count* is real -- `navigator.hardwareConcurrency`. The *pressure* is
 * real too: `pressureOf` turns how late the sampler's own interval fired into
 * a 0..1 figure, and a callback can only be late because something else held
 * the main thread. Everything below that -- which core is busy and by how
 * much -- is a random walk around the baseline that pressure sets.
 *
 * Measuring per-core load for real would mean spinning a Web Worker on every
 * core and counting iterations against a calibrated maximum: an idle accessory
 * that heats the machine in order to report that the machine is hot. That is
 * the reason this is simulated, and the reason it should stay simulated.
 *
 * Pure data with no DOM, like `lib/beanchallenge/engine.ts` and
 * `lib/basic/screen.ts`, which is what puts the whole of it inside the jsdom
 * suite. The view paces it: `apps/Pulse.tsx` owns the only timer.
 */

/** R5 topped out at 8 CPUs; a 64-thread box would draw hairlines. */
export const MAX_CORES = 16

/** How far a core is pulled back toward the baseline each sample. */
const PULL = 0.25
/** Width of the random walk per sample. */
const WALK = 0.1
/** An idle machine is not at zero -- something is always ticking over. */
const IDLE = 0.03
/** Chance per core per sample of a short burst of work, and its size. */
const SPIKE_CHANCE = 0.025
const SPIKE = 0.3

/*
 * These five are tuned together and want measuring rather than nudging:
 * clamping at zero rectifies the noise, so the resting mean lands well above
 * IDLE and the width of the walk is what decides how far above. As they stand
 * a core reads about 6% at rest and 97% under full pressure, near enough
 * linear in between.
 */

export interface PulseState {
  /** Load per core, 0..1, one entry per core. */
  cores: number[]
  seed: number
  /** Bumped by every `step`, so a caller can tell one sample from the next. */
  version: number
}

/** Maps NaN and every negative to 0, which is what the callers want. */
function clamp01(n: number): number {
  if (!(n > 0)) return 0
  return n > 1 ? 1 : n
}

export function coreCount(): number {
  const n = Math.floor(navigator.hardwareConcurrency)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, MAX_CORES)
}

export function createPulse(cores: number, seed = 0x5eedbea9): PulseState {
  const n = Math.max(1, Math.min(MAX_CORES, Math.floor(cores) || 1))
  return { cores: new Array(n).fill(IDLE), seed: seed | 0 || 1, version: 0 }
}

/**
 * The first real measurement: lateness as a fraction of the period the sampler
 * asked for. A tick that arrives on time means nothing else wanted the thread.
 *
 * This one catches a *block* -- a handler that ran for a second and let nothing
 * else in. It is deliberately not asked to tell that apart from a browser
 * throttling a hidden tab to 1 Hz, because no threshold separates them: a
 * BASIC program in a tight loop is late by seconds too. `apps/Pulse.tsx`
 * answers that by not sampling at all while `document.hidden`, which is the
 * question actually being asked.
 */
export function pressureOf(lateMs: number, periodMs: number): number {
  if (!(periodMs > 0)) return 0
  return clamp01(lateMs / periodMs)
}

/**
 * A frame this much longer than the window's usual one is a stutter. Exported
 * because the counting happens in the view, where the frames are.
 */
export const JANK_RATIO = 1.35

/* What fraction of a window's frames has to stutter before that reads as load
   at all, and over how much further it climbs to 1. Measured in Chrome: an
   idle desktop turns in 0 long frames out of 60, and the same desktop running
   a BASIC loop turns in 10-12. */
const JANK_FLOOR = 0.05
const JANK_SPAN = 0.25
/** Below this many frames a fraction means nothing; lateness covers that. */
const MIN_FRAMES = 8

/**
 * The second real measurement, and the one that matters most of the time: how
 * often frames stutter.
 *
 * Lateness alone under-reports the common case badly. Anything long-running
 * here works in slices -- the BASIC interpreter, the Claude token stream -- so
 * the sampler's interval still fires roughly on time.
 *
 * The obvious next measure, average frame time, does not work either, and it
 * took a browser to find that out: while a BASIC program loops, Chrome still
 * presents 60 frames a second, so the mean is unchanged. What moves is the
 * evenness. An idle desktop holds 16.6-16.8 ms a frame; the same desktop with
 * a program running swings between 12 and 24.
 *
 * Nor is the *spread* of a window the right reading of that, which took a
 * browser to find out as well: over a second's worth of frames one stray long
 * frame is nearly certain, and a single outlier moved an idle machine to 15%.
 * A count is what survives that -- one stutter in sixty is one sixtieth, and
 * forty in sixty is a machine plainly working.
 *
 * Expressed as a fraction, so it needs no assumption about the display: a
 * 144 Hz panel stutters no more often than a 60 Hz one, and a browser settling
 * at a steady lower rate to save power reads as idle, which it is.
 */
export function jitterPressure(longFrames: number, frames: number): number {
  if (frames < MIN_FRAMES || !(longFrames > 0)) return 0
  return clamp01((longFrames / frames - JANK_FLOOR) / JANK_SPAN)
}

/**
 * Advance one sample. Returns a new state and never touches the one passed in
 * -- the same contract `step(game, input)` and `(doc, ...) => DrawDoc` hold.
 */
export function step(state: PulseState, pressure: number): PulseState {
  // xorshift32, carried in the state rather than reached for from Math.random,
  // so a run is reproducible and the suite can assert on one. Deliberately a
  // copy of the private `random()` in lib/beanchallenge/engine.ts rather than a
  // shared helper: that engine's determinism is what thirty recorded level
  // solutions replay against, and it is not worth disturbing for six lines.
  let s = state.seed | 0
  const rand = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s = s | 0
    return ((s >>> 0) % 0x100000) / 0x100000
  }

  const baseline = IDLE + clamp01(pressure) * (1 - IDLE)
  const cores = state.cores.map((load) => {
    let next = load + (baseline - load) * PULL + (rand() - 0.5) * WALK
    if (rand() < SPIKE_CHANCE) next += rand() * SPIKE
    return clamp01(next)
  })

  return { cores, seed: s || 1, version: state.version + 1 }
}
