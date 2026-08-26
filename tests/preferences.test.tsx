import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import '@/apps' // side-effect: registers every app
import { Desktop } from '@/shell/Desktop'
import { useFs } from '@/store/fs'
import { useSettings } from '@/store/settings'

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const byText = <T extends Element = HTMLElement>(sel: string, text: string) =>
  $$<T>(sel).find((n) => n.textContent?.includes(text))!

/** Waits on the window count, not a title -- apps retitle themselves on mount. */
const launch = async (name: string) => {
  const before = $$('.b-window').length
  fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
  await waitFor(() => expect($('.b-menu')).toBeTruthy())
  fireEvent.click(byText('.b-menu-item', name))
  await waitFor(() => expect($$('.b-window')).toHaveLength(before + 1))
}

/** The radio input inside the .b-control-row carrying this label. */
const radio = (label: string) =>
  byText<HTMLLabelElement>('.prefs-choices .b-control-row', label).querySelector('input')!

const alertButton = (label: string) =>
  $$<HTMLButtonElement>('.b-alert-buttons .b-button').find((b) => b.textContent === label)!

describe('Preferences', () => {
  it('launches from the Be menu', async () => {
    render(<Desktop />)
    await launch('Preferences')
    expect($('.prefs')).toBeTruthy()
  })

  it('is a singleton', async () => {
    render(<Desktop />)
    await launch('Preferences')
    const after = $$('.b-window').length

    fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    fireEvent.click(byText('.b-menu-item', 'Preferences'))

    await waitFor(() => expect($$('.prefs')).toHaveLength(1))
    expect($$('.b-window')).toHaveLength(after)
  })

  it('shows the current theme and switches it', async () => {
    render(<Desktop />)
    await launch('Preferences')

    expect(radio('Light').checked).toBe(true)
    expect(radio('Dark').checked).toBe(false)

    // fireEvent.click, never a direct .checked assignment: React's value
    // tracker would see no change and skip onChange entirely.
    fireEvent.click(radio('Dark'))
    await waitFor(() => expect(useSettings.getState().theme).toBe('dark'))
    expect(radio('Dark').checked).toBe(true)

    fireEvent.click(radio('Light'))
    await waitFor(() => expect(useSettings.getState().theme).toBe('light'))
  })

  it('follows a theme changed underneath it', async () => {
    render(<Desktop />)
    await launch('Preferences')

    // The radios are a view over the store, not their own state -- so a theme
    // restored from localStorage on the next boot arrives already marked.
    act(() => {
      useSettings.getState().setTheme('dark')
    })
    await waitFor(() => expect(radio('Dark').checked).toBe(true))
  })

  it('reports the node count', async () => {
    render(<Desktop />)
    await launch('Preferences')

    const nodes = Object.keys(useFs.getState().nodes).length
    expect($('.prefs-specs')?.textContent).toContain(`${nodes} node`)
  })
})

describe('resetting the disk', () => {
  const writeAFile = () => {
    useFs.getState().write('/boot/home/scratch.txt', 'temporary')
    return Object.keys(useFs.getState().nodes).length
  }

  it('warns first, and cancelling keeps the disk', async () => {
    render(<Desktop />)
    await launch('Preferences')

    const withFile = writeAFile()
    fireEvent.click(byText('.prefs .b-button', 'Reset disk'))
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert-text')?.textContent).toContain('cannot be undone')

    fireEvent.click(alertButton('Cancel'))
    await waitFor(() => expect($('.b-alert')).toBeNull())
    expect(Object.keys(useFs.getState().nodes)).toHaveLength(withFile)
    expect(useFs.getState().nodes['/boot/home/scratch.txt']).toBeTruthy()
  })

  it('restores the seeded disk on confirm', async () => {
    render(<Desktop />)
    await launch('Preferences')

    const seeded = Object.keys(useFs.getState().nodes).length
    writeAFile()

    fireEvent.click(byText('.prefs .b-button', 'Reset disk'))
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    fireEvent.click(alertButton('Reset'))

    await waitFor(() =>
      expect(useFs.getState().nodes['/boot/home/scratch.txt']).toBeUndefined(),
    )
    expect(Object.keys(useFs.getState().nodes)).toHaveLength(seeded)
  })

  it('About offers the same warning, from the same helper', async () => {
    render(<Desktop />)
    await launch('About BeanWeb')

    writeAFile()
    fireEvent.click(byText('.about .b-button', 'Reset disk'))
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert-text')?.textContent).toContain('cannot be undone')

    fireEvent.click(alertButton('Reset'))
    await waitFor(() =>
      expect(useFs.getState().nodes['/boot/home/scratch.txt']).toBeUndefined(),
    )
  })
})

describe('the Preferences icon', () => {
  it('is drawn on the shared 32-unit grid', async () => {
    render(<Desktop />)
    await launch('Preferences')

    const icon = $('.b-deskbar-app-icon')
    expect(icon?.getAttribute('viewBox')).toBe('0 0 32 32')
  })
})

// Nothing here should have hit the network or a real timer.
vi.useRealTimers()
