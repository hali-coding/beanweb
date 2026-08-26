import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { applyTheme, prefersReducedMotion } from '@/lib/theme'
import { useSettings } from '@/store/settings'

/** Time the curtain takes to cover the desktop, and to clear it again. */
export const DROP_MS = 260
export const LIFT_MS = 260

type Phase = 'dropping' | 'lifting'

/**
 * Switching the theme drops a curtain over the desktop, changes the palette
 * underneath it, and lifts it again. The point is that nobody ever sees a
 * half-repainted desktop: the swap happens while the screen is covered.
 *
 * Same division of labour as Shut Down -- the store flips synchronously, and
 * the view is the only thing that owns a timer. The timing is `setTimeout`
 * rather than `animationend` because jsdom never fires CSS animation events;
 * driven by the clock, the whole sequence steps under `vi.useFakeTimers()`.
 */
export function ThemeCurtain() {
  const theme = useSettings((s) => s.theme)
  /* What the document is currently painted as, which is not the store during a
     transition -- that gap is the whole point. A ref, not state: changing it
     must not re-render, and the phase effects below already do that. */
  const painted = useRef(theme)
  const [phase, setPhase] = useState<Phase | null>(null)

  // index.html has already stamped the root before first paint. This re-syncs
  // it on mount (tests reset the store around a live document) and never
  // animates, because `painted` starts out agreeing with the store.
  useEffect(() => {
    applyTheme(painted.current)
  }, [])

  useEffect(() => {
    if (painted.current === theme || phase) return
    if (prefersReducedMotion()) {
      painted.current = theme
      applyTheme(theme)
      return
    }
    setPhase('dropping')
  }, [theme, phase])

  // Covered: repaint underneath, then start clearing.
  useEffect(() => {
    if (phase !== 'dropping') return
    const timer = setTimeout(() => {
      painted.current = theme
      applyTheme(theme)
      setPhase('lifting')
    }, DROP_MS)
    return () => clearTimeout(timer)
  }, [phase, theme])

  useEffect(() => {
    if (phase !== 'lifting') return
    const timer = setTimeout(() => setPhase(null), LIFT_MS)
    return () => clearTimeout(timer)
  }, [phase])

  if (!phase) return null

  /*
   * Into document.body, not into the tree. `.b-desktop` sets `isolation:
   * isolate`, so a curtain rendered inside it would sit in a stacking context
   * that the body-portalled menu panel paints straight over.
   *
   * `data-to` is the *incoming* theme -- the store has already flipped -- so
   * the curtain is painted the colour of the desktop that is arriving.
   */
  return createPortal(
    <div className={`b-curtain b-curtain--${phase}`} data-to={theme} aria-hidden="true" />,
    document.body,
  )
}
