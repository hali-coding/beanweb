import { useCallback, useEffect } from 'react'
import { Button } from '@/widgets/controls'
import { launchApp } from '@/apps/registry'
import { selectShutdown, useDesktop } from '@/store/desktop'

/** Milliseconds between two windows being asked to quit. */
const STEP_MS = 320

/**
 * R5's shutdown. The Be menu asks every application to quit in turn and then
 * parks the machine on a window saying it is safe to switch off — here, to
 * close the tab. Restart runs the same sequence and boots again instead of
 * parking.
 *
 * The window is a *replica* of the chrome in wm/, not a managed one: it has no
 * entry in the store, no drag, resize or close box, and it has to survive the
 * store being emptied out from under it. It reuses the real classes so the tab
 * and bevels stay identical to every other window by construction.
 */
export function Shutdown() {
  const shutdown = useDesktop(selectShutdown)
  const quitNext = useDesktop((s) => s.quitNext)
  const reboot = useDesktop((s) => s.reboot)
  const phase = shutdown?.phase
  const mode = shutdown?.mode

  // Pacing lives here rather than in the store, so the store stays synchronous
  // logic a test can step one window at a time without timers. Depending on the
  // phase instead of the whole object keeps the interval from being torn down
  // and rebuilt every time the status line changes.
  useEffect(() => {
    if (phase !== 'quitting') return
    const timer = setInterval(() => void quitNext(), STEP_MS)
    return () => clearInterval(timer)
  }, [phase, quitNext])

  const onReboot = useCallback(() => {
    reboot()
    // The same window Desktop opens on a cold start.
    launchApp('tracker', { path: '/boot/home' }, 'home')
  }, [reboot])

  // Restart never shows the parked window; it boots straight back up.
  useEffect(() => {
    if (phase !== 'down' || mode !== 'restart') return
    const timer = setTimeout(onReboot, STEP_MS)
    return () => clearTimeout(timer)
  }, [phase, mode, onReboot])

  /*
   * R5 took Enter on the parked window as Reboot System. The button is not
   * focused on arrival, so the key needs catching on the window — but if it
   * *has* been focused (tabbed to, or left focused by a click) the browser
   * activates it on Enter as well, and both paths would boot a Tracker. Let
   * the button win whenever it holds focus, and ignore auto-repeat so a held
   * Enter cannot reboot twice either.
   */
  useEffect(() => {
    if (phase !== 'down' || mode !== 'shutdown') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat) return
      const active = document.activeElement
      if (active instanceof HTMLButtonElement && active.closest('.b-shutdown')) return
      e.preventDefault()
      onReboot()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, mode, onReboot])

  if (!shutdown) return null

  const down = shutdown.phase === 'down'
  const title = down
    ? 'System is Shut Down'
    : shutdown.mode === 'restart'
      ? 'Restarting'
      : 'Shutting Down'

  return (
    <div className={down ? 'b-shutdown b-shutdown--down' : 'b-shutdown'}>
      <div
        className="b-window b-window--active b-window--front b-shutdown-window"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="b-window-tabrow">
          <div className="b-window-tab">
            <span className="b-window-title">{title}</span>
          </div>
        </div>

        <div className="b-window-frame">
          <div className="b-window-content">
            <div className="b-shutdown-body bevel-thin-sunken">
              {/* R5 alerts keep a blank column where the icon would sit. */}
              <div className="b-shutdown-gutter" />
              <div className="b-shutdown-main">
                {down ? (
                  <>
                    <p className="b-shutdown-text">
                      It is now safe to turn off your browser tab.
                    </p>
                    <div className="b-shutdown-buttons">
                      <Button isDefault onClick={onReboot}>
                        Reboot System
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="b-shutdown-text" role="status" aria-live="polite">
                    {shutdown.quitting
                      ? `Quitting ${shutdown.quitting}…`
                      : 'Asking applications to quit…'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
