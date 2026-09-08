/**
 * Scanning a directory of `.pkg` files into a catalogue.
 *
 * The Coffee Shop backend's whole job: read every `.pkg` in `PKG_DIR`, pull its
 * `manifest.json` out of the zip, and keep enough of each one in memory to
 * answer a browse. `server.mjs` is the only thing that talks HTTP; everything
 * here is pure enough to run under `node --test` with a temp directory and no
 * server at all.
 *
 * Deliberately independent of `src/` -- same reasoning `pkgs/build.mjs` gives
 * for itself: this could move to its own repository unchanged, which is also
 * what keeps a change to the on-disk `.pkg` format from silently drifting out
 * of step between the two. The format is `docs/packages.md`; the two constants
 * below are its Limits table, copied rather than imported.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

/** Mirrors `MAX_PACKAGE_BYTES` in `src/lib/packages/types.ts`. */
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024
/** Mirrors `MAX_ICON_BYTES` in `src/lib/packages/types.ts`. */
export const MAX_ICON_BYTES = 16 * 1024

const MANIFEST_NAME = 'manifest.json'
const decoder = new TextDecoder()

/**
 * Read one `.pkg` file into a catalogue row plus the bits needed to serve it
 * again later. Returns `null` for anything that is not a readable package --
 * scanning is best-effort, so one bad file must not take the rest of the
 * catalogue down with it.
 */
export function readEntry(dir, filename) {
  const full = join(dir, filename)
  let bytes
  try {
    bytes = readFileSync(full)
  } catch (err) {
    return { error: `${filename}: cannot read (${err.message})` }
  }

  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    return { error: `${filename}: larger than ${MAX_PACKAGE_BYTES / 1024} KiB, skipped` }
  }

  let unzipped
  try {
    unzipped = unzipSync(bytes)
  } catch (err) {
    return { error: `${filename}: not a readable archive (${err.message})` }
  }

  const manifestBytes = unzipped[MANIFEST_NAME]
  if (!manifestBytes) return { error: `${filename}: no ${MANIFEST_NAME}` }

  let manifest
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes))
  } catch (err) {
    return { error: `${filename}: manifest.json is not JSON (${err.message})` }
  }

  for (const field of ['id', 'name', 'version', 'kind']) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      return { error: `${filename}: manifest has no "${field}"` }
    }
  }

  let iconSvg
  if (typeof manifest.icon === 'string' && unzipped[manifest.icon]) {
    const iconBytes = unzipped[manifest.icon]
    if (iconBytes.byteLength <= MAX_ICON_BYTES) iconSvg = decoder.decode(iconBytes)
  }

  return {
    listing: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      ...(manifest.summary ? { summary: manifest.summary } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.publisher ? { publisher: manifest.publisher } : {}),
      ...(iconSvg ? { iconSvg } : {}),
      sizeBytes: bytes.byteLength,
    },
    filename,
  }
}

/**
 * Build the catalogue from every `.pkg` in `dir`.
 *
 * `entries` is filename order, which is not publish order -- there is no
 * timestamp inside a `.pkg` worth trusting for that (`archive.ts` pins every
 * one to the same fixed mtime for reproducible builds). A store with an actual
 * publish date is a `PackageSource` this server has no opinion about.
 *
 * Two files claiming the same id is a publishing mistake, not a format
 * question, so the first one found wins and the rest are reported as warnings
 * rather than silently overwriting the index -- the same "forward compatible,
 * fail soft, but say why" shape `docs/packages.md` uses for an unknown
 * permission.
 */
export function buildIndex(dir) {
  const warnings = []
  const listings = []
  /** id -> { filename, sizeBytes } for the download route. */
  const byId = new Map()

  let names
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.pkg') && statFileSafe(dir, n))
  } catch (err) {
    return { listings: [], byId, warnings: [`cannot read ${dir}: ${err.message}`], scannedAt: Date.now() }
  }

  for (const filename of names.sort()) {
    const result = readEntry(dir, filename)
    if (result.error) {
      warnings.push(result.error)
      continue
    }
    const { listing, filename: file } = result
    if (byId.has(listing.id)) {
      warnings.push(`${file}: duplicate id "${listing.id}", ignored (kept ${byId.get(listing.id).filename})`)
      continue
    }
    byId.set(listing.id, { filename: file, sizeBytes: listing.sizeBytes })
    listings.push(listing)
  }

  return { listings, byId, warnings, scannedAt: Date.now() }
}

function statFileSafe(dir, name) {
  try {
    return statSync(join(dir, name)).isFile()
  } catch {
    return false
  }
}

/** Case-insensitive substring match over the fields a person searches by. */
export function matchesQuery(listing, query) {
  if (!query) return true
  const q = query.toLowerCase()
  return [listing.id, listing.name, listing.summary, listing.publisher].some((field) =>
    field?.toLowerCase().includes(q),
  )
}
