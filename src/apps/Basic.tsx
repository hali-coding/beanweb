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

' Graphics open a screen window of their own.
SCREEN 13
FOR i = 0 TO 60
  CIRCLE (160, 100), 100 - i, 32 + i
NEXT i
LINE (0, 0)-(319, 199), 15, B
LOCATE 24, 12: PRINT "BEANWEB BASIC";
`

/** Console scrollback cap: a runaway PRINT loop must not eat all the memory. */
const MAX_OUTPUT = 40000

const KEYWORDS_HELP = `Statements: PRINT, INPUT, LET, DIM, CONST, DATA/READ/RESTORE, IF/THEN/ELSE, SELECT CASE, FOR/NEXT/STEP, WHILE/WEND, DO/LOOP/UNTIL, GOTO, GOSUB/RETURN, SUB/FUNCTION/CALL, SWAP, RANDOMIZE, CLS, END/STOP

Graphics: SCREEN, PSET, PRESET, LINE, CIRCLE, PAINT, DRAW, COLOR, LOCATE, VIEW, WINDOW, PALETTE, GET, PUT, WIDTH, POINT, PMAP

Functions: LEN, LEFT$/RIGHT$/MID$, CHR$/ASC, VAL/STR$, UCASE$/LCASE$, INSTR, ABS/INT/SGN, SQR/SIN/COS/TAN/ATN/EXP/LOG, RND, TIMER, INKEY$, TAB/SPC

Sound (parsed, silent): BEEP, SOUND, PLAY, SLEEP`

export function Basic({ windowId, args }: AppProps) {
  const [path, setPath] = useState<string | null>(args?.path ?? null)
  const [source, setSource] = useState(STARTER)
  const [dirty, setDirty] = useState(false)
  const [output, setOutput] = useState('')
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
   * The link to the screen window. Created once per BASIC window and kept
   * across runs, so the screen window stays attached to the same `Screen`
   * object while every Run builds a fresh interpreter around it.
   */
  const session = useMemo(() => createSession(windowId, 'Untitled.bas'), [windowId])

  const editorRef = useRef<HTMLTextAreaElement>(null)
  const consoleRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const vmRef = useRef<Interpreter | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  /* --- output buffering -------------------------------------------------
     A program can print far faster than the screen can update. The host
     appends into a ref and the pump flushes once per slice, so output costs
     one render per slice rather than one per PRINT. */
  const pendingRef = useRef('')

  /**
   * `show` is the only surprising one: the interpreter calls it the first time
   * a program touches the screen, and again on every SCREEN mode change, so
   * the screen window opens exactly when a program turns out to need it and
   * never for a program that only prints.
   */
  const host = useMemo<Host>(
    () => ({
      print: (text) => {
        pendingRef.current += text
      },
      cls: () => {
        pendingRef.current = ''
        setOutput('')
      },
      show: () => {
        openScreenRef.current()
      },
      inkey: () => session.takeKey(),
    }),
    [session],
  )

  /**
   * Show the screen window, reusing the one already open for this program.
   *
   * Held in a ref because `host` must not be rebuilt when it changes: a new
   * host identity would rebuild `run`, and a Run in flight reads the host it
   * started with.
   */
  const openScreen = useCallback(() => {
    const existing = session.screenWindow
    if (existing && useDesktop.getState().windows[existing]) {
      useDesktop.getState().focusWindow(existing)
      return
    }
    session.screenWindow = launchApp('basic-screen', { owner: windowId }, `${session.name} — Screen`)
  }, [session, windowId])

  const openScreenRef = useRef(openScreen)
  openScreenRef.current = openScreen

  const flushOutput = useCallback(() => {
    const text = pendingRef.current
    if (!text) return
    pendingRef.current = ''
    setOutput((prev) => {
      const next = prev + text
      return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next
    })
  }, [])

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

  // A BASIC window's screen belongs to it: closing one closes the other.
  useEffect(() => {
    attachSession(windowId, session)
    return () => {
      const screenWindow = session.screenWindow
      if (screenWindow) useDesktop.getState().closeWindow(screenWindow)
      destroySession(windowId)
    }
  }, [session, windowId])

  // Keep the newest console output in view.
  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  // Focus the INPUT box the moment a program asks for something.
  useEffect(() => {
    if (status === 'awaiting-input') inputRef.current?.focus()
    else if (isActive && status === 'ready') editorRef.current?.focus()
  }, [status, isActive])

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
    flushOutput()
    setStatus(next)

    if (next === 'running') {
      // A sleeping program says how long it wants; everything else comes
      // straight back so the browser gets a turn between slices.
      timerRef.current = setTimeout(pump, vm.sleepDelayMs) as unknown as number
      return
    }

    if (next === 'error' && vm.error) {
      setErrorLine(vm.error.line)
      setOutput((prev) => `${prev}\n${vm.error?.toString()}\n`)
    }
  }, [flushOutput])

  const run = useCallback(() => {
    clearTimer()
    setOutput('')
    setErrorLine(null)
    pendingRef.current = ''

    session.clearKeys()

    let vm: Interpreter
    try {
      vm = new Interpreter(build(source), host, undefined, session.screen)
    } catch (err) {
      // A parse error never starts the program; report it and point at the line.
      const e = err instanceof BasicError ? err : new BasicError(String(err))
      setErrorLine(e.line)
      setOutput(`${e.toString()}\n`)
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
    flushOutput()
    setStatus('done')
    setOutput((prev) => `${prev}\nBreak\n`)
  }, [clearTimer, flushOutput])

  const submitInput = useCallback(
    (value: string) => {
      const vm = vmRef.current
      if (!vm) return
      // Echo what was typed, the way a real console does.
      pendingRef.current += `${value}\n`
      vm.resumeInput(value)
      flushOutput()
      setStatus(vm.status)
      pump()
    },
    [flushOutput, pump],
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
      setOutput('')
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
          { label: 'Show screen', onSelect: openScreen },
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

  // The screen window has no Run button of its own, so it drives these.
  useEffect(() => {
    session.run = run
    session.stop = stop
  }, [session, run, stop])

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

      <div className="basic-console b-scroll" ref={consoleRef}>
        <pre className="basic-output selectable">{output}</pre>
        {status === 'awaiting-input' ? (
          <ConsoleInput
            prompt={vmRef.current?.pendingInput?.prompt ?? '?'}
            inputRef={inputRef}
            onSubmit={submitInput}
          />
        ) : null}
      </div>
    </div>
  )
}

function ConsoleInput({
  prompt,
  inputRef,
  onSubmit,
}: {
  prompt: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <div className="basic-input-row">
      <span className="basic-prompt">{prompt}?</span>
      <input
        ref={inputRef}
        className="basic-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-label="Program input"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          onSubmit(value)
          setValue('')
        }}
      />
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
})
