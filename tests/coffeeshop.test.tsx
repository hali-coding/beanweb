import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import '@/apps' // side-effect: registers every app, including Coffee Shop

import { Desktop } from '@/shell/Desktop'
import { encodeText, writePackage } from '@/lib/packages/archive'
import { BASE_URL } from '@/lib/packages/coffeeshop'
import { installPackage } from '@/lib/packages/install'
import { getApp, unregisterApp } from '@/apps/registry'
import type { PackageContents, PackageManifest } from '@/lib/packages/types'
import { usePackages } from '@/store/packages'

/**
 * Coffee Shop: the merged app -- Installed and Browse in one window. Browse
 * exercises a mocked backend end to end (list, search, install); Installed
 * exercises what used to be the standalone Installer's window (list, detail,
 * permissions, remove). The install/uninstall pipeline itself, which both
 * paths and `File → Install from This computer…` all call, has its own
 * UI-agnostic coverage in tests/packages-install.test.tsx.
 *
 * Browse is the tab shown on launch -- Coffee Shop is a store first, and
 * checking what is already installed is one click away rather than the
 * default. Tests below rely on that: Browse tests need no tab switch, and
 * Installed tests start with `goInstalled()`.
 */

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const byText = <T extends Element = HTMLElement>(sel: string, text: string) =>
  $$<T>(sel).find((n) => n.textContent?.includes(text))!

const launch = async (name: string) => {
  const before = $$('.b-window').length
  fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
  await waitFor(() => expect($('.b-menu')).toBeTruthy())
  fireEvent.click(byText('.b-menu-item', name))
  await waitFor(() => expect($$('.b-window')).toHaveLength(before + 1))
}

const goInstalled = () => fireEvent.click(byText('.coffeeshop-tab', 'Installed'))

const alertButton = (label: string) =>
  $$<HTMLButtonElement>('.b-alert-buttons .b-button').find((b) => b.textContent === label)!

const PKG = 'com.example.beanpaint'

function pkgBytes(over: Partial<PackageManifest> = {}): Uint8Array {
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
  return writePackage(contents)
}

/* A listing's own artwork, the thing Browse leads with. Deliberately carries
   an `onload` so the sanitiser's work is visible in the assertion below: the
   icon is markup from a stranger rendered into this page. */
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" onload="alert(1)">' +
  '<rect x="4" y="4" width="24" height="24" fill="#c05"/></svg>'

const LISTING = {
  id: PKG,
  name: 'Bean Paint',
  version: '1.0.0',
  kind: 'sandboxed',
  summary: 'A small painting program.',
  description: 'A longer pitch for Bean Paint.\n\nWith a second paragraph.',
  publisher: 'Example',
  sizeBytes: 1234,
  iconSvg: ICON,
}

function mockBackend(bytes: Uint8Array) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === `${BASE_URL}/packages`) return new Response(JSON.stringify([LISTING]))
      if (url === `${BASE_URL}/packages?q=paint`) return new Response(JSON.stringify([LISTING]))
      if (url === `${BASE_URL}/packages?q=nothing-matches`) return new Response(JSON.stringify([]))
      if (url === `${BASE_URL}/packages/${PKG}/download`) return new Response(new Uint8Array(bytes))
      return new Response('not found', { status: 404 })
    }),
  )
}

/** Install, answering the confirmation. Returns once the package is registered. */
async function install(bytes: Uint8Array) {
  mockBackend(bytes)
  const pending = installPackage(bytes, 'upload')
  await waitFor(() => expect($('.b-alert')).toBeTruthy())
  fireEvent.click(alertButton('Install'))
  return pending
}

afterEach(() => {
  vi.unstubAllGlobals()
  if (getApp(PKG)) unregisterApp(PKG)
  usePackages.setState({ installed: [] })
})

describe('Coffee Shop — Browse', () => {
  it('is the tab shown on launch, and is a singleton', async () => {
    render(<Desktop />)
    await launch('Coffee Shop')
    expect($('.coffeeshop-tab[data-active="true"]')?.textContent).toBe('Browse')

    const count = $$('.b-window').length
    fireEvent.pointerDown($('.b-deskbar-logo')!, { button: 0 })
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    fireEvent.click(byText('.b-menu-item', 'Coffee Shop'))
    expect($$('.b-window')).toHaveLength(count)
  })

  it('lists what the backend serves and shows the selected package, description included', async () => {
    mockBackend(pkgBytes())
    render(<Desktop />)
    await launch('Coffee Shop')

    await waitFor(() => expect(byText('.coffeeshop-card', 'Bean Paint')).toBeTruthy())
    fireEvent.click(byText('.coffeeshop-card', 'Bean Paint'))

    await waitFor(() => expect(byText('.coffeeshop-specs dd', 'Example')).toBeTruthy())
    expect(byText('.coffeeshop-specs dd', 'A small painting program.')).toBeTruthy()
    expect($('.coffeeshop-description')?.textContent).toBe(LISTING.description)
  })

  it('says on screen what the window is', async () => {
    // The tab reads "Coffee Shop", which names the app without saying what it
    // is for; the banner is the sentence under it.
    render(<Desktop />)
    await launch('Coffee Shop')
    expect($('.coffeeshop-banner h1')?.textContent).toBe('Coffee Shop')
    expect($('.coffeeshop-banner p')?.textContent).toMatch(/BeanWeb app store/)
  })

  it("leads with the package's own artwork, sanitised", async () => {
    mockBackend(pkgBytes())
    render(<Desktop />)
    await launch('Coffee Shop')

    await waitFor(() => expect(byText('.coffeeshop-card', 'Bean Paint')).toBeTruthy())
    const art = $('.coffeeshop-card-art svg')!
    expect(art).toBeTruthy()
    expect(art.querySelector('rect')?.getAttribute('fill')).toBe('#c05')
    expect(art.getAttribute('onload')).toBeNull()
  })

  it('searches the backend by query', async () => {
    mockBackend(pkgBytes())
    render(<Desktop />)
    await launch('Coffee Shop')
    await waitFor(() => expect(byText('.coffeeshop-card', 'Bean Paint')).toBeTruthy())

    fireEvent.change($('.coffeeshop-search input')!, { target: { value: 'nothing-matches' } })
    fireEvent.submit($('.coffeeshop-search')!)
    await waitFor(() => expect($('.coffeeshop-grid')).toBeFalsy())
    expect($('.coffeeshop-empty')?.textContent).toMatch(/nothing-matches/)
  })

  it('installs the selected package through the normal confirmation', async () => {
    mockBackend(pkgBytes())
    render(<Desktop />)
    await launch('Coffee Shop')
    await waitFor(() => expect(byText('.coffeeshop-card', 'Bean Paint')).toBeTruthy())
    fireEvent.click(byText('.coffeeshop-card', 'Bean Paint'))

    fireEvent.click(byText('.coffeeshop-actions .b-button', 'Install'))
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert')?.textContent).toMatch(/Install Bean Paint 1\.0\.0/)
    fireEvent.click(alertButton('Install'))

    await waitFor(() => expect(getApp(PKG)).toBeTruthy())
    expect(usePackages.getState().get(PKG)?.sourceId).toBe('coffeeshop')
  })

  it('shows a network failure inline instead of crashing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    render(<Desktop />)
    await launch('Coffee Shop')
    await waitFor(() => expect($('.coffeeshop-empty')?.textContent).toMatch(/Coffee Shop server/))
  })
})

describe('Coffee Shop — Installed', () => {
  it('says so when nothing is installed', async () => {
    render(<Desktop />)
    await launch('Coffee Shop')
    goInstalled()
    expect($('.coffeeshop-empty')?.textContent).toMatch(/Nothing is installed yet/)
  })

  it('lists an installed package and shows its detail, including permissions and description', async () => {
    render(<Desktop />)
    await launch('Coffee Shop')
    await install(
      pkgBytes({
        publisher: 'Example',
        permissions: ['fs'],
        description: 'A longer pitch.\n\nWith a second paragraph.',
      }),
    )
    goInstalled()

    await waitFor(() => expect($('.coffeeshop-rows')).toBeTruthy())
    const row = byText('.coffeeshop-row', 'Bean Paint')
    expect(row).toBeTruthy()

    fireEvent.click(row)
    await waitFor(() => expect($('.coffeeshop-specs')).toBeTruthy())
    const specs = $('.coffeeshop-specs')!.textContent!
    expect(specs).toContain('Example')
    expect(specs).toContain(PKG)
    expect(specs).toMatch(/Read and write files/)
    expect($('.coffeeshop-description')?.textContent).toBe('A longer pitch.\n\nWith a second paragraph.')
  })

  it('removes a package through the normal confirmation', async () => {
    render(<Desktop />)
    await launch('Coffee Shop')
    await install(pkgBytes())
    goInstalled()
    await waitFor(() => expect(byText('.coffeeshop-row', 'Bean Paint')).toBeTruthy())
    fireEvent.click(byText('.coffeeshop-row', 'Bean Paint'))

    fireEvent.click(byText('.coffeeshop-actions .b-button', 'Remove'))
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    fireEvent.click(alertButton('Remove'))

    await waitFor(() => expect(getApp(PKG)).toBeUndefined())
    expect($('.coffeeshop-empty')?.textContent).toMatch(/Nothing is installed yet/)
  })

  it('opens the sandbox explainer from Help, and says what a package cannot do', async () => {
    // The one thing a store owes a user before they run a stranger's code.
    // Its own window, so it can carry the link to the examples; launched by
    // id, so nothing here imports the help app.
    render(<Desktop />)
    await launch('Coffee Shop')

    fireEvent.pointerDown(byText('.b-window--active .b-menubar-item', 'Help'))
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    fireEvent.click(byText('.b-menu-item', 'About Packages…'))

    await waitFor(() => expect($('.pkghelp')).toBeTruthy())
    const text = $('.pkghelp')!.textContent!
    expect(text).toMatch(/allow-scripts/)
    expect(text).toMatch(/without/)
    expect(text).toMatch(/allow-same-origin/)
    expect(text).toMatch(/connect-src 'none'/)
    expect($<HTMLAnchorElement>('.pkghelp-link')?.href).toBe(
      'https://github.com/hali-coding/beanweb/tree/main/pkgs',
    )
  })

  it('offers a File menu item for every non-browsable source', async () => {
    // UploadSource opens the host's own file picker, which jsdom cannot
    // drive -- there is nothing here to click through to a result. What this
    // asserts is the wiring: the item exists, is not disabled, and is not
    // the browsable Coffee Shop source, which has no menu item of its own
    // (it is the whole *Browse* tab instead). What happens once
    // `installPackage` actually runs is tests/packages-install.test.tsx.
    render(<Desktop />)
    await launch('Coffee Shop')

    fireEvent.pointerDown(byText('.b-window--active .b-menubar-item', 'File'))
    await waitFor(() => expect($('.b-menu')).toBeTruthy())
    const item = byText<HTMLButtonElement>('.b-menu-item', 'Install from This computer…')
    expect(item).toBeTruthy()
    expect(item.disabled).toBe(false)
    expect(byText('.b-menu-item', 'Browse Coffee Shop')).toBeUndefined()
  })
})
