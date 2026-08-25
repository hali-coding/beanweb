import { describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import '@/apps' // side-effect: registers every app
import { Desktop } from '@/shell/Desktop'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const titles = () => $$('.b-window-title').map((n) => n.textContent)
const byText = <T extends Element = HTMLElement>(sel: string, text: string) =>
  $$<T>(sel).find((n) => n.textContent?.includes(text))!

const openDeskbarMenu = () => fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
/**
 * Waits on the window count rather than a title: an app is free to retitle
 * itself on mount (StyledEdit becomes "Untitled", Tracker becomes the folder
 * name), so the menu label is not what ends up on the tab.
 */
const launch = async (name: string) => {
  const before = $$('.b-window').length
  openDeskbarMenu()
  await waitFor(() => expect($('.b-menu')).toBeTruthy())
  fireEvent.click(byText('.b-menu-item', name))
  await waitFor(() => expect($$('.b-window')).toHaveLength(before + 1))
}
const alertButton = (label: string) =>
  $$<HTMLButtonElement>('.b-alert-buttons .b-button').find((b) => b.textContent === label)!
const panelButton = (label: string) =>
  $$<HTMLButtonElement>('.savepanel .b-button').find((b) => b.textContent === label)!

describe('desktop shell', () => {
  it('boots with icons, a Deskbar and a Tracker on home', async () => {
    render(<Desktop />)
    expect($('.b-desktop')).toBeTruthy()
    expect($('.b-deskbar')).toBeTruthy()
    expect($$('.b-desktop-icon')).toHaveLength(4)
    expect($$('.b-desktop-icon-label').map((n) => n.textContent)).toEqual([
      'beanweb',
      'home',
      'Terminal',
      'Trash',
    ])
    await waitFor(() => expect(titles()).toEqual(['home']))
    expect($('.b-deskbar-clock')?.textContent).toMatch(/\d/)
  })

  it('lists the registered apps in the Deskbar menu', async () => {
    render(<Desktop />)
    openDeskbarMenu()
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    const items = $$('.b-menu-item').map((n) => n.textContent?.replace('•', '').trim())
    expect(items).toEqual(
      expect.arrayContaining(['Tracker', 'Terminal', 'StyledEdit', 'Tetris']),
    )
  })

  it('lists every open window in the Deskbar', async () => {
    render(<Desktop />)
    await launch('Terminal')
    expect($$('.b-deskbar-app-name').map((n) => n.textContent)).toEqual(['home', 'Terminal'])
  })
})

describe('Tracker', () => {
  it('lists the home folder and opens a text file in StyledEdit', async () => {
    render(<Desktop />)
    await waitFor(() => expect($('.tracker')).toBeTruthy())
    expect($$('.tracker-icon-label').map((n) => n.textContent)).toContain('readme.txt')

    fireEvent.doubleClick(byText('.tracker-icon', 'readme.txt'))
    await waitFor(() => expect($('.sedit-area')).toBeTruthy())
    expect($<HTMLTextAreaElement>('.sedit-area')!.value).toContain('Welcome to BeanWeb')
    expect(titles()).toContain('readme.txt')
  })

  it('navigates into a folder and back out', async () => {
    render(<Desktop />)
    await waitFor(() => expect($('.tracker')).toBeTruthy())
    fireEvent.doubleClick(byText('.tracker-icon', 'documents'))
    await waitFor(() => expect($('.tracker-path')?.textContent).toBe('/boot/home/documents'))
    expect($$('.tracker-icon-label').map((n) => n.textContent)).toContain('tips.txt')

    fireEvent.click($('.tracker-up')!)
    await waitFor(() => expect($('.tracker-path')?.textContent).toBe('/boot/home'))
  })
})

describe('Terminal', () => {
  const run = async (command: string) => {
    const input = $<HTMLInputElement>('.term-input')!
    fireEvent.change(input, { target: { value: command } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect($$('.term-line').at(-1)?.textContent).not.toBe(''))
  }
  const lastLine = () => $$('.term-line').at(-1)?.textContent

  it('focuses its prompt as soon as it opens', async () => {
    render(<Desktop />)
    await launch('Terminal')
    await waitFor(() => expect(document.activeElement).toBe($('.term-input')))
  })

  it('runs echo, and tracks the working directory across commands', async () => {
    render(<Desktop />)
    await launch('Terminal')
    await run('echo hello beos')
    expect(lastLine()).toBe('hello beos')

    await run('cd /boot/apps')
    await run('pwd')
    expect(lastLine()).toBe('/boot/apps')

    await run('ls')
    expect(lastLine()).toContain('Tetris')
  })

  it('reports unknown commands and bad paths', async () => {
    render(<Desktop />)
    await launch('Terminal')
    await run('bogus')
    expect(lastLine()).toContain('command not found')
    await run('cd /nowhere')
    expect(lastLine()).toContain('no such file or directory')
  })

  it('creates a file that Tracker and the filesystem both see', async () => {
    render(<Desktop />)
    await launch('Terminal')
    await run('touch /boot/home/fromshell.txt')
    await waitFor(() => expect(useFs.getState().exists('/boot/home/fromshell.txt')).toBe(true))
    expect($$('.tracker-icon-label').map((n) => n.textContent)).toContain('fromshell.txt')
  })

  it('recalls history with the up arrow', async () => {
    render(<Desktop />)
    await launch('Terminal')
    await run('echo one')
    const input = $<HTMLInputElement>('.term-input')!
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await waitFor(() => expect(input.value).toBe('echo one'))
  })
})

describe('unsaved-work guard', () => {
  const openDirtyEditor = async () => {
    await waitFor(() => expect($('.tracker')).toBeTruthy())
    fireEvent.doubleClick(byText('.tracker-icon', 'readme.txt'))
    await waitFor(() => expect($('.sedit-area')).toBeTruthy())
    fireEvent.change($('.sedit-area')!, { target: { value: 'EDITED' } })
    await waitFor(() => expect(titles()).toContain('readme.txt *'))
  }

  it('prompts when the tab close box is used on a dirty document', async () => {
    render(<Desktop />)
    await openDirtyEditor()
    fireEvent.click($$('.b-window-close').at(-1)!)
    await waitFor(() => expect($('.b-alert-text')?.textContent).toContain('Save changes'))
  })

  it('prompts on Alt+W too, and Cancel keeps the window', async () => {
    render(<Desktop />)
    await openDirtyEditor()
    const before = $$('.b-window').length
    fireEvent.keyDown(window, { key: 'w', altKey: true })
    await waitFor(() => expect($('.b-alert')).toBeTruthy())

    fireEvent.click(alertButton('Cancel'))
    await waitFor(() => expect($('.b-alert')).toBeNull())
    expect($$('.b-window')).toHaveLength(before)
    expect(useFs.getState().read('/boot/home/readme.txt')).toContain('Welcome')
  })

  it('discards the edit when told not to save, leaving the file alone', async () => {
    render(<Desktop />)
    await openDirtyEditor()
    const before = $$('.b-window').length
    fireEvent.keyDown(window, { key: 'w', altKey: true })
    await waitFor(() => expect($('.b-alert')).toBeTruthy())

    fireEvent.click(alertButton("Don't save"))
    await waitFor(() => expect($$('.b-window')).toHaveLength(before - 1))
    expect(useFs.getState().read('/boot/home/readme.txt')).toContain('Welcome')
  })

  it('writes the file on Save, then closes', async () => {
    render(<Desktop />)
    await openDirtyEditor()
    const before = $$('.b-window').length
    fireEvent.keyDown(window, { key: 'w', altKey: true })
    await waitFor(() => expect($('.b-alert')).toBeTruthy())

    fireEvent.click(alertButton('Save'))
    await waitFor(() => expect($$('.b-window')).toHaveLength(before - 1))
    expect(useFs.getState().read('/boot/home/readme.txt')).toBe('EDITED')
  })

  it('closes a clean document with no prompt at all', async () => {
    render(<Desktop />)
    await waitFor(() => expect($('.tracker')).toBeTruthy())
    fireEvent.doubleClick(byText('.tracker-icon', 'readme.txt'))
    await waitFor(() => expect($('.sedit-area')).toBeTruthy())

    const before = $$('.b-window').length
    fireEvent.keyDown(window, { key: 'w', altKey: true })
    await waitFor(() => expect($$('.b-window')).toHaveLength(before - 1))
    expect($('.b-alert')).toBeNull()
  })
})

describe('save panel', () => {
  const openSaveAs = async () => {
    fireEvent.pointerDown(byText('.sedit .b-menubar-item', 'File'), { button: 0 })
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    fireEvent.click(byText('.b-menu-item', 'Save as'))
    await waitFor(() => expect($('.savepanel')).toBeTruthy())
  }

  it('opens for an untitled document and writes where told', async () => {
    render(<Desktop />)
    await launch('StyledEdit')
    fireEvent.change($('.sedit-area')!, { target: { value: 'brand new' } })
    await openSaveAs()

    expect($<HTMLInputElement>('#savepanel-name-field')!.value).toBe('Untitled.txt')
    fireEvent.change($('#savepanel-name-field')!, { target: { value: 'fresh.txt' } })
    fireEvent.click(panelButton('Save'))

    await waitFor(() => expect($('.savepanel')).toBeNull())
    expect(useFs.getState().read('/boot/home/documents/fresh.txt')).toBe('brand new')
    expect(titles()).toContain('fresh.txt')
  })

  it('asks before replacing an existing file', async () => {
    render(<Desktop />)
    await launch('StyledEdit')
    fireEvent.change($('.sedit-area')!, { target: { value: 'clobber' } })
    await openSaveAs()

    fireEvent.change($('#savepanel-name-field')!, { target: { value: 'tips.txt' } })
    fireEvent.click(panelButton('Save'))

    await waitFor(() => expect($('.b-alert-text')?.textContent).toContain('already exists'))
    fireEvent.click(alertButton('Cancel'))
    await waitFor(() => expect($('.b-alert')).toBeNull())
    expect($('.savepanel')).toBeTruthy()
    expect(useFs.getState().read('/boot/home/documents/tips.txt')).toContain('Keyboard')
  })
})

describe('window manager', () => {
  it('raises a window when its tab is clicked', async () => {
    render(<Desktop />)
    await launch('Terminal')
    const [trackerWin] = $$('.b-window')
    fireEvent.pointerDown($$('.b-window-tab')[0], { button: 0 })
    await waitFor(() => expect(trackerWin.classList.contains('b-window--active')).toBe(true))
  })

  it('closes an unguarded window instantly from its close box', async () => {
    render(<Desktop />)
    await launch('Terminal')
    const before = $$('.b-window').length
    fireEvent.click($$('.b-window-close').at(-1)!)
    await waitFor(() => expect($$('.b-window')).toHaveLength(before - 1))
    expect($('.b-alert')).toBeNull()
  })

  it('zooms and restores from the tab widget', async () => {
    render(<Desktop />)
    await waitFor(() => expect(titles()).toEqual(['home']))
    const id = useDesktop.getState().order[0]
    const original = useDesktop.getState().windows[id].rect

    fireEvent.click($('.b-window-zoom')!)
    await waitFor(() => expect(useDesktop.getState().windows[id].zoomed).toBe(true))
    fireEvent.click($('.b-window-zoom')!)
    await waitFor(() => expect(useDesktop.getState().windows[id].rect).toEqual(original))
  })
})
