import { describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import '@/apps' // side-effect: registers every app

import { Desktop } from '@/shell/Desktop'
import { useFs } from '@/store/fs'

/**
 * Right-click menus.
 *
 * One mechanism -- `useContextMenu` in widgets/Menu.tsx -- reached from four
 * places, so these tests are mostly about *which* menu comes up where, and
 * about the two rules that are easy to break: an item menu acts on the item
 * under the pointer, and a text field keeps the browser's own menu because
 * ours cannot paste.
 */

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
/** Item labels only: the shortcut is a sibling span inside the same button. */
const labels = () => $$('.b-menu-item').map((n) => n.querySelectorAll('span')[1]?.textContent)
const byText = <T extends Element = HTMLElement>(sel: string, text: string) =>
  $$<T>(sel).find((n) => n.textContent?.includes(text))!

const titles = () => $$('.b-window-title').map((n) => n.textContent)

describe('right-click menus', () => {
  it('gives the desktop the Be menu, and only on the desktop itself', async () => {
    render(<Desktop />)
    await waitFor(() => expect($('.b-window')).toBeTruthy())

    fireEvent.contextMenu($('.b-workspace')!)
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    expect(labels()).toContain('Terminal')
    expect(labels()).toContain('Shut Down')

    // An event that merely bubbled up from a window is not the desktop's.
    fireEvent.pointerDown(document.body)
    fireEvent.contextMenu($('.b-window')!)
    expect($('.b-menu')).toBeFalsy()
  })

  it('offers Open on a desktop icon, and a shell in a folder', async () => {
    render(<Desktop />)
    await waitFor(() => expect($('.b-window')).toBeTruthy())

    fireEvent.contextMenu(byText('.b-desktop-icon', 'home'))
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    expect(labels()).toEqual(['Open', 'Open Terminal here'])

    fireEvent.click(byText('.b-menu-item', 'Open Terminal here'))
    await waitFor(() => expect(titles()).toContain('Terminal'))
  })

  it('acts on the file under the pointer, not on what was selected before', async () => {
    render(<Desktop />)
    await waitFor(() => expect($('.b-window')).toBeTruthy())

    const icons = () => $$('.tracker-icon')
    await waitFor(() => expect(icons().length).toBeGreaterThan(1))
    fireEvent.click(byText('.tracker-icon', 'config'))
    expect($('.tracker-status')?.textContent).toContain('config')

    fireEvent.contextMenu(byText('.tracker-icon', 'readme.txt'))
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    // Selection followed the pointer, so Move to Trash cannot hit `config`.
    expect($('.tracker-status')?.textContent).toContain('readme.txt')
    expect(labels()).toContain('Export…')

    fireEvent.click(byText('.b-menu-item', 'Move to Trash'))
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert')?.textContent).toMatch(/readme\.txt/)
  })

  it('offers the folder actions on empty space in a Tracker window', async () => {
    render(<Desktop />)
    await waitFor(() => expect($('.tracker-view')).toBeTruthy())

    fireEvent.contextMenu($('.tracker-view')!)
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    expect(labels()).toContain('New folder')
    expect(labels()).toContain('Icon view')

    const before = Object.keys(useFs.getState().nodes).length
    fireEvent.click(byText('.b-menu-item', 'New folder'))
    expect(Object.keys(useFs.getState().nodes).length).toBe(before + 1)
  })

  it("closes a window from its tab, through the guard's route", async () => {
    render(<Desktop />)
    await waitFor(() => expect(titles()).toEqual(['home']))

    fireEvent.contextMenu($('.b-window-tab')!)
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    expect(labels()).toEqual(['Zoom', 'Hide', 'Close'])

    fireEvent.click(byText('.b-menu-item', 'Close'))
    await waitFor(() => expect($$('.b-window')).toHaveLength(0))
  })
})
