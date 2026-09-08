#!/usr/bin/env node
/*
 * Pack a package directory into a `.pkg`.
 *
 * Separate from the app's build on purpose: a package is not part of BeanWeb,
 * it is something BeanWeb installs, and the day one is published from another
 * repository this script is the whole of what it needs. Nothing here imports
 * from `src/`.
 *
 *   node pkgs/build.mjs              # every directory in pkgs/
 *   node pkgs/build.mjs iconedit     # just that one
 *
 * Output goes to pkgs/dist/<id>.pkg.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')

/*
 * Pinned so a package built twice is byte-identical.
 *
 * Constructed from *local* components deliberately: fflate writes the zip's
 * DOS timestamp with getFullYear()/getHours() and throws below 1980, so an
 * epoch-0 mtime fails outright west of UTC and shifts the bytes by the
 * machine's offset everywhere else. Same trap as src/lib/packages/archive.ts.
 */
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const LEVEL = 6

/** Skipped wherever they appear: editor noise, and our own output. */
const IGNORE = new Set(['dist', 'node_modules', '.DS_Store'])

function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

export function packDir(dir) {
  const manifestPath = join(dir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`${dir}: manifest.json is missing or not JSON (${err.message})`)
  }
  if (!manifest.id) throw new Error(`${dir}: the manifest has no id`)
  if (!manifest.entry) throw new Error(`${dir}: the manifest names no entry`)

  const names = walk(dir)
  if (!names.includes(manifest.entry)) {
    throw new Error(`${dir}: the entry "${manifest.entry}" is not in the directory`)
  }

  // Sorted, so the archive does not depend on the order readdir happened to
  // return -- which is not stable across filesystems.
  const payload = {}
  for (const name of names.sort()) {
    payload[name] = [readFileSync(join(dir, name)), { mtime: FIXED_MTIME, level: LEVEL }]
  }

  return { manifest, bytes: zipSync(payload, { mtime: FIXED_MTIME, level: LEVEL }), names }
}

function build(name) {
  const dir = join(HERE, name)
  if (!statSync(dir).isDirectory()) return null
  const { manifest, bytes, names } = packDir(dir)
  mkdirSync(DIST, { recursive: true })
  const out = join(DIST, `${manifest.id}.pkg`)
  writeFileSync(out, bytes)
  return { manifest, out, bytes, names }
}

function main(argv) {
  const wanted = argv.length
    ? argv
    : readdirSync(HERE, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'))
        .map((e) => e.name)

  if (!wanted.length) {
    console.error('nothing to build in pkgs/')
    return 1
  }

  let failed = 0
  for (const name of wanted) {
    try {
      const { manifest, out, bytes, names } = build(name)
      const kb = (bytes.byteLength / 1024).toFixed(1)
      console.log(
        `${manifest.name} ${manifest.version} -> ${relative(process.cwd(), out)}  ` +
          `(${kb} KB, ${names.length} files)`,
      )
    } catch (err) {
      console.error(`FAIL ${name}: ${err.message}`)
      failed++
    }
  }
  return failed ? 1 : 0
}

if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
