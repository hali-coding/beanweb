/**
 * Coffee Shop: the app store `PackageSource`.
 *
 * A second source next to `UploadSource` in `source.ts`, exactly the seam
 * `docs/packages.md`'s "Adding a source" section describes -- browsable, reads
 * an HTTP endpoint, and `installPackage` takes the bytes it returns without
 * caring where they came from. The endpoint is `coffeeshop/`, a standalone
 * Node service (own README) that scans a directory of `.pkg` files; this file
 * is only the client for it.
 *
 * `BASE_URL` is a same-origin path rather than a full URL on purpose: the
 * server is meant to sit behind Apache at exactly this path
 * (`coffeeshop/README.md`'s `ProxyPass` lines), so a relative fetch is what
 * makes moving between "backend on a dev port" and "reverse-proxied in
 * production" not a code change.
 */

import { MAX_ICON_BYTES, MAX_PACKAGE_BYTES, PackageError, type PackageKind } from './types'
import { registerSource, type PackageListing, type PackageSource } from './source'

export const COFFEESHOP_SOURCE_ID = 'coffeeshop'
export const BASE_URL = '/api/coffeeshop'

const KINDS: readonly PackageKind[] = ['sandboxed']

/**
 * Everything the network handed back is untrusted input, the same stance
 * `store/packages.ts`'s `load()` takes on what came out of `localStorage`. A
 * row missing what a listing needs is dropped rather than crashing the whole
 * browse -- one malformed entry in someone else's index must not blank the
 * catalogue.
 */
function toListing(raw: unknown): PackageListing | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string' || !r.name) return null
  if (typeof r.version !== 'string' || !r.version) return null
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind as PackageKind)) return null

  const iconSvg =
    typeof r.iconSvg === 'string' && r.iconSvg.length <= MAX_ICON_BYTES ? r.iconSvg : undefined

  return {
    id: r.id,
    name: r.name,
    version: r.version,
    kind: r.kind as PackageKind,
    ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(typeof r.publisher === 'string' ? { publisher: r.publisher } : {}),
    ...(typeof r.sizeBytes === 'number' ? { sizeBytes: r.sizeBytes } : {}),
    ...(iconSvg ? { iconSvg } : {}),
  }
}

async function getJson(path: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(path)
  } catch {
    throw new PackageError('Could not reach the Coffee Shop server.')
  }
  if (!res.ok) {
    throw new PackageError(
      res.status === 404 ? 'That package is no longer listed.' : `The Coffee Shop server said ${res.status}.`,
    )
  }
  try {
    return await res.json()
  } catch {
    throw new PackageError('The Coffee Shop server sent something that was not JSON.')
  }
}

class CoffeeShopSource implements PackageSource {
  readonly id = COFFEESHOP_SOURCE_ID
  readonly name = 'Coffee Shop'
  readonly browsable = true

  async list(query?: string): Promise<PackageListing[]> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : ''
    const body = await getJson(`${BASE_URL}/packages${qs}`)
    if (!Array.isArray(body)) throw new PackageError('The Coffee Shop server sent an unexpected reply.')
    return body.map(toListing).filter((l): l is PackageListing => l !== null)
  }

  async fetch(id?: string): Promise<Uint8Array | null> {
    if (!id) return null

    let res: Response
    try {
      res = await fetch(`${BASE_URL}/packages/${encodeURIComponent(id)}/download`)
    } catch {
      throw new PackageError('Could not reach the Coffee Shop server.')
    }
    if (!res.ok) {
      throw new PackageError(
        res.status === 404 ? 'That package is no longer available.' : `The Coffee Shop server said ${res.status}.`,
      )
    }

    const bytes = new Uint8Array(await res.arrayBuffer())
    // The server enforces this too; checked again here for the same reason
    // `UploadSource` checks a picked file's size before handing it on --
    // `installPackage` should never be the first thing to notice.
    if (bytes.byteLength > MAX_PACKAGE_BYTES) {
      throw new PackageError(`That package is larger than ${MAX_PACKAGE_BYTES / 1024} KiB.`)
    }
    return bytes
  }
}

export const coffeeShopSource = new CoffeeShopSource()
registerSource(coffeeShopSource)
