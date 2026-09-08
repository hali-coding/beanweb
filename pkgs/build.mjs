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
 *   node pkgs/build.mjs --json       # machine-readable, nothing else on stdout
 *
 * Output goes to pkgs/dist/<id>.pkg.
 *
 * It also scaffolds one, because the first thing anyone needs is a directory
 * that already builds:
 *
 *   node pkgs/build.mjs init beanpaint --name "Bean Paint" --ext .bpaint
 *
 * `init` lives in init.mjs; this file is the command line it arrives on.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

import { scaffold } from './init.mjs'

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

/**
 * A name is a directory in pkgs/, unless it looks like a path -- then it is one
 * from the shell's own working directory, which is what makes `--into` and
 * building a package kept outside this repository the same thing. Output still
 * lands in pkgs/dist either way.
 */
const dirFor = (name) =>
  isAbsolute(name) || name.includes('/') || name.includes('\\') ? resolve(name) : join(HERE, name)

function build(name, dist = DIST) {
  const dir = dirFor(name)
  if (!statSync(dir).isDirectory()) return null
  const { manifest, bytes, names } = packDir(dir)
  mkdirSync(dist, { recursive: true })
  const out = join(dist, `${manifest.id}.pkg`)
  writeFileSync(out, bytes)
  return { manifest, out, bytes, names }
}

/** Relative when that is shorter to read, absolute when it would be `../..`. */
function display(path) {
  const rel = relative(process.cwd(), path).split('\\').join('/')
  return rel && !rel.startsWith('..') ? rel : path
}

const USAGE = `usage:
  node pkgs/build.mjs [<dir>...] [--dist <d>] [--json]
                                               pack pkgs/<dir> into pkgs/dist/<id>.pkg
  node pkgs/build.mjs init <dir> [options]     scaffold a new package directory

<dir> is a directory in pkgs/, or a path to one anywhere.

init options:
  --id <reverse-dns>   the install key       (default com.example.<dir>)
  --name <title>       the application name  (default the directory, title cased)
  --publisher <who>    shown by the Installer
  --summary <text>     one line, shown by the Installer
  --ext <.ext>         a file type this app opens; repeatable
  --into <dir>         where to write it     (default pkgs/)
  --json               print the result as JSON and nothing else`

/**
 * Options in `--flag value` form.
 *
 * Hand-rolled rather than pulled from a dependency: pkgs/ is meant to be
 * liftable into its own repository unchanged, and a package manifest listing a
 * flag parser would be the first thing to stop that being true.
 */
function parseFlags(argv, repeatable = new Set()) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (key === 'json' || key === 'help') {
      flags[key] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`--${key} needs a value`)
    if (repeatable.has(key)) (flags[key] ??= []).push(value)
    else flags[key] = value
  }
  return { flags, rest }
}

function init(argv) {
  const { flags, rest } = parseFlags(argv, new Set(['ext']))
  if (flags.help || rest.length !== 1) {
    console.error(rest.length ? 'init takes one directory name.' : 'init needs a directory name.')
    console.error(USAGE)
    return 1
  }

  const made = scaffold(flags.into ? resolve(flags.into) : HERE, rest[0], {
    id: flags.id,
    name: flags.name,
    publisher: flags.publisher,
    summary: flags.summary,
    extensions: flags.ext ?? [],
  })

  const where = display(made.dir)
  if (flags.json) {
    console.log(JSON.stringify({ ...made, dir: where }, null, 2))
    return 0
  }

  // Built by directory name when it landed in pkgs/, by path when --into put
  // it somewhere else. `build` takes either.
  const argument = join(HERE, made.slug) === made.dir ? made.slug : where
  console.log(`${made.name} -> ${where}/  (${made.files.join(', ')})`)
  console.log(`
  node pkgs/build.mjs ${argument}

then install pkgs/dist/${made.id}.pkg from the Installer's
File -> Install from this computer.`)

  // The id is the install key and is fixed for the life of the package, so it
  // is the one field that has to be decided before anyone else sees it.
  if (made.id.startsWith('com.example.')) {
    console.log(`
Set your own "id" in ${where}/manifest.json before publishing;
"${made.id}" is a placeholder, and two packages sharing an id are one app.`)
  }
  return 0
}

function main(argv) {
  if (argv[0] === 'init') return init(argv.slice(1))
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE)
    return 0
  }

  // --json prints one JSON array and nothing else, so a caller (the Packages
  // workflow) can build a summary from data rather than parsing log lines.
  const { flags, rest } = parseFlags(argv)
  const json = flags.json === true
  const dist = flags.dist ? resolve(flags.dist) : DIST

  const wanted = rest.length
    ? rest
    : readdirSync(HERE, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'))
        .map((e) => e.name)

  if (!wanted.length) {
    console.error('nothing to build in pkgs/')
    return 1
  }

  const built = []
  let failed = 0
  for (const name of wanted) {
    try {
      const { manifest, out, bytes, names: files } = build(name, dist)
      built.push({
        dir: name,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        // Both, because they differ where it matters: `file` is where the
        // build put it, `filename` is what it is called inside the Packages
        // workflow's artifact, which uploads the contents of pkgs/dist.
        file: display(out),
        filename: `${manifest.id}.pkg`,
        bytes: bytes.byteLength,
        files: files.length,
      })
    } catch (err) {
      // Always to stderr, so --json's stdout stays parseable even on failure.
      console.error(`FAIL ${name}: ${err.message}`)
      failed++
    }
  }

  if (json) console.log(JSON.stringify(built, null, 2))
  else {
    for (const b of built) {
      console.log(
        `${b.name} ${b.version} -> ${b.file}  (${(b.bytes / 1024).toFixed(1)} KB, ${b.files} files)`,
      )
    }
  }
  return failed ? 1 : 0
}

if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    // Always to stderr, so --json's stdout stays parseable even on failure.
    console.error(err.message)
    process.exit(1)
  }
}
