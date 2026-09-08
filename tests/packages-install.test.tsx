// jsdom has no IndexedDB, and package payloads live there. Without this the
// install refuses -- correctly -- with "this browser cannot store package
// files", which is a real code path but not the one these tests are about.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import '@/apps' // side-effect: registers every app
import { Desktop } from '@/shell/Desktop'
import { encodeText, writePackage } from '@/lib/packages/archive'
import { installPackage, stubPath, uninstallPackage } from '@/lib/packages/install'
import { appForFile, getApp, listApps, unregisterApp } from '@/apps/registry'
import type { PackageContents, PackageManifest } from '@/lib/packages/types'
import { useFs } from '@/store/fs'
import { usePackages } from '@/store/packages'

/**
 * `installPackage` and `uninstallPackage` themselves -- the pipeline every
 * source (upload, Coffee Shop's catalogue, and whatever comes after) shares.
 * Deliberately UI-agnostic: these call the functions directly and only need
 * `<Desktop />` mounted for its alert queue, not any particular window open,
 * which is what lets this file stay put now that Coffee Shop's *Installed*
 * tab is what shows the result -- see tests/coffeeshop.test.tsx for that.
 */

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const byText = <T extends Element = HTMLElement>(sel: string, text: string) =>
  $$<T>(sel).find((n) => n.textContent?.includes(text))!

const alertButton = (label: string) =>
  $$<HTMLButtonElement>('.b-alert-buttons .b-button').find((b) => b.textContent === label)!

const PKG = 'com.example.beanpaint'

function pkgBytes(over: Partial<PackageManifest> = {}, files: Record<string, string> = {}) {
  const manifest: PackageManifest = {
    format: 1,
    id: PKG,
    name: 'Bean Paint',
    version: '1.0.0',
    kind: 'sandboxed',
    entry: 'main.js',
    window: { defaultW: 400, defaultH: 300 },
    permissions: [],
    ...over,
  }
  const contents: PackageContents = {
    manifest,
    files: { 'main.js': encodeText('window.bw.setTitle("Bean Paint")') },
  }
  for (const [k, v] of Object.entries(files)) contents.files[k] = encodeText(v)
  return writePackage(contents)
}

/** Install, answering the confirmation. Returns once the package is registered. */
async function install(bytes: Uint8Array) {
  const pending = installPackage(bytes, 'upload')
  await waitFor(() => expect($('.b-alert')).toBeTruthy())
  fireEvent.click(alertButton('Install'))
  return pending
}

/** Clean up the registry: it is a module singleton, like the stores. */
function forget(id: string) {
  unregisterApp(id)
  usePackages.setState({ installed: [] })
}

describe('installing a package', () => {
  it('registers it as an app, in the menu and in /boot/apps', async () => {
    render(<Desktop />)
    expect(getApp(PKG)).toBeUndefined()

    const result = await install(pkgBytes())
    expect(result.installed?.manifest.name).toBe('Bean Paint')

    expect(getApp(PKG)).toBeTruthy()
    expect(listApps().map((a) => a.id)).toContain(PKG)
    expect(useFs.getState().nodes[stubPath('Bean Paint', PKG)]?.appId).toBe(PKG)

    forget(PKG)
  })

  it('appears in the Be menu without a reload', async () => {
    // The regression this whole subscription exists for: the Deskbar used to
    // memoise its menu on a stable action, so it was built once per mount and
    // an app registered afterwards could never show up in it.
    render(<Desktop />)
    fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    expect(byText('.b-menu-item', 'Bean Paint')).toBeUndefined()
    fireEvent.keyDown(window, { key: 'Escape' })

    await install(pkgBytes())

    fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    expect(byText('.b-menu-item', 'Bean Paint')).toBeTruthy()

    forget(PKG)
  })

  it('claims the file types its manifest declares', async () => {
    render(<Desktop />)
    expect(appForFile('sketch.bpaint')).toBeUndefined()

    await install(pkgBytes({ extensions: ['.bpaint'] }))
    expect(appForFile('sketch.bpaint')?.id).toBe(PKG)
    // The built-ins still own theirs.
    expect(appForFile('hello.bas')?.id).toBe('basic')

    forget(PKG)
  })

  it('can be cancelled, and then nothing is installed', async () => {
    render(<Desktop />)
    const pending = installPackage(pkgBytes(), 'upload')
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    fireEvent.click(alertButton('Cancel'))

    expect(await pending).toEqual({})
    expect(getApp(PKG)).toBeUndefined()
    expect(usePackages.getState().installed).toHaveLength(0)
  })

  it('refuses a package whose manifest does not validate', async () => {
    render(<Desktop />)
    const pending = installPackage(pkgBytes({ id: 'nodots' }), 'upload')
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert-text')?.textContent).toMatch(/reverse-DNS/)
    fireEvent.click(alertButton('OK'))

    expect(await pending).toHaveProperty('error')
    expect(usePackages.getState().installed).toHaveLength(0)
  })

  it('refuses to take over a built-in application id', async () => {
    render(<Desktop />)
    // 'terminal' is not reverse-DNS, so use an id that passes validation and
    // then register a built-in under it for the length of the test.
    const clash = 'com.beanweb.decoy'
    const real = getApp('terminal')!
    const { registerApp } = await import('@/apps/registry')
    registerApp({ ...real, id: clash })

    const pending = installPackage(pkgBytes({ id: clash }), 'upload')
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert-text')?.textContent).toMatch(/already the id of an application/)
    fireEvent.click(alertButton('OK'))

    expect(await pending).toHaveProperty('error')
    unregisterApp(clash)
  })

  it('names the access it wants in the confirmation', async () => {
    render(<Desktop />)
    const pending = installPackage(pkgBytes({ permissions: ['fs'] }), 'upload')
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert-text')?.textContent).toMatch(/Read and write files in its own folder/)
    fireEvent.click(alertButton('Install'))
    await pending

    forget(PKG)
  })
})

describe('uninstalling a package', () => {
  it('takes it out of the registry, the menu and /boot/apps', async () => {
    render(<Desktop />)
    await install(pkgBytes())

    const pending = uninstallPackage(PKG)
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    fireEvent.click(alertButton('Remove'))
    expect(await pending).toBe(true)

    expect(getApp(PKG)).toBeUndefined()
    expect(usePackages.getState().installed).toHaveLength(0)
    expect(useFs.getState().nodes[stubPath('Bean Paint', PKG)]).toBeUndefined()
  })

  it('keeps the package if the confirmation is declined', async () => {
    render(<Desktop />)
    await install(pkgBytes())

    const pending = uninstallPackage(PKG)
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    fireEvent.click(alertButton('Cancel'))
    expect(await pending).toBe(false)
    expect(getApp(PKG)).toBeTruthy()

    forget(PKG)
  })
})
