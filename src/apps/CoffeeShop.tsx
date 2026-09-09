import { useCallback, useEffect, useMemo, useState } from 'react'

import { CoffeeShopIcon } from '@/lib/icons'
import { coffeeShopSource } from '@/lib/packages/coffeeshop'
import { PackageError, type InstalledPackage } from '@/lib/packages/types'
import { listSources, type PackageListing, type PackageSource } from '@/lib/packages/source'
import { installPackage, permissionLines, uninstallPackage } from '@/lib/packages/install'
import { packageRoot } from '@/lib/packages/bridge'
import { Box, Button, StatusBar, TextControl } from '@/widgets/controls'
import { MenuBar, type MenuDef } from '@/widgets/Menu'
import { useDesktop } from '@/store/desktop'
import { usePackages } from '@/store/packages'
import { packageIcon } from './packageApp'
import { launchApp, registerApp, type AppProps } from './registry'
import './coffeeshop.css'

/**
 * Coffee Shop: the app store, and the only place a package is installed,
 * removed or browsed from.
 *
 * One window, two panes, the shape SoftwareValet used for the same two
 * questions -- *what is available* and *what is on the disk* -- rather than
 * one screen trying to be both. This used to be that split across two apps
 * (Coffee Shop and the standalone Installer); merging them cost nothing
 * structural, because installing was already one function
 * (`installPackage`, bytes in) that neither app owned -- only the window
 * around it changed.
 *
 * `view` picks which pane is showing; the detail pane and the action row
 * below the list read whichever one is active, so there is one of each
 * rather than two.
 *
 * The two panes are drawn differently on purpose. Browse is a shelf -- a
 * grid of cards, each one the package's *own* icon at 48px -- because
 * artwork is what you have to go on before a package is yours. Installed is
 * an inventory of rows, icon then name then figures, because by then you
 * know what the thing is and are looking for one of them. A column of
 * 16px glyphs beside a table served neither.
 */

type View = 'browse' | 'installed'

const formatSize = (bytes?: number): string =>
  bytes === undefined
    ? '—'
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`

const formatDate = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

export function CoffeeShop({ windowId }: AppProps) {
  const installed = usePackages((s) => s.installed)
  const requestClose = useDesktop((s) => s.requestClose)
  const showAlert = useDesktop((s) => s.showAlert)

  const [view, setView] = useState<View>('browse')
  const [listings, setListings] = useState<PackageListing[]>([])
  const [query, setQuery] = useState('')
  const [selectedBrowseId, setSelectedBrowseId] = useState<string | null>(null)
  const [selectedInstalledId, setSelectedInstalledId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const installedById = useMemo(() => new Map(installed.map((p) => [p.manifest.id, p])), [installed])

  const refresh = useCallback(async (q: string) => {
    setLoading(true)
    setError(null)
    try {
      setListings(await coffeeShopSource.list(q || undefined))
    } catch (err) {
      setListings([])
      setError(err instanceof PackageError ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh('')
    // Only on mount: a search is a deliberate submit, not a live filter, so
    // typing does not refetch on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const browseRows = useMemo(
    () => [...listings].sort((a, b) => a.name.localeCompare(b.name)),
    [listings],
  )
  const installedRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? installed.filter((p) => p.manifest.name.toLowerCase().includes(q)) : installed
    return [...filtered].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  }, [installed, query])

  const currentListing = browseRows.find((l) => l.id === selectedBrowseId)
  const currentListingInstalled = currentListing ? installedById.get(currentListing.id) : undefined
  const currentInstalled: InstalledPackage | undefined = installed.find(
    (p) => p.manifest.id === selectedInstalledId,
  )

  const installFromCatalogue = useCallback(async () => {
    if (!currentListing || busy) return
    setBusy(true)
    try {
      const bytes = await coffeeShopSource.fetch(currentListing.id)
      if (!bytes) return
      await installPackage(bytes, coffeeShopSource.id)
    } catch (err) {
      const message = err instanceof PackageError ? err.message : String(err)
      await showAlert('stop', 'Coffee Shop', message)
    } finally {
      setBusy(false)
    }
  }, [currentListing, busy, showAlert])

  const installFromSource = useCallback(
    async (source: PackageSource) => {
      if (busy) return
      setBusy(true)
      try {
        const bytes = await source.fetch()
        // Null is a cancelled picker, not a failure: say nothing.
        if (!bytes) return
        const result = await installPackage(bytes, source.id)
        if (result.installed) {
          setView('installed')
          setSelectedInstalledId(result.installed.manifest.id)
        }
      } catch (err) {
        const message = err instanceof PackageError ? err.message : String(err)
        await showAlert('stop', 'Coffee Shop', message)
      } finally {
        setBusy(false)
      }
    },
    [busy, showAlert],
  )

  const remove = useCallback(async () => {
    if (!currentInstalled || busy) return
    setBusy(true)
    try {
      if (await uninstallPackage(currentInstalled.manifest.id)) setSelectedInstalledId(null)
    } finally {
      setBusy(false)
    }
  }, [currentInstalled, busy])

  // Every non-browsable source gets its own "Install from X…" item, the way
  // the standalone Installer offered one per source; a browsable source has
  // no menu item because it is a whole pane, not a picker -- Coffee Shop's
  // own catalogue is the *Browse* tab, and it is the only browsable source
  // there is today.
  const uploadSources = useMemo(() => listSources().filter((s) => !s.browsable), [])

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'File',
        items: [
          ...uploadSources.map((source) => ({
            label: `Install from ${source.name}…`,
            disabled: busy,
            onSelect: () => void installFromSource(source),
          })),
          { separator: true },
          {
            label: 'Refresh Catalogue',
            shortcut: 'Alt+R',
            disabled: loading || view !== 'browse',
            onSelect: () => void refresh(query),
          },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      {
        title: 'Help',
        items: [
          // The one thing a store owes a user before they install a stranger's
          // code: what it will be able to do. Its own window rather than an
          // alert, because it is a page with links in it -- see PackageHelp.
          // Launched by id, like every other cross-app launch here: an
          // import would pull one app's module into another's for a string.
          { label: 'About Packages…', onSelect: () => launchApp('packagehelp') },
        ],
      },
    ],
    [busy, installFromSource, loading, query, refresh, requestClose, uploadSources, view, windowId],
  )

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (view === 'browse') void refresh(query)
  }

  const BrowseIcon = packageIcon(currentListing?.iconSvg)
  const InstalledIcon = packageIcon(currentInstalled?.iconSvg)

  return (
    <div className="coffeeshop">
      <MenuBar menus={menus} />

      {/* The window's tab says "Coffee Shop"; this says what a Coffee Shop
          is, which a name on its own cannot. */}
      <header className="coffeeshop-banner">
        <CoffeeShopIcon size={32} className="coffeeshop-banner-icon" />
        <div className="coffeeshop-banner-text">
          <h1>Coffee Shop</h1>
          <p>The BeanWeb app store — browse packages and install them onto this desk.</p>
        </div>
      </header>

      <div className="coffeeshop-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'installed'}
          className="coffeeshop-tab"
          data-active={view === 'installed'}
          onClick={() => setView('installed')}
        >
          Installed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'browse'}
          className="coffeeshop-tab"
          data-active={view === 'browse'}
          onClick={() => setView('browse')}
        >
          Browse
        </button>
      </div>

      <form className="coffeeshop-search" onSubmit={submitSearch}>
        <TextControl
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search"
        />
        {view === 'browse' ? (
          <Button type="submit" disabled={loading}>
            Search
          </Button>
        ) : null}
      </form>

      {view === 'browse' ? (
        <div className="coffeeshop-list b-scroll">
          {error ? (
            <p className="coffeeshop-empty">{error} <em>File → Refresh Catalogue</em> tries again.</p>
          ) : loading && browseRows.length === 0 ? (
            <p className="coffeeshop-empty">Loading…</p>
          ) : browseRows.length === 0 ? (
            <p className="coffeeshop-empty">
              {query ? `Nothing matches "${query}".` : 'Nothing is listed yet.'}
            </p>
          ) : (
            <div className="coffeeshop-grid">
              {browseRows.map((listing) => {
                const CardIcon = packageIcon(listing.iconSvg)
                const onDisk = installedById.get(listing.id)
                return (
                  <button
                    key={listing.id}
                    type="button"
                    className="coffeeshop-card"
                    data-selected={selectedBrowseId === listing.id}
                    aria-pressed={selectedBrowseId === listing.id}
                    onClick={() => setSelectedBrowseId(listing.id)}
                    onDoubleClick={() => {
                      setSelectedBrowseId(listing.id)
                      if (onDisk) launchApp(onDisk.manifest.id)
                    }}
                  >
                    {onDisk ? <span className="coffeeshop-badge">Installed</span> : null}
                    <span className="coffeeshop-card-art">
                      <CardIcon size={48} />
                    </span>
                    <span className="coffeeshop-card-name">{listing.name}</span>
                    <span className="coffeeshop-card-meta">
                      {listing.publisher ?? `Version ${listing.version}`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="coffeeshop-list b-scroll">
          {installedRows.length === 0 ? (
            <p className="coffeeshop-empty">
              {query ? (
                `Nothing installed matches "${query}".`
              ) : (
                <>
                  Nothing is installed yet. <em>File → Install from This computer…</em> takes a{' '}
                  <code>.pkg</code> file, or try the <em>Browse</em> tab.
                </>
              )}
            </p>
          ) : (
            <div className="coffeeshop-rows">
              {installedRows.map((pkg) => {
                const RowIcon = packageIcon(pkg.iconSvg)
                return (
                  <button
                    key={pkg.manifest.id}
                    type="button"
                    className="coffeeshop-row"
                    data-selected={selectedInstalledId === pkg.manifest.id}
                    aria-pressed={selectedInstalledId === pkg.manifest.id}
                    onClick={() => setSelectedInstalledId(pkg.manifest.id)}
                    onDoubleClick={() => launchApp(pkg.manifest.id)}
                  >
                    <span className="coffeeshop-row-art">
                      <RowIcon size={32} />
                    </span>
                    <span className="coffeeshop-row-text">
                      <span className="coffeeshop-row-name">{pkg.manifest.name}</span>
                      <span className="coffeeshop-row-meta">
                        Version {pkg.manifest.version} · {formatSize(pkg.sizeBytes)} · installed{' '}
                        {formatDate(pkg.installedAt)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="coffeeshop-detail">
        {view === 'browse' ? (
          <Box label={currentListing ? currentListing.name : 'Package'}>
            {currentListing ? (
              <div className="coffeeshop-detail-body">
                <span className="coffeeshop-detail-icon">
                  <BrowseIcon size={48} />
                </span>
                <dl className="coffeeshop-specs">
                  <dt>Publisher</dt>
                  <dd>{currentListing.publisher ?? 'Unknown'}</dd>
                  <dt>Identifier</dt>
                  <dd className="b-fixed">{currentListing.id}</dd>
                  <dt>Size</dt>
                  <dd>{formatSize(currentListing.sizeBytes)}</dd>
                  {currentListing.summary ? (
                    <>
                      <dt>About</dt>
                      <dd>{currentListing.summary}</dd>
                    </>
                  ) : null}
                  {currentListing.description ? (
                    <>
                      <dt>Description</dt>
                      <dd className="coffeeshop-description">{currentListing.description}</dd>
                    </>
                  ) : null}
                  {currentListingInstalled ? (
                    <>
                      <dt>Installed</dt>
                      <dd>version {currentListingInstalled.manifest.version}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ) : (
              <p className="coffeeshop-hint">Select a package to see what it is.</p>
            )}
          </Box>
        ) : (
          <Box label={currentInstalled ? currentInstalled.manifest.name : 'Package'}>
            {currentInstalled ? (
              <div className="coffeeshop-detail-body">
                <span className="coffeeshop-detail-icon">
                  <InstalledIcon size={48} />
                </span>
                <dl className="coffeeshop-specs">
                  <dt>Publisher</dt>
                  <dd>{currentInstalled.manifest.publisher ?? 'Unknown'}</dd>
                  <dt>Identifier</dt>
                  <dd className="b-fixed">{currentInstalled.manifest.id}</dd>
                  <dt>Documents</dt>
                  <dd className="b-fixed">{packageRoot(currentInstalled.manifest.id)}</dd>
                  <dt>Access</dt>
                  <dd>
                    {permissionLines(currentInstalled.manifest.permissions).length
                      ? permissionLines(currentInstalled.manifest.permissions).map((line) => (
                          <span key={line} className="coffeeshop-perm">
                            {line}
                          </span>
                        ))
                      : 'None requested'}
                  </dd>
                  {currentInstalled.manifest.summary ? (
                    <>
                      <dt>About</dt>
                      <dd>{currentInstalled.manifest.summary}</dd>
                    </>
                  ) : null}
                  {currentInstalled.manifest.description ? (
                    <>
                      <dt>Description</dt>
                      <dd className="coffeeshop-description">{currentInstalled.manifest.description}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ) : (
              <p className="coffeeshop-hint">Select a package to see what it is and what it may do.</p>
            )}
          </Box>
        )}
      </div>

      <div className="coffeeshop-actions">
        {busy ? <StatusBar value={100} /> : <span className="b-spacer" />}
        {view === 'browse' ? (
          <>
            {currentListingInstalled ? (
              <Button disabled={busy} onClick={() => launchApp(currentListingInstalled.manifest.id)}>
                Open
              </Button>
            ) : null}
            <Button
              disabled={!currentListing || busy}
              onClick={() => void installFromCatalogue()}
              isDefault={!currentListingInstalled}
            >
              {currentListingInstalled ? 'Reinstall…' : 'Install…'}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={!currentInstalled || busy} onClick={() => currentInstalled && launchApp(currentInstalled.manifest.id)}>
              Open
            </Button>
            <Button disabled={!currentInstalled || busy} onClick={() => void remove()}>
              Remove…
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

registerApp({
  id: 'coffeeshop',
  name: 'Coffee Shop',
  component: CoffeeShop,
  icon: CoffeeShopIcon,
  defaultW: 560,
  defaultH: 520,
  minW: 380,
  minH: 340,
  singleton: true,
})
