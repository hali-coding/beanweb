import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { Basic } from '@/apps/Basic'
import { BasicScreen } from '@/apps/BasicScreen'
import { Alerts } from '@/shell/Alerts'
import { getSession } from '@/lib/basic/session'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'

/**
 * The app half. The runtime itself is covered in basic.test.ts; this is about
 * the pump, the console, and the file/close plumbing.
 *
 * The pump drives itself with setTimeout, so these use fake timers and advance
 * explicitly — on real timers a running program would race the assertions.
 */

function mount() {
  const id = useDesktop.getState().openWindow({ appId: 'basic', title: 'BASIC' })
  const view = render(
    <>
      <Basic windowId={id} />
      <Alerts />
    </>,
  )
  return { id, ...view }
}

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const editor = () => $<HTMLTextAreaElement>('.basic-source')!
const consoleText = () => $('.basic-output')?.textContent ?? ''
const state = () => $('.basic-state')?.textContent ?? ''
/** Scoped to the button bar: `.basic button` would also match the menu bar,
 *  whose "Run" title is a button too. */
const button = (label: string) =>
  $$<HTMLButtonElement>('.basic-bar button').find((b) => b.textContent === label)

/** A newline, kept as a constant so test sources stay easy to read. */
const BREAK = String.fromCharCode(10)

const setSource = (text: string) => fireEvent.change(editor(), { target: { value: text } })

/**
 * Let the pump run: each tick fires exactly one scheduled slice.
 *
 * advanceTimersToNextTimer, not advanceTimersByTime — the pump reschedules
 * itself with a 0 ms timeout, so advancing by a duration would fire the new
 * timer inside the same call, forever.
 */
const pump = async (ticks = 20) => {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      vi.advanceTimersToNextTimer()
    })
  }
}

const runProgram = async (source: string, ticks = 20) => {
  setSource(source)
  await act(async () => {
    fireEvent.click(button('Run')!)
  })
  await pump(ticks)
}

beforeEach(() =>
  // Fake only the pump's scheduling. performance.now must stay real: runSlice
  // spends a wall-clock budget, and a frozen clock would never let it finish a
  // slice, hanging the test inside a single runSlice call.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }),
)
afterEach(() => vi.useRealTimers())

describe('BASIC app', () => {
  it('opens with a starter program and a ready state', () => {
    mount()
    expect(editor().value).toContain('HELLO, WORLD')
    expect(state()).toBe('ready')
  })

  it('runs a program and prints to the console', async () => {
    mount()
    await runProgram('PRINT "HI THERE"')
    expect(consoleText()).toContain('HI THERE')
    expect(state()).toBe('done')
  })

  it('numbers the gutter to match the source lines', () => {
    mount()
    setSource('10 PRINT 1\n20 PRINT 2\n30 END')
    expect($('.basic-gutter')?.textContent).toBe('1\n2\n3')
  })

  it('reports a syntax error against its line without running', async () => {
    mount()
    // Errors point at the source row now, not a BASIC line number.
    await runProgram('PRINT "OK"\nFOR = 3')
    expect(state()).toContain('error in line 2')
    expect(consoleText()).toContain('Syntax error')
    // The program never started, so nothing was printed.
    expect(consoleText()).not.toContain('OK')
  })

  it('reports a runtime error with its line', async () => {
    mount()
    await runProgram('PRINT "A"\nPRINT 1 / 0')
    expect(consoleText()).toContain('A')
    expect(state()).toContain('error in line 2')
    expect(consoleText()).toContain('Division by zero')
  })

  describe('the infinite program', () => {
    it('stays responsive and can be stopped', async () => {
      mount()
      // The canonical hang, in its QBasic spelling. If the pump were a plain
      // loop this test would never return.
      await runProgram('DO' + BREAK + 'LOOP', 5)
      expect(state()).toBe('running')
      expect(button('Stop')).toBeTruthy()

      await act(async () => {
        fireEvent.click(button('Stop')!)
      })
      expect(state()).toBe('done')
      expect(consoleText()).toContain('Break')
    })

    it('stops scheduling further slices once stopped', async () => {
      mount()
      await runProgram('DO' + BREAK + 'LOOP', 5)
      await act(async () => {
        fireEvent.click(button('Stop')!)
      })
      const after = consoleText()
      await pump(20)
      expect(consoleText()).toBe(after) // nothing more happened
    })
  })

  describe('INPUT', () => {
    it('prompts, then resumes with what was typed', async () => {
      mount()
      await runProgram('10 INPUT "NAME"; N$\n20 PRINT "HI "; N$')
      expect($('.basic-input')).toBeTruthy()
      expect($('.basic-prompt')?.textContent).toBe('NAME?')
      expect(state()).toBe('waiting for input')

      const field = $<HTMLInputElement>('.basic-input')!
      fireEvent.change(field, { target: { value: 'World' } })
      await act(async () => {
        fireEvent.keyDown(field, { key: 'Enter' })
      })
      await pump()

      expect(consoleText()).toContain('HI World')
      expect(state()).toBe('done')
    })
  })

  describe('the screen window', () => {
    /** The screen window the BASIC window opened, if any. */
    const screenWindow = () =>
      Object.values(useDesktop.getState().windows).find((w) => w.appId === 'basic-screen')

    it('stays shut for a program that only prints', async () => {
      mount()
      await runProgram('PRINT "TEXT ONLY"')
      expect(screenWindow()).toBeUndefined()
    })

    it('opens as soon as a program draws', async () => {
      const { id } = mount()
      await runProgram('SCREEN 13' + BREAK + 'PSET (10, 10), 4')
      const win = screenWindow()
      expect(win).toBeDefined()
      // It is bound to the BASIC window that opened it.
      expect(win?.args?.owner).toBe(id)
    })

    it('opens once, however much the program draws', async () => {
      mount()
      await runProgram('SCREEN 13' + BREAK + 'FOR i = 1 TO 50' + BREAK + 'PSET (i, i), 4' + BREAK + 'NEXT i')
      expect(
        Object.values(useDesktop.getState().windows).filter((w) => w.appId === 'basic-screen'),
      ).toHaveLength(1)
    })

    it('draws into the session screen the window reads from', async () => {
      const { id } = mount()
      await runProgram('SCREEN 13' + BREAK + 'PSET (10, 20), 4')
      const screen = getSession(id)?.screen
      expect(screen?.pixels[20 * 320 + 10]).toBe(4)
    })

    it('is opened on demand from the Run menu', async () => {
      mount()
      await act(async () => {
        fireEvent.pointerDown(
          $$('.basic .b-menubar-item').find((n) => n.textContent === 'Run')!,
          { button: 0 },
        )
      })
      await act(async () => {
        fireEvent.click($$('.b-menu-item').find((n) => n.textContent?.includes('Show screen'))!)
      })
      expect(screenWindow()).toBeDefined()
    })

    it('closes with the BASIC window that owns it', async () => {
      const { unmount } = mount()
      await runProgram('SCREEN 13' + BREAK + 'PSET (1, 1), 4')
      expect(screenWindow()).toBeDefined()

      // Unmounting is what a close comes down to, and it is the path that
      // does not need an unsaved-changes prompt answered first.
      await act(async () => {
        unmount()
      })
      expect(screenWindow()).toBeUndefined()
    })

    it('renders a canvas for its owner', () => {
      const { id } = mount()
      const screenId = useDesktop.getState().openWindow({ appId: 'basic-screen' })
      render(<BasicScreen windowId={screenId} args={{ owner: id }} />)
      expect($('.bscreen-canvas')).toBeTruthy()
    })

    it('says so when its program is gone', () => {
      const orphanId = useDesktop.getState().openWindow({ appId: 'basic-screen' })
      render(<BasicScreen windowId={orphanId} args={{ owner: 'nobody' }} />)
      expect($('.bscreen--orphan')).toBeTruthy()
      expect($('.bscreen-canvas')).toBeNull()
    })

    it('feeds what is typed on it to INKEY$', () => {
      const { id } = mount()
      const screenId = useDesktop.getState().openWindow({ appId: 'basic-screen' })
      render(<BasicScreen windowId={screenId} args={{ owner: id }} />)
      const surface = $$('.bscreen').at(-1)!

      fireEvent.keyDown(surface, { key: 'q' })
      expect(getSession(id)?.takeKey()).toBe('q')

      // The arrows arrived as a null byte and a scan code, and that pair is
      // what a listing switches on.
      fireEvent.keyDown(surface, { key: 'ArrowLeft' })
      expect(getSession(id)?.takeKey()).toBe('\u0000K')
    })
  })

  describe('files', () => {
    const openFileMenu = async (item: string) => {
      await act(async () => {
        fireEvent.pointerDown(
          $$('.basic .b-menubar-item').find((n) => n.textContent === 'File')!,
          { button: 0 },
        )
      })
      await act(async () => {
        fireEvent.click($$('.b-menu-item').find((n) => n.textContent?.includes(item))!)
      })
    }

    it('writes the program through the save panel', async () => {
      mount()
      setSource('PRINT "SAVED"')
      await openFileMenu('Save as')

      const panel = useDesktop.getState().savePanels[0]
      expect(panel).toBeTruthy()
      await act(async () => {
        useDesktop.getState().dismissSavePanel(panel.id, '/boot/home/x.bas')
      })

      expect(useFs.getState().read('/boot/home/x.bas')).toBe('PRINT "SAVED"')
    })

    it('prompts before closing an edited program, and Cancel keeps it open', async () => {
      const { id } = mount()
      setSource('PRINT "EDITED"')

      await act(async () => {
        void useDesktop.getState().requestClose(id)
      })
      expect($('.b-alert-text')?.textContent).toContain('Save changes')

      await act(async () => {
        fireEvent.click(
          $$<HTMLButtonElement>('.b-alert-buttons .b-button').find(
            (b) => b.textContent === 'Cancel',
          )!,
        )
      })
      expect(useDesktop.getState().windows[id]).toBeDefined()
    })

    it('closes an unedited program with no prompt', async () => {
      const { id } = mount()
      await act(async () => {
        await useDesktop.getState().requestClose(id)
      })
      expect(useDesktop.getState().windows[id]).toBeUndefined()
      expect($('.b-alert')).toBeNull()
    })

    it('loads a program passed as an argument', async () => {
      useFs.getState().write('/boot/home/loaded.bas', 'PRINT "FROM DISK"')
      const id = useDesktop.getState().openWindow({ appId: 'basic' })
      await act(async () => {
        render(<Basic windowId={id} args={{ path: '/boot/home/loaded.bas' }} />)
      })
      expect(editor().value).toContain('FROM DISK')
    })

    it('reads a program back through the open panel', async () => {
      useFs.getState().write('/boot/home/basic/other.bas', 'PRINT "OPENED"')
      mount()
      await openFileMenu('Open')

      const panel = useDesktop.getState().savePanels[0]
      expect(panel.mode).toBe('open')
      expect(panel.directory).toBe('/boot/home/basic')
      await act(async () => {
        useDesktop.getState().dismissSavePanel(panel.id, '/boot/home/basic/other.bas')
      })

      expect(editor().value).toBe('PRINT "OPENED"')
      expect(state()).toBe('ready')
    })

    it('prompts before opening over an edited program, and Cancel keeps it', async () => {
      useFs.getState().write('/boot/home/basic/other.bas', 'PRINT "OPENED"')
      mount()
      setSource('PRINT "MINE"')
      await openFileMenu('Open')

      expect($('.b-alert-text')?.textContent).toContain('Save changes')
      await act(async () => {
        fireEvent.click(
          $$<HTMLButtonElement>('.b-alert-buttons .b-button').find(
            (b) => b.textContent === 'Cancel',
          )!,
        )
      })
      // No panel was ever queued, and the listing is untouched.
      expect(useDesktop.getState().savePanels).toHaveLength(0)
      expect(editor().value).toBe('PRINT "MINE"')
    })

    it('opening replaces the listing of a program that is still running', async () => {
      useFs.getState().write('/boot/home/basic/other.bas', 'PRINT "OPENED"')
      mount()
      await runProgram('10 GOTO 10', 3)
      expect(state()).toBe('running')

      // Typing the listing made it dirty, so the discard prompt comes first.
      await openFileMenu('Open')
      await act(async () => {
        fireEvent.click(
          $$<HTMLButtonElement>('.b-alert-buttons .b-button').find(
            (b) => b.textContent === "Don't save",
          )!,
        )
      })
      await act(async () => {
        const panel = useDesktop.getState().savePanels[0]
        useDesktop.getState().dismissSavePanel(panel.id, '/boot/home/basic/other.bas')
      })

      expect(editor().value).toBe('PRINT "OPENED"')
      expect(state()).toBe('ready')
      // The pump must be dead, not merely reported as such.
      await pump(3)
      expect(state()).toBe('ready')
    })
  })

  describe('keyboard', () => {
    /** F5 and Esc are handled on the app root, so they bubble from anywhere. */
    const press = async (key: string) => {
      await act(async () => {
        fireEvent.keyDown(editor(), { key })
      })
    }

    it('runs the program on F5', async () => {
      mount()
      setSource('PRINT "BY KEY"')
      await press('F5')
      await pump()
      expect(consoleText()).toContain('BY KEY')
    })

    it('stops a running program on Escape', async () => {
      mount()
      setSource('10 GOTO 10')
      await press('F5')
      await pump(3)
      expect(state()).toBe('running')

      await press('Escape')
      expect(state()).toBe('done')
      expect(consoleText()).toContain('Break')
    })

    it('ignores Escape when nothing is running', async () => {
      mount()
      await press('Escape')
      expect(state()).toBe('ready')
      expect(consoleText()).not.toContain('Break')
    })

    it('does not restart a program already running on F5', async () => {
      mount()
      setSource('10 GOTO 10')
      await press('F5')
      await pump(3)
      const vmBefore = state()
      await press('F5')
      await pump(3)
      expect(state()).toBe(vmBefore)
      // A restart would have cleared the console; a no-op leaves it alone.
      expect(state()).toBe('running')
    })

    it('lets the screen window run its program with F5', async () => {
      const { id } = mount()
      setSource('PRINT "FROM SCREEN"')
      const screenId = useDesktop.getState().openWindow({ appId: 'basic-screen' })
      render(<BasicScreen windowId={screenId} args={{ owner: id }} />)

      await act(async () => {
        fireEvent.keyDown($$('.bscreen').at(-1)!, { key: 'F5' })
      })
      await pump()
      expect(consoleText()).toContain('FROM SCREEN')
    })

    it('still gives Escape to INKEY$ on the screen window', () => {
      const { id } = mount()
      const screenId = useDesktop.getState().openWindow({ appId: 'basic-screen' })
      render(<BasicScreen windowId={screenId} args={{ owner: id }} />)

      fireEvent.keyDown($$('.bscreen').at(-1)!, { key: 'Escape' })
      expect(getSession(id)?.takeKey()).toBe('')
    })
  })
})
