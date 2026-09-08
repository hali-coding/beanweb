/**
 * The model behind an installable app package.
 *
 * Pure data with no DOM, like `lib/draw/types.ts` and `lib/basic/screen.ts`,
 * which is what puts the whole format layer inside the jsdom suite.
 *
 * A package is a zip called `.pkg` -- R5's own installer format, so the
 * extension is in keeping -- holding a `manifest.json`, an entry script and
 * whatever else the app needs. Nothing in here knows how a package is stored
 * or run; `store/packages.ts` owns the first and `apps/SandboxHost.tsx` the
 * second.
 */

/** Bumped only for a change that an older BeanWeb could not read. */
export const FORMAT = 1

/**
 * Cap on the archive as it arrives. `lib/transfer.ts` caps a text import at
 * 512 KiB because the disk shares one ~5 MB localStorage key; package payloads
 * go to IndexedDB instead and so escape that budget, but an unbounded package
 * is still a way to fill someone's profile.
 */
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024

/**
 * Cap on the *unpacked* total, checked against the sizes the zip declares
 * before anything is decompressed. Deflate reaches ratios near 1000:1, so
 * without this a 2 MiB archive that passes the cap above can still ask for a
 * couple of gigabytes and take the tab with it.
 */
export const MAX_UNPACKED_BYTES = 8 * 1024 * 1024

/**
 * How the package's code is run. One kind today; the field exists because the
 * question "what runs this?" is exactly what a second kind would answer, and
 * retrofitting it into a published format is not possible.
 */
export type PackageKind = 'sandboxed'

/**
 * What a package may ask the host to do on its behalf. Declared up front so
 * the install confirmation can name it, which is also the field a future
 * store's review would read.
 */
export type Permission = 'fs'

export const PERMISSIONS: readonly Permission[] = ['fs']

/** Human wording for the install confirmation, so a user can weigh the ask. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  fs: 'Read and write files in its own folder',
}

export interface PackageWindow {
  defaultW: number
  defaultH: number
  minW?: number
  minH?: number
}

export interface PackageManifest {
  format: number
  /** Reverse-DNS. The install key, the app id, and the folder name. */
  id: string
  name: string
  version: string
  kind: PackageKind
  /** Path within the archive of the script the sandbox loads. */
  entry: string
  publisher?: string
  summary?: string
  /** Path within the archive of an SVG icon on the usual 32-unit grid. */
  icon?: string
  window: PackageWindow
  singleton?: boolean
  /** File types this app claims, e.g. ['.bpaint']. Lower case, with the dot. */
  extensions?: string[]
  permissions: Permission[]
}

/** Every entry in the archive, keyed by its path within it. */
export type PackageFiles = Record<string, Uint8Array>

export interface PackageContents {
  manifest: PackageManifest
  files: PackageFiles
}

/**
 * Cap on the icon kept in the index. An icon is a few hundred bytes of SVG;
 * anything of this size is not an icon and does not belong in a record that is
 * read synchronously on every boot.
 */
export const MAX_ICON_BYTES = 16 * 1024

/** The index record. Deliberately holds no payload -- see `store/packages.ts`. */
export interface InstalledPackage {
  manifest: PackageManifest
  installedAt: number
  /** Which `PackageSource` it came from, for the Installer's listing. */
  sourceId: string
  sizeBytes: number
  /**
   * The icon's SVG, sanitised at install.
   *
   * The one piece of the payload that lives in the index, because the Deskbar
   * and Tracker need it during the synchronous boot registration and the
   * payload is not there yet. Everything else waits for a window to open.
   */
  iconSvg?: string
}

/** Structural failures: not a zip, no manifest, manifest is not JSON. */
export class PackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackageError'
  }
}
