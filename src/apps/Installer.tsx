import { useCallback, useMemo, useState } from 'react'

import { InstallerIcon } from '@/lib/icons'
import { PackageError } from '@/lib/packages/types'
import { installPackage, permissionLines, uninstallPackage } from '@/lib/packages/install'
import { listSources, UPLOAD_SOURCE_ID } from '@/lib/packages/source'
import { packageRoot } from '@/lib/packages/bridge'
import { Box, Button, StatusBar } from '@/widgets/controls'
import { MenuBar, type MenuDef } from '@/widgets/Menu'
import { useDesktop } from '@/store/desktop'
import { usePackages } from '@/store/packages'
import { launchApp, registerApp, type AppProps } from './registry'
import './installer.css'

/**
 * What is installed, and how to install more.
 *
 * R5 shipped SoftwareValet for this; the shape here is the same idea in one
 * window -- a list of what is on the disk, a detail pane for the selected row,
 * and the two actions that change either.
 *
 * The source list is rendered from `listSources()` even though there is exactly
 * one source today. That is the seam an app store arrives through: a second
 * `PackageSource` appears in this menu and everything below it already works,
 * because installing takes bytes and does not care where they came from.
 */

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`

const formatDate = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

export function Installer({ windowId }: AppProps) {
  const installed = usePackages((s) => s.installed)
  const requestClose = useDesktop((s) => s.requestClose)
  const showAlert = useDesktop((s) => s.showAlert)

  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(
    () => [...installed].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
    [installed],
  )
  const current = rows.find((p) => p.manifest.id === selected)

  const install = useCallback(
    async (sourceId: string) => {
      const source = listSources().find((s) => s.id === sourceId)
      if (!source || busy) return
      setBusy(true)
      try {
        const bytes = await source.fetch()
        // Null is a cancelled picker, not a failure: say nothing.
        if (!bytes) return
        const result = await installPackage(bytes, source.id)
        if (result.installed) setSelected(result.installed.manifest.id)
      } catch (err) {
        const message = err instanceof PackageError ? err.message : String(err)
        await showAlert('stop', 'Installer', message)
      } finally {
        setBusy(false)
      }
    },
    [busy, showAlert],
  )

  const remove = useCallback(async () => {
    if (!current || busy) return
    setBusy(true)
    try {
      if (await uninstallPackage(current.manifest.id)) setSelected(null)
    } finally {
      setBusy(false)
    }
  }, [current, busy])

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'File',
        items: [
          ...listSources().map((source) => ({
            label: source.browsable ? `Browse ${source.name}…` : `Install from ${source.name}…`,
            disabled: busy,
            onSelect: () => void install(source.id),
          })),
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      {
        title: 'Package',
        items: [
          {
            label: 'Open',
            disabled: !current || busy,
            onSelect: () => current && launchApp(current.manifest.id),
          },
          {
            label: 'Remove…',
            disabled: !current || busy,
            onSelect: () => void remove(),
          },
        ],
      },
    ],
    [busy, current, install, remove, requestClose, windowId],
  )

  return (
    <div className="installer">
      <MenuBar menus={menus} />

      <div className="installer-list b-scroll">
        {rows.length === 0 ? (
          <p className="installer-empty">
            Nothing is installed yet. <em>File → Install from this computer…</em> takes a{' '}
            <code>.pkg</code> file.
          </p>
        ) : (
          <table className="installer-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Version</th>
                <th>Size</th>
                <th>Installed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((pkg) => (
                <tr
                  key={pkg.manifest.id}
                  data-selected={selected === pkg.manifest.id}
                  onClick={() => setSelected(pkg.manifest.id)}
                  onDoubleClick={() => launchApp(pkg.manifest.id)}
                >
                  <td>{pkg.manifest.name}</td>
                  <td>{pkg.manifest.version}</td>
                  <td className="installer-num">{formatSize(pkg.sizeBytes)}</td>
                  <td>{formatDate(pkg.installedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="installer-detail">
        <Box label={current ? current.manifest.name : 'Package'}>
          {current ? (
            <dl className="installer-specs">
              <dt>Publisher</dt>
              <dd>{current.manifest.publisher ?? 'Unknown'}</dd>
              <dt>Identifier</dt>
              <dd className="b-fixed">{current.manifest.id}</dd>
              <dt>Documents</dt>
              <dd className="b-fixed">{packageRoot(current.manifest.id)}</dd>
              <dt>Access</dt>
              <dd>
                {permissionLines(current.manifest.permissions).length
                  ? permissionLines(current.manifest.permissions).map((line) => (
                      <span key={line} className="installer-perm">
                        {line}
                      </span>
                    ))
                  : 'None requested'}
              </dd>
              {current.manifest.summary ? (
                <>
                  <dt>About</dt>
                  <dd>{current.manifest.summary}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="installer-hint">Select a package to see what it is and what it may do.</p>
          )}
        </Box>
      </div>

      <div className="installer-actions">
        {busy ? <StatusBar value={100} /> : <span className="b-spacer" />}
        <Button disabled={busy} onClick={() => void install(UPLOAD_SOURCE_ID)}>
          Install…
        </Button>
        <Button disabled={!current || busy} onClick={() => void remove()}>
          Remove…
        </Button>
      </div>
    </div>
  )
}

registerApp({
  id: 'installer',
  name: 'Installer',
  component: Installer,
  icon: InstallerIcon,
  defaultW: 460,
  defaultH: 400,
  minW: 340,
  minH: 280,
  singleton: true,
})
