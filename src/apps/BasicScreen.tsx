import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { ScreenIcon } from '@/lib/icons'
import { getSession } from '@/lib/basic/session'
import { useDesktop } from '@/store/desktop'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './basicscreen.css'

/**
 * The BASIC program's screen: text and graphics, as QBasic drew them.
 *
 * This window renders no pixels through React. The interpreter mutates a
 * `Screen` in place and bumps a version counter; an animation frame here polls
 * that counter and blits when it moved. A program filling 640x480 costs one
 * `putImageData` per displayed frame and zero reconciliation — the same rule
 * that governs window drags and the Claude app's token stream.
 *
 * The window is opened by the BASIC app the first time a program draws
 * anything, and it keeps its `Screen` between runs, so re-running a program
 * does not make it flicker away and back.
 */
export function BasicScreen({ windowId, args }: AppProps) {
  const owner = args?.owner ?? ''
  const session = getSession(owner)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const setTitle = useDesktop((s) => s.setTitle)
  const focusWindow = useDesktop((s) => s.focusWindow)

  // Only status changes re-render; pixels never do.
  const revision = useSyncExternalStore(
    session ? session.subscribe : noopSubscribe,
    session ? session.getSnapshot : zero,
  )
  void revision

  useEffect(() => {
    if (session) session.screenWindow = windowId
    return () => {
      if (session && session.screenWindow === windowId) session.screenWindow = null
    }
  }, [session, windowId])

  useEffect(() => {
    setTitle(windowId, session ? `${session.name} — Screen` : 'Screen')
  }, [session, session?.name, setTitle, windowId])

  /* ------------------------------------------------------------- painting */
  useEffect(() => {
    if (!session) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { screen } = session
    let raf = 0
    let painted = -1
    let image: ImageData | null = null

    /**
     * Size the picture to the biggest one that fits, keeping the mode's own
     * shape. This is arithmetic rather than CSS because the ratio wanted is
     * not the bitmap's: a 320x200 screen has to be shown 320x240, since its
     * pixels were tall on the 4:3 monitor the mode was drawn for. `aspect-ratio`
     * cannot letterbox against *both* axes without the used width collapsing
     * to the canvas's intrinsic size.
     */
    const fit = () => {
      const frame = frameRef.current
      const stage = frame?.parentElement
      if (!frame || !stage) return
      const w = screen.displayW
      const h = screen.displayH * screen.aspect
      if (w === 0 || h === 0) return
      // clientWidth counts the stage's own padding, so measuring with it
      // oversizes the frame and flex quietly shrinks it back — distorting the
      // picture by however much padding there was.
      const pad = getComputedStyle(stage)
      const availW = stage.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
      const availH = stage.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)
      const scale = Math.min(availW / w, availH / h)
      if (!Number.isFinite(scale) || scale <= 0) return
      frame.style.width = `${Math.floor(w * scale)}px`
      frame.style.height = `${Math.floor(h * scale)}px`
    }

    const paint = () => {
      raf = requestAnimationFrame(paint)
      const w = screen.displayW
      const h = screen.displayH
      if (w === 0 || h === 0) return

      // A mode change resizes the buffer; everything else reuses it.
      if (!image || image.width !== w || image.height !== h) {
        canvas.width = w
        canvas.height = h
        image = ctx.createImageData(w, h)
        painted = -1
        fit()
      }
      if (screen.version === painted) return

      painted = screen.version
      screen.renderInto(image.data)
      ctx.putImageData(image, 0, 0)
    }

    // Resizing the window is not a repaint, so it needs its own signal.
    const stage = frameRef.current?.parentElement
    const observer = stage ? new ResizeObserver(fit) : null
    if (stage && observer) observer.observe(stage)

    raf = requestAnimationFrame(paint)
    return () => {
      cancelAnimationFrame(raf)
      observer?.disconnect()
    }
  }, [session])

  /* ------------------------------------------------------------- keyboard */

  /**
   * Keys typed here feed INKEY$ and wake a bare SLEEP. A program that wants a
   * whole line still asks through INPUT, which is answered in the editor
   * window where there is a real text field to type into.
   *
   * F5 is the one key this window takes for itself, because the alternative is
   * the browser reloading the tab. Esc is deliberately *not* stolen the way it
   * is in the editor: `inkeyFor` reports it as chr$(27), and listings that quit
   * on Escape need to see it.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!session) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'F5') {
        e.preventDefault()
        if (session.status !== 'running' && session.status !== 'awaiting-input') session.run()
        return
      }
      const key = inkeyFor(e.key)
      if (!key) return
      e.preventDefault()
      session.pressKey(key)
    },
    [session],
  )

  if (!session) {
    return (
      <div className="bscreen bscreen--orphan">
        <p>This screen has no program. Close it and run one from a BASIC window.</p>
      </div>
    )
  }

  const waiting = session.status === 'awaiting-input'

  return (
    // The surface takes focus so INKEY$ has somewhere to read keys from;
    // pointerdown must preventDefault or the browser moves focus to the body
    // straight back off it.
    <div
      className="bscreen"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.focus()
      }}
    >
      <div className="bscreen-stage">
        <div className="bscreen-frame" ref={frameRef}>
          <canvas ref={canvasRef} className="bscreen-canvas" aria-label="BASIC screen" />
        </div>
      </div>
      <div className="bscreen-status b-fixed">
        <span>{describe(session.status)}</span>
        {waiting ? (
          <button
            type="button"
            className="bscreen-jump"
            onClick={() => focusWindow(owner)}
          >
            answer in {session.name}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** What INKEY$ would have returned for a key. "" means the key is ignored. */
function inkeyFor(key: string): string {
  if (key.length === 1) return key
  switch (key) {
    case 'Enter': return '\r'
    case 'Backspace': return '\b'
    case 'Tab': return '\t'
    case 'Escape': return '\x1b'
    // The arrows and function keys arrived as a null byte and a scan code.
    // The second byte is what a listing switches on.
    case 'ArrowUp': return '\x00H'
    case 'ArrowDown': return '\x00P'
    case 'ArrowLeft': return '\x00K'
    case 'ArrowRight': return '\x00M'
    default: return ''
  }
}

const describe = (status: string) =>
  status === 'awaiting-input' ? 'waiting for input' : status

const noopSubscribe = () => () => {}
const zero = () => 0

registerApp({
  id: 'basic-screen',
  name: 'BASIC Screen',
  component: BasicScreen,
  icon: ScreenIcon,
  defaultW: 660,
  defaultH: 540,
  minW: 260,
  minH: 200,
  // Opened by the BASIC app for a specific program, never from the Deskbar.
  hidden: true,
})
