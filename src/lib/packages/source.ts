/**
 * Where a package comes from.
 *
 * The whole of this feature's future-proofing is these two methods. `UploadSource`
 * below is a file the user picked off their own computer; `coffeeShopSource`
 * (`lib/packages/coffeeshop.ts`) is the app store's catalogue. A third source
 * implements the same interface and nothing else moves, because
 * `apps/CoffeeShop.tsx` renders a non-browsable one as a `File` menu item and
 * `installPackage` takes bytes rather than a `File`.
 *
 * `lib/beanchallenge/packs.ts` is the same shape and the same bet: one built-in
 * today, written so that later ones "join the list returned here and every
 * caller carries on unchanged".
 */

import { pickFiles } from '@/lib/transfer'
import { MAX_PACKAGE_BYTES, PackageError, type PackageKind } from './types'

/** A row in a catalogue, before anything is downloaded. */
export interface PackageListing {
  id: string
  name: string
  version: string
  kind: PackageKind
  summary?: string
  /** The manifest's longer pitch -- see `PackageManifest.description`. */
  description?: string
  publisher?: string
  sizeBytes?: number
  /**
   * The manifest's icon, inlined as raw SVG text so a browsable source can
   * show artwork before anything is fetched. Untrusted -- it comes from
   * whatever the source is, same as an installed package's -- so a renderer
   * must run it through `apps/packageApp.tsx`'s `packageIcon`, never inline it
   * directly. Capped at `MAX_ICON_BYTES`, the same bound `InstalledPackage`
   * holds its own icon to.
   */
  iconSvg?: string
}

export interface PackageSource {
  readonly id: string
  readonly name: string
  /** Whether this source can be browsed. An upload source cannot. */
  readonly browsable: boolean
  /** The catalogue. Empty for a source that has nothing to list. */
  list(query?: string): Promise<PackageListing[]>
  /**
   * The raw `.pkg` bytes. `id` is a listing id for a browsable source; an
   * upload source ignores it and asks the user for a file.
   */
  fetch(id?: string): Promise<Uint8Array | null>
}

const sources = new Map<string, PackageSource>()

export function registerSource(source: PackageSource) {
  sources.set(source.id, source)
}

export function getSource(id: string): PackageSource | undefined {
  return sources.get(id)
}

export function listSources(): PackageSource[] {
  return [...sources.values()]
}

export const UPLOAD_SOURCE_ID = 'upload'

/**
 * The user's own computer.
 *
 * Reads the file as bytes through `pickFiles`, deliberately *not* through
 * `importFiles`: that door is text-only and its `looksBinary` sniff would
 * refuse a zip on the first NUL byte. Nothing is written to the virtual disk
 * here -- an archive is not a document, and `FsNode.content` is a string.
 */
class UploadSource implements PackageSource {
  readonly id = UPLOAD_SOURCE_ID
  readonly name = 'This computer'
  readonly browsable = false

  list(): Promise<PackageListing[]> {
    return Promise.resolve([])
  }

  async fetch(): Promise<Uint8Array | null> {
    const [file] = await pickFiles({ accept: '.pkg', multiple: false })
    if (!file) return null
    if (file.size > MAX_PACKAGE_BYTES) {
      throw new PackageError(`"${file.name}" is larger than ${MAX_PACKAGE_BYTES / 1024} KiB.`)
    }
    return new Uint8Array(await file.arrayBuffer())
  }
}

registerSource(new UploadSource())
