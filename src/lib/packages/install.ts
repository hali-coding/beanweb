import { registerPackageApp, unregisterPackageApp } from '@/apps/packageApp'
import { getApp } from '@/apps/registry'
import { useDesktop } from '@/store/desktop'
import { joinPath, useFs } from '@/store/fs'
import { deletePayload, usePackages, writePayload } from '@/store/packages'
import { decodeText, readPackage } from './archive'
import { packageRoot } from './bridge'
import { errorsIn, validatePackage, type Problem } from './manifest'
import {
  MAX_ICON_BYTES,
  PERMISSION_LABELS,
  PackageError,
  type InstalledPackage,
  type PackageContents,
  type Permission,
} from './types'

/**
 * Installing and removing a package.
 *
 * One exported function per action, holding its own confirmation wording, for
 * exactly the reason `lib/disk.ts` gives: more than one place calls these --
 * Coffee Shop's *Browse* tab, its *Installed* tab, and its upload item all do
 * -- and what a destructive action says must not be able to drift between
 * them. Reads the stores through `getState()` because these are actions, not
 * subscriptions.
 */

/** Where an installed package's stub appears, so it is in Tracker and `ls`. */
export const APPS_DIR = '/boot/apps'

const known = (p: Permission): boolean => p in PERMISSION_LABELS

/** The permission lines shown in the install confirmation, in the manifest's order. */
export function permissionLines(permissions: readonly Permission[]): string[] {
  return permissions.filter(known).map((p) => `• ${PERMISSION_LABELS[p]}`)
}

function problemText(problems: Problem[]): string {
  return problems.map((p) => `• ${p.message}`).join('\n')
}

/**
 * The name a package's stub takes in `/boot/apps`.
 *
 * The manifest's display name, with the characters a path cannot hold removed.
 * Falls back to the id, which the manifest rules already restrict to something
 * safe.
 */
export function stubPath(name: string, id: string): string {
  const clean = name.replace(/[\/\\]/g, '').trim()
  return joinPath(APPS_DIR, clean || id)
}

export interface InstallResult {
  installed?: InstalledPackage
  /** Why nothing was installed. Absent when the user simply cancelled. */
  error?: string
}

/**
 * Install a package from its archive bytes.
 *
 * Takes bytes rather than a `File` so that the day a store exists it calls this
 * unchanged -- the only thing a source is responsible for is producing them.
 */
export async function installPackage(
  bytes: Uint8Array,
  sourceId: string,
): Promise<InstallResult> {
  const desktop = useDesktop.getState()

  let contents: PackageContents
  try {
    contents = readPackage(bytes)
  } catch (err) {
    const message = err instanceof PackageError ? err.message : String(err)
    await desktop.showAlert('stop', 'Coffee Shop', message)
    return { error: message }
  }

  const { manifest, files } = contents
  const problems = validatePackage(contents)
  const errors = errorsIn(problems)
  if (errors.length) {
    const message = `"${manifest.name || 'This package'}" cannot be installed.\n\n${problemText(errors)}`
    await desktop.showAlert('stop', 'Coffee Shop', message)
    return { error: message }
  }

  /*
   * A package must not be able to take over a built-in app by claiming its id.
   * Checked against the registry rather than the index, because the built-ins
   * are not in the index and are exactly what needs protecting.
   */
  const existing = usePackages.getState().get(manifest.id)
  if (!existing && getApp(manifest.id)) {
    const message = `"${manifest.id}" is already the id of an application here.`
    await desktop.showAlert('stop', 'Coffee Shop', message)
    return { error: message }
  }

  const warnings = problems.filter((p) => p.severity === 'warning')
  const lines = [
    `Install ${manifest.name} ${manifest.version}?`,
    manifest.publisher ? `From ${manifest.publisher}.` : '',
    '',
    manifest.permissions.filter(known).length
      ? `It will be able to:\n${permissionLines(manifest.permissions).join('\n')}`
      : 'It has asked for no special access.',
    warnings.length ? `\nNote:\n${problemText(warnings)}` : '',
    existing ? `\nThis replaces the installed version ${existing.manifest.version}.` : '',
  ]
  const answer = await desktop.showAlert(
    'warn',
    'Coffee Shop',
    lines.filter(Boolean).join('\n'),
    ['Cancel', existing ? 'Replace' : 'Install'],
    1,
  )
  if (answer !== 1) return {}

  const iconBytes = manifest.icon ? files[manifest.icon] : undefined
  const iconSvg =
    iconBytes && iconBytes.byteLength <= MAX_ICON_BYTES ? decodeText(iconBytes) : undefined

  const pkg: InstalledPackage = {
    manifest,
    installedAt: Date.now(),
    sourceId,
    sizeBytes: bytes.byteLength,
    ...(iconSvg ? { iconSvg } : {}),
  }

  /*
   * The payload first. If it cannot be stored there is nothing to run, and
   * recording it as installed anyway would leave a menu entry that opens an
   * empty window for the rest of the profile's life.
   */
  if (!(await writePayload(manifest.id, files))) {
    const message = 'This browser cannot store package files, so nothing was installed.'
    await desktop.showAlert('stop', 'Coffee Shop', message)
    return { error: message }
  }

  if (existing) unregisterPackageApp(manifest.id)
  usePackages.getState().put(pkg)
  registerPackageApp(pkg)

  const fs = useFs.getState()
  const stub = stubPath(manifest.name, manifest.id)
  if (!fs.exists(stub)) fs.mkapp(stub, manifest.id)

  return { installed: pkg }
}

/**
 * Remove a package.
 *
 * Its windows are closed with `requestClose`, not `closeWindow`, so a package
 * holding unsaved work gets the same prompt its close box would give it -- and
 * refusing abandons the uninstall, the way the shutdown sequence does. Its
 * documents under `/boot/home/packages` are left alone, and the confirmation
 * says so: the user's files are not the app's to delete.
 */
export async function uninstallPackage(id: string): Promise<boolean> {
  const desktop = useDesktop.getState()
  const pkg = usePackages.getState().get(id)
  if (!pkg) return false

  const answer = await desktop.showAlert(
    'stop',
    'Coffee Shop',
    `Remove ${pkg.manifest.name} ${pkg.manifest.version}?\n\n` +
      `Its documents in ${packageRoot(id)} are kept.`,
    ['Cancel', 'Remove'],
    0,
  )
  if (answer !== 1) return false

  // Front-most first, as the shutdown sequence does. `requestClose` resolves
  // void, so a refusal shows up as the window still being there afterwards --
  // the same test `quitNext` makes, and for the same reason.
  const order = [...useDesktop.getState().order].reverse()
  for (const winId of order) {
    if (useDesktop.getState().windows[winId]?.appId !== id) continue
    await desktop.requestClose(winId)
    if (useDesktop.getState().windows[winId]) return false
  }

  unregisterPackageApp(id)
  usePackages.getState().drop(id)
  await deletePayload(id)

  const fs = useFs.getState()
  const stub = stubPath(pkg.manifest.name, id)
  if (fs.nodes[stub]?.appId === id) fs.remove(stub)

  return true
}

/**
 * Put every installed package back into the registry.
 *
 * Called from `main.tsx` before the first render, reading the synchronous
 * index: a window restored for a package must be able to resolve its app on the
 * very first pass, or it paints as empty chrome.
 */
export function registerInstalledPackages() {
  for (const pkg of usePackages.getState().installed) registerPackageApp(pkg)
}
