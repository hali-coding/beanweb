/**
 * The `.pkg` container: a zip, read and written.
 *
 * `readPackage` and `writePackage` are exact inverses, the same contract
 * `toSVG`/`parseSVG` hold in `lib/draw/svg.ts` and `formatLevel`/`parseLevel`
 * in `lib/beanchallenge/level.ts`. Writing is byte-stable, so a package built
 * twice from the same contents is the same file and a round-trip test is not
 * at the mercy of the clock.
 *
 * Reading throws `PackageError` only for what makes a package unreadable --
 * not a zip, no manifest, manifest is not JSON. Everything a person could be
 * asked about comes back from `validatePackage` as a list instead.
 */

import { unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate'
import { parseManifest } from './manifest'
import {
  MAX_PACKAGE_BYTES,
  MAX_UNPACKED_BYTES,
  PackageError,
  type PackageContents,
  type PackageFiles,
} from './types'

export const MANIFEST_NAME = 'manifest.json'

/**
 * Every entry gets this timestamp, so the same contents always produce the
 * same bytes.
 *
 * It has to be built from *local* components. fflate encodes the DOS date with
 * `getFullYear()`/`getHours()` and rejects anything before 1980, so an epoch-0
 * mtime throws outright in any timezone behind UTC and would otherwise shift
 * the bytes by the machine's offset in every other one.
 */
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0)

/** Deflate at a fixed level: the default could change under us between versions. */
const LEVEL = 6 as const

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export const decodeText = (bytes: Uint8Array): string => decoder.decode(bytes)
export const encodeText = (text: string): Uint8Array => encoder.encode(text)

/**
 * Unpack an archive.
 *
 * The unpacked total is checked against the sizes the zip *declares*, in the
 * filter, before any of it is decompressed. Checking afterwards is too late:
 * deflate reaches ratios near 1000:1, so an archive well under
 * `MAX_PACKAGE_BYTES` can still ask for gigabytes, and the allocation that
 * takes the tab down happens inside `unzipSync`.
 */
export function readPackage(bytes: Uint8Array): PackageContents {
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new PackageError(`The package is larger than ${MAX_PACKAGE_BYTES / 1024} KiB.`)
  }

  let unpacked = 0
  let raw: Unzipped
  try {
    raw = unzipSync(bytes, {
      filter: (file) => {
        // Directory entries carry no data and are rebuilt from the paths.
        if (file.name.endsWith('/')) return false
        unpacked += file.originalSize
        if (unpacked > MAX_UNPACKED_BYTES) {
          throw new PackageError(
            `The package unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MiB.`,
          )
        }
        return true
      },
    })
  } catch (err) {
    if (err instanceof PackageError) throw err
    throw new PackageError(`The package is not a readable archive: ${(err as Error).message}`)
  }

  const files: PackageFiles = {}
  for (const [name, data] of Object.entries(raw)) files[name] = data

  const manifestBytes = files[MANIFEST_NAME]
  if (!manifestBytes) throw new PackageError(`The package has no ${MANIFEST_NAME}.`)

  return { manifest: parseManifest(decodeText(manifestBytes)), files }
}

/**
 * Pack contents into an archive.
 *
 * `manifest.json` is written from the model rather than from `files`, so the
 * two can never disagree -- the same reason `gradientDefs` feeds both the file
 * and the screen in `lib/draw/svg.ts`. Entries are sorted so the order does
 * not depend on how the object was built.
 */
export function writePackage(contents: PackageContents): Uint8Array {
  const payload: Zippable = {}
  const opts = { mtime: FIXED_MTIME, level: LEVEL }

  const named: PackageFiles = {
    ...contents.files,
    [MANIFEST_NAME]: encodeText(`${JSON.stringify(contents.manifest, null, 2)}\n`),
  }
  for (const name of Object.keys(named).sort()) payload[name] = [named[name], opts]

  return zipSync(payload, { level: LEVEL, mtime: FIXED_MTIME })
}
