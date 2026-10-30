import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PulseIcon } from '@/lib/icons'
import { MenuBar, type MenuDef, type MenuItem } from '@/widgets/Menu'
import {
  coreCount,
  createPulse,
  JANK_RATIO,
  jitterPressure,
  pressureOf,
  step,
  type PulseState,
} from '@/lib/pulse'
import { useDesktop } from '@/store/desktop'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './pulse.css'

/**
 * R5's smallest accessory: one window, one climbing bar per CPU.
 *
 * `lib/pulse.ts` is the model and says what is real here and what is not. This
 * file is the view, and it paces the model -- the same division as Shut Down,
 * the theme curtain and Bean Challenge. Two clocks:
 *
 *  - a `setInterval` that samples, at the rate the menu chose. It mutates a
 *    ref; React is not re-rendered per sample.
 *  - a `requestAnimationFrame` loop that *eases* each drawn bar toward the last
 *    sample and blits every frame. This is why the version-gate Bean Challenge
 *    and the BASIC screen paint through is missing here: those redraw a board
 *    that only changes on a tick, and Pulse has something new to draw on every
 *    frame. Easing is the whole reason a 2 Hz sampler looks animated.
 *
 * That same rAF loop is also half the measurement, which is why it runs whether
 * or not there is a canvas to draw on: it times every frame and counts the ones
 * that stuttered, and the sampler asks `jitterPressure` what that fraction
 * means. The other half is the sampler's own lateness. The two answer different
 * questions -- work arriving in slices, and the thread blocked outright -- so
 * the pressure fed to the model is whichever is higher.
 */

/*
 * How often a new sample is taken. Slower than a frame by a long way on
 * purpose: this is an idle monitor, and a bar that lands on a new figure four
 * times a second reads as noise rather than as load. The easing below is what
 * fills the gap, so a one-second sample still moves continuously.
 */
export const RATES = [
  { label: 'Fast (2×/sec)', period: 500 },
  { label: 'Normal (1×/sec)', period: 1000 },
  { label: 'Slow (every 2 sec)', period: 2000 },
] as const

export const DEFAULT_RATE = 1

/* ------------------------------------------------------------------ drawing */

/*
 * The well is a screen, not chrome, so it is deliberately not themed -- the
 * rule Terminal, the BASIC screen, Tetris and Bean Challenge already follow.
 * These are LED colours, the same in both palettes.
 */
const WELL = '#141414'
const LED_GREEN = '#3ad42f'
const LED_GREEN_OFF = '#11330f'
const LED_YELLOW = '#e8d420'
const LED_YELLOW_OFF = '#33300c'
const LED_PEAK = '#f2f2f2'

const SEGMENTS = 24
/** Fraction of the column above which a lit segment burns yellow. */
const WARN = 0.7
const GAP = 4
/* A column may be a quarter of the well tall at most, so a zoomed window fills
   with wide bars rather than a thin group marooned in the middle, and a
   single-core machine still gets a column rather than one huge slab. */
const MIN_BAR_CAP = 12
const MAX_BAR_CAP = 72
/*
 * Easing and peak decay are time constants in milliseconds, not per-frame
 * fractions: a per-frame constant travels twice as fast on a 120 Hz display as
 * on a 60 Hz one, and it cannot follow the sample rate either. `EASE_OF_PERIOD`
 * ties a bar's travel to whichever rate the menu chose, so it spends its whole
 * sample arriving rather than snapping in a fifth of it and then standing
 * still -- which is exactly what a slower rate would otherwise look like.
 */
const EASE_OF_PERIOD = 0.3
const PEAK_TAU = 900

/**
 * Where the columns go.
 *
 * A fractional pitch, so they always fit whatever the window is: the span can
 * never exceed `w`, and a bar is narrower than the pitch by the gap, so two
 * columns can never touch. Widened past `MAX_BAR` the group centres itself and
 * leaves the rest of the well empty, which is why this is a function both the
 * canvas *and* the readout row read: the numbers sit under their own columns
 * at every width, and a zoomed window does not leave the two fanned apart.
 */
function layoutBars(w: number, h: number, n: number) {
  const cap = Math.max(MIN_BAR_CAP, Math.min(MAX_BAR_CAP, h / 4))
  const pitch = Math.min(w / n, cap + GAP)
  const barW = Math.max(2, Math.floor(pitch - GAP))
  const left = Math.max(0, (w - (pitch * (n - 1) + barW)) / 2)
  return { pitch, barW, left }
}

function draw(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  loads: number[],
  peaks: number[],
) {
  ctx.fillStyle = WELL
  ctx.fillRect(0, 0, w, h)

  const n = loads.length
  const { pitch, barW, left } = layoutBars(w, h, n)
  const segH = h / SEGMENTS
  const cellH = Math.max(1, Math.round(segH) - 1)

  for (let i = 0; i < n; i += 1) {
    const x = Math.round(left + i * pitch)
    const lit = loads[i] * SEGMENTS

    for (let s = 0; s < SEGMENTS; s += 1) {
      const warm = s / SEGMENTS >= WARN
      const on = s < lit
      // An unlit segment is drawn in a dim copy of its own colour rather than
      // left black, so the column reads as an LED ladder with most of it off
      // instead of as an empty box with a stub in it.
      ctx.fillStyle = on
        ? warm
          ? LED_YELLOW
          : LED_GREEN
        : warm
          ? LED_YELLOW_OFF
          : LED_GREEN_OFF
      ctx.fillRect(x, Math.round(h - (s + 1) * segH) + 1, barW, cellH)
    }

    const peakSeg = Math.min(SEGMENTS - 1, Math.floor(peaks[i] * SEGMENTS))
    // Only when it has come clear of the bar; capping a rising column in white
    // would just make the top segment look broken.
    if (peakSeg > Math.floor(lit)) {
      ctx.fillStyle = LED_PEAK
      ctx.fillRect(x, Math.round(h - (peakSeg + 1) * segH) + 1, barW, cellH)
    }
  }
}

/* ---------------------------------------------------------------------- app */

export function Pulse({ windowId }: AppProps) {
  const requestClose = useDesktop((s) => s.requestClose)
  const showAlert = useDesktop((s) => s.showAlert)

  // Read once. A machine does not grow cores while the window is open, and a
  // test stubbing hardwareConcurrency wants it read at render, not at import.
  const cores = useMemo(() => coreCount(), [])
  const [rate, setRate] = useState(DEFAULT_RATE)

  const stateRef = useRef<PulseState>(createPulse(cores))
  const shownRef = useRef<number[]>(new Array(cores).fill(0))
  const peakRef = useRef<number[]>(new Array(cores).fill(0))
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const readoutRef = useRef<HTMLDivElement>(null)
  /* Frames since the last sample: how many, how many of those stuttered, and
     their total. Reset by every sample. `ref` is the previous window's mean
     frame, which is what "stuttered" is measured against -- a window cannot
     know its own mean until it is over, and one lagging sample behind is close
     enough for a figure that only has to separate 16.7 ms from 24. It starts
     at infinity, so nothing counts as long until a window has completed. */
  const framesRef = useRef({ n: 0, long: 0, total: 0 })
  const refFrameRef = useRef(Number.POSITIVE_INFINITY)
  /* The sample period, read by the paint loop so its easing follows the rate
     without the loop having to be torn down and rebuilt when that changes. */
  const periodRef = useRef<number>(RATES[DEFAULT_RATE].period)

  /** Whole percents, mirrored out of the ref -- the only thing React renders. */
  const [loads, setLoads] = useState<number[]>(() => new Array(cores).fill(0))

  const publish = useCallback((s: PulseState) => {
    const pct = s.cores.map((n) => Math.round(n * 100))
    // jsdom has no canvas and never fires the rAF loop, so this dataset is the
    // only way a test can see a sample at all. Same escape hatch as the Bean
    // Challenge board's player square.
    const canvas = canvasRef.current
    if (canvas) canvas.dataset.load = pct.join(',')
    setLoads((current) =>
      current.length === pct.length && current.every((n, i) => n === pct[i]) ? current : pct,
    )
  }, [])

  /* ------------------------------------------------------------- sampling */

  useEffect(() => {
    const period = RATES[rate].period
    periodRef.current = period
    let id = 0
    let last = 0

    const tick = () => {
      const now = performance.now()
      const elapsed = now - last
      const f = framesRef.current
      framesRef.current = { n: 0, long: 0, total: 0 }
      if (f.n > 0) refFrameRef.current = f.total / f.n
      const pressure = Math.max(
        pressureOf(elapsed - period, period),
        jitterPressure(f.long, f.n),
      )
      last = now
      const next = step(stateRef.current, pressure)
      stateRef.current = next
      publish(next)
    }

    const start = () => {
      if (id) return
      last = performance.now()
      framesRef.current = { n: 0, long: 0, total: 0 }
      id = window.setInterval(tick, period)
    }

    const stop = () => {
      if (!id) return
      window.clearInterval(id)
      id = 0
    }

    // A hidden tab has its timers throttled to about 1 Hz, and that lateness is
    // the browser's doing rather than load -- sampling through it would peg
    // every bar. Stopping also drops `last`, so the first tick after the tab
    // comes back is not measured against a timestamp from minutes ago.
    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [publish, rate])

  /* --------------------------------------------------------------- paint */

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    // jsdom has no canvas. Everything below is written to run without one,
    // because this loop is also the frame counter the sampler reads -- only
    // the drawing is skipped.
    const ctx = canvas.getContext('2d')

    let raf = 0
    let lastFrame = performance.now()
    // A hidden tab runs no frames, so the first one back would span the whole
    // time away: one "long" frame, and a mean that hides every real stutter in
    // the window after it. Marked on both edges, so it holds whichever of
    // visibilitychange and the next frame the browser runs first.
    let resumed = false
    const onVisibility = () => {
      resumed = true
    }
    let w = 0
    let h = 0

    const fit = () => {
      // clientWidth counts the stage's own padding, so measuring with it
      // oversizes the canvas and flex quietly shrinks it back -- squashing the
      // bars by however much padding there was. Same trap as BasicScreen.
      const pad = getComputedStyle(stage)
      const insetL = parseFloat(pad.paddingLeft)
      const availW = stage.clientWidth - insetL - parseFloat(pad.paddingRight)
      const availH = stage.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)
      w = Math.max(0, Math.floor(availW))
      h = Math.max(0, Math.floor(availH))
      if (w <= 0 || h <= 0) return

      // Put each percentage under its own column. The row carries the stage's
      // own margin in CSS, so only the stage's padding and the layout's
      // centring offset are left to add here.
      const readout = readoutRef.current
      if (readout) {
        const { pitch, left } = layoutBars(w, h, cores)
        readout.style.paddingLeft = `${insetL + left}px`
        readout.style.setProperty('--pulse-pitch', `${pitch}px`)
        readout.classList.add('pulse-readout--fitted')
      }

      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const paint = () => {
      raf = requestAnimationFrame(paint)

      const now = performance.now()
      const delta = now - lastFrame
      lastFrame = now
      if (resumed) resumed = false
      else if (delta > 0) {
        const f = framesRef.current
        f.n += 1
        f.total += delta
        if (delta > refFrameRef.current * JANK_RATIO) f.long += 1
      }

      if (!ctx || w <= 0 || h <= 0) return
      const target = stateRef.current.cores
      const shown = shownRef.current
      const peaks = peakRef.current
      const ease = 1 - Math.exp(-delta / (periodRef.current * EASE_OF_PERIOD))
      const fade = Math.exp(-delta / PEAK_TAU)
      for (let i = 0; i < shown.length; i += 1) {
        shown[i] += (target[i] - shown[i]) * ease
        peaks[i] = Math.max(shown[i], peaks[i] * fade)
      }
      draw(ctx, w, h, shown, peaks)
    }

    // Resizing the window is not a repaint, so it needs its own signal.
    const observer = ctx ? new ResizeObserver(fit) : null
    observer?.observe(stage)
    if (ctx) fit()

    raf = requestAnimationFrame(paint)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
    }
  }, [cores])

  /* --------------------------------------------------------------- menus */

  const explain = useCallback(() => {
    void showAlert(
      'info',
      'Pulse',
      `Pulse reads ${cores} logical core${cores === 1 ? '' : 's'} from the browser, ` +
        'and watches two things it can genuinely see: how evenly frames are arriving, ' +
        'and how late its own sampling timer fires. Both rise when something is holding ' +
        'the main thread — a BASIC program in a loop, a window being dragged — so the ' +
        'bars climb when this desktop is working and settle when it is not.\n\n' +
        'How that load is split between the cores is simulated. Reading it for real ' +
        'would mean spinning a worker on every core to measure that the machine is ' +
        'busy, which is a strange thing for an idle monitor to do.',
    )
  }, [cores, showAlert])

  const menus: MenuDef[] = useMemo(() => {
    const rates: MenuItem[] = RATES.map((r, i) => ({
      label: r.label,
      checked: i === rate,
      onSelect: () => setRate(i),
    }))

    return [
      {
        title: 'Pulse',
        items: [
          ...rates,
          { separator: true },
          { label: 'What Pulse measures…', onSelect: explain },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
    ]
  }, [explain, rate, requestClose, windowId])

  /* ---------------------------------------------------------------- view */

  const average = Math.round(loads.reduce((sum, n) => sum + n, 0) / (loads.length || 1))

  return (
    <div className="pulse">
      <MenuBar menus={menus} />

      <div className="pulse-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="pulse-canvas"
          role="img"
          aria-label={`Processor load, ${average}% average across ${cores} CPU${
            cores === 1 ? '' : 's'
          }`}
        />
      </div>

      <div className="pulse-readout" ref={readoutRef}>
        {loads.map((n, i) => (
          <span key={i} className="pulse-cpu">
            {n}%
          </span>
        ))}
      </div>

      <div className="pulse-status">
        <span>
          {cores} CPU{cores === 1 ? '' : 's'}
        </span>
        <span className="b-spacer" />
        <span>{average}% average</span>
      </div>
    </div>
  )
}

/*
 * The window opens wide enough for the machine it is on: a 16-thread box needs
 * room for sixteen columns, and a 2-core one should not open three-quarters
 * empty. Read at module scope because `defaultW` is a number, not a function.
 */
const DEFAULT_W = Math.min(460, Math.max(200, coreCount() * 26 + 48))

registerApp({
  id: 'pulse',
  name: 'Pulse',
  component: Pulse,
  icon: PulseIcon,
  defaultW: DEFAULT_W,
  defaultH: 208,
  minW: 160,
  minH: 150,
  singleton: true,
})
