import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MenuBar } from '@/widgets/Menu'
import type { MenuDef } from '@/widgets/Menu'
import { Button } from '@/widgets/controls'
import { BasicIcon } from '@/lib/icons'
import { basename, dirname, useFs } from '@/store/fs'
import { useDesktop } from '@/store/desktop'
import { useCloseGuard } from '@/lib/closeGuards'
import { BasicError, Interpreter, build } from '@/lib/basic'
import type { Host, Status } from '@/lib/basic'
import { attachSession, createSession, destroySession } from '@/lib/basic/session'
import { launchApp, registerApp } from './registry'
import type { AppProps } from './registry'
import './basic.css'

const STARTER = `' Welcome to BeanWeb QBasic
CLS
PRINT "HELLO, WORLD"

FOR i = 1 TO 5
  PRINT i; "squared is"; i * i
NEXT i

' Text and graphics share the one screen window.
SCREEN 13
FOR i = 0 TO 60
  CIRCLE (160, 100), 100 - i, 32 + i
NEXT i
LINE (0, 0)-(319, 199), 15, B
LOCATE 24, 12: PRINT "BEANWEB BASIC";
`

const KEYWORDS_HELP = `Statements: PRINT, INPUT, LET, DIM, CONST, DATA/READ/RESTORE, IF/THEN/ELSE, SELECT CASE, FOR/NEXT/STEP, WHILE/WEND, DO/LOOP/UNTIL, GOTO, GOSUB/RETURN, SUB/FUNCTION/CALL, SWAP, RANDOMIZE, CLS, END/STOP

Graphics: SCREEN, PSET, PRESET, LINE, CIRCLE, PAINT, DRAW, COLOR, LOCATE, VIEW, WINDOW, PALETTE, GET, PUT, WIDTH, POINT, PMAP

Functions: LEN, LEFT$/RIGHT$/MID$, CHR$/ASC, VAL/STR$, UCASE$/LCASE$, INSTR, ABS/INT/SGN, SQR/SIN/COS/TAN/ATN/EXP/LOG, RND, TIMER, INKEY$, TAB/SPC

Sound (parsed, silent): BEEP, SOUND, PLAY, SLEEP`

/** The gap between the listing and its screen, in the R5 desktop's pixels. */
const SCREEN_GAP = 8

/**
 * Put the screen window beside the listing rather than on top of it.
 *
 * The cascade drops each new window a step down and to the right, which for
 * these two means the editor covers the one window the program is talking to.
 * If there is no room to the right the cascade stands — and below the 768px
 * breakpoint it always does, since every window there is full-bleed anyway.
 */
function placeScreen(editorId: string, screenId: string): void {
  const { windows, commitRect } = useDesktop.getState()
  const editor = windows[editorId]
  const screen = windows[screenId]
  if (!editor || !screen) return

  const x = editor.rect.x + editor.rect.w + SCREEN_GAP
  if (x + screen.rect.w > window.innerWidth) return
  commitRect(screenId, { ...screen.rect, x, y: editor.rect.y })
}

export function Basic({ windowId, args }: AppProps) {
  const [path, setPath] = useState<string | null>(args?.path ?? null)
  const [source, setSource] = useState(STARTER)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<Status>('ready')
  const [errorLine, setErrorLine] = useState<number | null>(null)

  const read = useFs((s) => s.read)
  const write = useFs((s) => s.write)
  const setTitle = useDesktop((s) => s.setTitle)
  const showAlert = useDesktop((s) => s.showAlert)
  const showSavePanel = useDesktop((s) => s.showSavePanel)
  const showOpenPanel = useDesktop((s) => s.showOpenPanel)
  const requestClose = useDesktop((s) => s.requestClose)
  const isActive = useDesktop((s) => s.activeId === windowId)

  /**
   * The link to the screen window — the program's whole output, text and
   * pixels together. Created once per BASIC window and kept across runs, so
   * the screen window stays attached to the same `Screen` object while every
   * Run builds a fresh interpreter around it.
   */
  const session = useMemo(() => createSession(windowId, 'Untitled.bas'), [windowId])

  const editorRef = useRef<HTMLTextAreaElement>(null)
  const vmRef = useRef<Interpreter | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  /**
   * `print` and `cls` have nothing to do here: the interpreter writes text
   * into `session.screen` itself, and the screen window is the only place a
   * program's output is shown. They stay on `Host` because they are what a
   * headless test observes — `recordingHost` is how the runtime is tested with
   * no DOM at all.
   *
   * `show` is the one that still does something. The interpreter calls it when
   * a program starts drawing and again on every SCREEN mode change, which is
   * where a screen window the user closed by hand comes back.
   */
  const host = useMemo<Host>(
    () => ({
      print: () => {},
      cls: () => {},
      show: () => {
        openScreenRef.current(false)
      },
      inkey: () => session.takeKey(),
    }),
    [session],
  )

  /**
   * Make sure this program has a screen window, and hand it the keyboard only
   * when the user asked for it by name. A window reopened underneath a running
   * program must not steal the caret out of the listing, so everything but
   * *Show screen* passes `focus: false` and puts focus back where it was.
   *
   * Held in a ref because `host` must not be rebuilt when it changes: a new
   * host identity would rebuild `run`, and a Run in flight reads the host it
   * started with.
   */
  const openScreen = useCallback(
    (focus: boolean) => {
      const existing = session.screenWindow
      if (existing && useDesktop.getState().windows[existing]) {
        if (focus) useDesktop.getState().focusWindow(existing)
        return
      }
      const opened = launchApp('basic-screen', { owner: windowId }, `${session.name} — Screen`)
      session.screenWindow = opened
      if (opened) placeScreen(windowId, opened)
      // openWindow focuses whatever it opened; the listing is where typing goes.
      if (!focus) useDesktop.getState().focusWindow(windowId)
    },
    [session, windowId],
  )

  const openScreenRef = useRef(openScreen)
  openScreenRef.current = openScreen

  useEffect(() => {
    if (path) {
      setSource(read(path) ?? '')
      setDirty(false)
    }
  }, [path, read])

  useEffect(() => {
    const name = path ? basename(path) : 'Untitled.bas'
    setTitle(windowId, dirty ? `${name} *` : name)
    session.name = name
    session.notify()
  }, [dirty, path, session, setTitle, windowId])

  // The screen window renders the program's status, so it has to hear about it.
  useEffect(() => {
    session.status = status
    session.notify()
  }, [session, status])

  // A BASIC window's screen belongs to it: it opens with the window, and
  // closing one closes the other.
  useEffect(() => {
    attachSession(windowId, session)
    openScreenRef.current(false)
    return () => {
      const screenWindow = session.screenWindow
      if (screenWindow) useDesktop.getState().closeWindow(screenWindow)
      destroySession(windowId)
    }
  }, [session, windowId])

  // A question takes the keyboard to the screen — see `pump`, which is the
  // only place that can count them — and the end of a program brings the caret
  // back to the listing.
  useEffect(() => {
    if (isActive && status === 'ready') editorRef.current?.focus()
  }, [isActive, status])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  useEffect(() => () => clearTimer(), [clearTimer])

  /**
   * The pump: run one time-sliced burst, hand the thread back to the browser,
   * then schedule the next. This is what keeps `10 GOTO 10` from freezing the
   * tab and what lets Stop ever be clicked.
   */
  const pump = useCallback(() => {
    const vm = vmRef.current
    if (!vm) return

    const next = vm.runSlice({ budgetMs: 8 })
    setStatus(next)

    if (next === 'running') {
      // A sleeping program says how long it wants; everything else comes
      // straight back so the browser gets a turn between slices.
      timerRef.current = setTimeout(pump, vm.sleepDelayMs) as unknown as number
      return
    }

    if (next === 'awaiting-input') {
      // Every question is announced here, where the slice that asked it ends.
      // A question asked from a loop settles React back on the status it
      // already had, so nothing that watches `status` can count them.
      session.beginInput()
      const screenWindow = session.screenWindow
      if (screenWindow) useDesktop.getState().focusWindow(screenWindow)
      return
    }

    if (next === 'error' && vm.error) {
      setErrorLine(vm.error.line)
      // The screen is the only transcript there is, so an error has to be
      // legible on it; the status line says which row, not what went wrong.
      session.screen.write(`\n${vm.error.toString()}\n`)
    }
  }, [session])

  const run = useCallback(() => {
    clearTimer()
    setErrorLine(null)
    session.clearKeys()
    // Everything the program says lands on the screen, so it has to be there
    // before the program says anything. What is already on it stays: QBasic
    // never wiped the screen between runs, which is what CLS is for.
    openScreenRef.current(false)

    let vm: Interpreter
    try {
      vm = new Interpreter(build(source), host, undefined, session.screen)
    } catch (err) {
      // A parse error never starts the program; report it and point at the line.
      const e = err instanceof BasicError ? err : new BasicError(String(err))
      setErrorLine(e.line)
      session.screen.write(`\n${e.toString()}\n`)
      setStatus('error')
      return
    }

    vmRef.current = vm
    vm.start()
    setStatus(vm.status)
    pump()
  }, [clearTimer, host, pump, session, source])

  const stop = useCallback(() => {
    clearTimer()
    vmRef.current?.stop()
    setStatus('done')
    session.screen.write('\nBreak\n')
  }, [clearTimer, session])

  /**
   * An answer typed on the screen window. It was echoed there as it was typed,
   * so nothing is written back here — the interpreter adds only the newline
   * that ends the line.
   */
  const submitInput = useCallback(
    (value: string) => {
      const vm = vmRef.current
      if (!vm) return
      vm.resumeInput(value)
      setStatus(vm.status)
      pump()
    },
    [pump],
  )

  /* ------------------------------------------------------------ file I/O */

  const saveAs = useCallback(async (): Promise<string | null> => {
    let name = path ? basename(path) : 'Untitled.bas'
    if (!name.toLowerCase().endsWith('.bas')) name += '.bas'
    const target = await showSavePanel('Save program', path ? dirname(path) : '/boot/home', name)
    if (!target) return null
    write(target, source)
    setPath(target)
    setDirty(false)
    return target
  }, [path, showSavePanel, source, write])

  const save = useCallback(async (): Promise<string | null> => {
    if (!path) return saveAs()
    write(path, source)
    setDirty(false)
    return path
  }, [path, saveAs, source, write])

  /**
   * Anything that throws the listing away asks first. `what` finishes the
   * sentence, so closing, New and Open all read as the same prompt. Returns
   * false to abort whatever was about to happen.
   */
  const confirmDiscard = useCallback(
    async (what: string) => {
      if (!dirty) return true
      const answer = await showAlert(
        'warn',
        'BASIC',
        `Save changes to "${path ? basename(path) : 'Untitled.bas'}" ${what}`,
        ['Cancel', "Don't save", 'Save'],
        2,
      )
      if (answer === 0) return false
      if (answer === 2 && !(await save())) return false
      return true
    },
    [dirty, path, save, showAlert],
  )

  useCloseGuard(windowId, () => confirmDiscard('before closing?'))

  /** Wipe the editor back to an empty, unrun, untitled program. */
  const reset = useCallback(
    (text: string, target: string | null) => {
      clearTimer()
      vmRef.current = null
      setSource(text)
      setPath(target)
      setDirty(false)
      setErrorLine(null)
      setStatus('ready')
    },
    [clearTimer],
  )

  const newProgram = useCallback(async () => {
    if (!(await confirmDiscard('before starting a new one?'))) return
    reset('', null)
  }, [confirmDiscard, reset])

  /**
   * Load a listing from disk into this window.
   *
   * The source is set here rather than left to the load effect: reopening the
   * program already showing does not change `path`, so the effect would not
   * run and an edited listing would never revert. Whatever was running stops —
   * the screen window stays, since it belongs to the window, not the program.
   */
  const openProgram = useCallback(async () => {
    if (!(await confirmDiscard('before opening another?'))) return
    // Untitled programs start where the samples live, not at the home root.
    const target = await showOpenPanel('Open program', path ? dirname(path) : '/boot/home/basic')
    if (!target) return
    reset(read(target) ?? '', target)
  }, [confirmDiscard, path, read, reset, showOpenPanel])

  const running = status === 'running' || status === 'awaiting-input'

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'File',
        items: [
          { label: 'New', onSelect: () => void newProgram() },
          { label: 'Open…', shortcut: 'Alt+O', onSelect: () => void openProgram() },
          { separator: true },
          { label: 'Save', shortcut: 'Alt+S', disabled: !dirty && Boolean(path), onSelect: () => void save() },
          { label: 'Save as…', onSelect: () => void saveAs() },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      {
        title: 'Run',
        items: [
          { label: 'Run', shortcut: 'F5', disabled: running, onSelect: run },
          { label: 'Stop', shortcut: 'Esc', disabled: !running, onSelect: stop },
          { separator: true },
          { label: 'Show screen', onSelect: () => openScreen(true) },
        ],
      },
      {
        title: 'Help',
        items: [
          {
            label: 'Keywords…',
            onSelect: () => void showAlert('info', 'BASIC keywords', KEYWORDS_HELP, ['OK'], 0),
          },
        ],
      },
    ],
    [dirty, newProgram, openProgram, openScreen, path, requestClose, run, running, save, saveAs, showAlert, stop, windowId],
  )

  /**
   * QBasic's own keys — F5 runs, Esc breaks — plus the R5 Alt shortcuts the
   * File menu advertises. All are handled on the app root so they work from
   * the listing, the console and the INPUT box alike.
   *
   * F5 must preventDefault whether or not it starts a program — otherwise the
   * browser reloads the tab and takes the whole desktop with it.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return

      if (e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 's') {
          e.preventDefault()
          void save()
        } else if (key === 'o') {
          e.preventDefault()
          void openProgram()
        }
        return
      }

      if (e.key === 'F5') {
        e.preventDefault()
        if (!running) run()
      } else if (e.key === 'Escape' && running) {
        e.preventDefault()
        stop()
      }
    },
    [openProgram, run, running, save, stop],
  )

  // The screen window has no Run button of its own and no interpreter to
  // hand an answer to, so it reaches all three through here.
  useEffect(() => {
    session.run = run
    session.stop = stop
    session.submitInput = submitInput
  }, [session, run, stop, submitInput])

  // Gutter numbering follows the editor's own lines, not BASIC line numbers.
  const lineCount = Math.max(source.split('\n').length, 1)
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')

  return (
    <div className="basic" onKeyDown={onKeyDown}>
      <MenuBar menus={menus} />

      <div className="basic-editor">
        <pre className="basic-gutter" aria-hidden>
          {gutter}
        </pre>
        <textarea
          ref={editorRef}
          className="basic-source b-scroll selectable"
          value={source}
          spellCheck={false}
          wrap="off"
          aria-label="BASIC program"
          onChange={(e) => {
            setSource(e.target.value)
            setDirty(true)
          }}
          onScroll={(e) => {
            // Keep the gutter aligned with the source as it scrolls.
            const g = e.currentTarget.previousElementSibling as HTMLElement | null
            if (g) g.scrollTop = e.currentTarget.scrollTop
          }}
        />
      </div>

      <div className="basic-bar">
        {running ? (
          <Button onClick={stop}>Stop</Button>
        ) : (
          <Button isDefault onClick={run}>
            Run
          </Button>
        )}
        <span className="b-spacer" />
        <span className="basic-state b-fixed">
          {status === 'error' && errorLine !== null
            ? `error in line ${errorLine}`
            : status === 'awaiting-input'
              ? 'waiting for input'
              : status}
        </span>
      </div>
    </div>
  )
}

registerApp({
  id: 'basic',
  name: 'BASIC',
  component: Basic,
  icon: BasicIcon,
  defaultW: 520,
  defaultH: 520,
  minW: 340,
  minH: 320,
  extensions: ['.bas'],
})
