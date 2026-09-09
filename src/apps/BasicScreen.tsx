import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { ScreenIcon } from '@/lib/icons'
import { getSession } from '@/lib/basic/session'
import { useDesktop } from '@/store/desktop'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './basicscreen.css'

/**
 * How many cells an INPUT echo anchored at `col` may write into.
 *
 * One short of the right edge: `Screen.write` wraps the cursor onto the next
 * row after filling the last cell, and a wrap at the foot of the screen
 * scrolls the answer out from under its own anchor. The typed line gets two
 * fewer still — the caret needs a cell, and so does the space that erases
 * behind a Backspace.
 */
function cellsFor(screen: { cols: number }, col: number): number {
  return Math.max(0, screen.cols - col)
}

/**
 * The BASIC program's screen: text and graphics, as QBasic drew them.
 *
 * This window renders no pixels through React. The interpreter mutates a
 * `Screen` in place and bumps a version counter; an animation frame here polls
 * that counter and blits when it moved. A program filling 640x480 costs one
 * `putImageData` per displayed frame and zero reconciliation — the same rule
 * that governs window drags and the Claude app's token stream.
 *
 * The window opens with the BASIC window that owns it and holds everything
 * the program says — text, pixels and the line typed into an INPUT alike. It
 * keeps its `Screen` between runs, so re-running a program does not make it
 * flicker away and back.
 */
export function BasicScreen({ windowId, args }: AppProps) {
  const owner = args?.owner ?? ''
  const session = getSession(owner)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const setTitle = useDesktop((s) => s.setTitle)

  /* --- the INPUT line ---------------------------------------------------
     What has been typed so far, and where on the screen it is being echoed.
     Both are refs: a line being typed must no more re-render React than a
     pixel being plotted does. */
  const bufferRef = useRef('')
  const anchorRef = useRef<{ row: number; col: number } | null>(null)

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
   * Echo the line being typed at the place the prompt left the cursor.
   *
   * The caret is a drawn underscore, not a hardware cursor — the screen has no
   * such thing — and the trailing space is what a Backspace erases with, since
   * a shorter line has to blank the cell it gave up.
   *
   * Nothing written here may reach the row's last cell: `write` wraps *after*
   * filling it, and a wrap on the bottom row scrolls the text out from under
   * the anchor. `editKey` keeps the buffer inside that budget, but a prompt
   * that ended in the last column or two leaves no room even for the caret,
   * so the clamp lives here — the one place that writes.
   */
  const echo = useCallback(
    (text: string, caret: boolean) => {
      const anchor = anchorRef.current
      if (!session || !anchor) return
      const { screen } = session
      const line = (caret ? `${text}_ ` : `${text}  `).slice(0, cellsFor(screen, anchor.col))
      if (!line) return
      screen.locate(anchor.row, anchor.col, null, 0)
      screen.write(line)
    },
    [session],
  )

  /**
   * INPUT is typed here, the way QBasic's output screen was where a program
   * asked its questions. The line stays on the row the prompt ended on: that
   * is what keeps the anchor valid, since a wrap at the foot of the screen
   * would scroll the text under it.
   *
   * The anchor is taken per *question*, not per change of status: a program
   * that asks again from a loop never changes status at all. See
   * `session.inputGeneration`.
   */
  useEffect(() => {
    if (!session) return
    bufferRef.current = ''
    if (session.status !== 'awaiting-input') {
      anchorRef.current = null
      return
    }
    const { screen } = session
    anchorRef.current = { row: screen.cursorRow, col: screen.cursorCol }
    echo('', true)
    surfaceRef.current?.focus()
  }, [echo, session, session?.inputGeneration, session?.status])

  const editKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!session || !anchorRef.current) return

      if (e.key === 'Enter') {
        e.preventDefault()
        const value = bufferRef.current
        echo(value, false)
        anchorRef.current = null
        bufferRef.current = ''
        // The interpreter adds the newline that ends the line.
        session.submitInput(value)
        return
      }

      if (e.key === 'Backspace') {
        e.preventDefault()
        bufferRef.current = bufferRef.current.slice(0, -1)
        echo(bufferRef.current, true)
        return
      }

      if (e.key.length !== 1) return
      e.preventDefault()
      if (bufferRef.current.length >= cellsFor(session.screen, anchorRef.current.col) - 2) return
      bufferRef.current += e.key
      echo(bufferRef.current, true)
    },
    [echo, session],
  )

  /**
   * Keys typed here feed INKEY$ and wake a bare SLEEP, except while a program
   * is waiting on INPUT, when they are the answer being typed.
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
      if (session.status === 'awaiting-input') {
        editKey(e)
        return
      }
      const key = inkeyFor(e.key)
      if (!key) return
      e.preventDefault()
      session.pressKey(key)
    },
    [editKey, session],
  )

  if (!session) {
    return (
      <div className="bscreen bscreen--orphan">
        <p>This screen has no program. Close it and run one from a BASIC window.</p>
      </div>
    )
  }

  return (
    // The surface takes focus so INKEY$ and INPUT have somewhere to read keys
    // from; pointerdown must preventDefault or the browser moves focus to the
    // body straight back off it.
    <div
      className="bscreen"
      ref={surfaceRef}
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
