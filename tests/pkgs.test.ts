import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { packageIcon } from '@/apps/packageApp'
import { AppIcon } from '@/lib/icons'
import { readPackage } from '@/lib/packages/archive'
import { errorsIn, validatePackage } from '@/lib/packages/manifest'
import { MAX_PACKAGE_BYTES } from '@/lib/packages/types'

/**
 * The sample packages in `pkgs/` are built by their own script, with no
 * dependency on `src/`. That independence is the point of them, and it is also
 * how they could quietly stop being installable -- nothing else here would
 * notice. So the build runs, and its output goes through the same reader
 * Coffee Shop uses.
 */

const ROOT = join(__dirname, '..')
const build = (name: string) =>
  execFileSync(process.execPath, [join(ROOT, 'pkgs', 'build.mjs'), name], { cwd: ROOT })

const bytesOf = (id: string) => new Uint8Array(readFileSync(join(ROOT, 'pkgs', 'dist', `${id}.pkg`)))

describe('pkgs/iconedit', () => {
  const id = 'com.beanweb.iconedit'

  it('builds a package Coffee Shop accepts', () => {
    build('iconedit')
    const bytes = bytesOf(id)
    expect(bytes.byteLength).toBeLessThan(MAX_PACKAGE_BYTES)

    const contents = readPackage(bytes)
    expect(contents.manifest.id).toBe(id)
    expect(contents.manifest.name).toBe('IconEdit')
    expect(errorsIn(validatePackage(contents))).toEqual([])
  })

  it('carries its entry, icon and manifest and nothing else', () => {
    build('iconedit')
    expect(Object.keys(readPackage(bytesOf(id)).files).sort()).toEqual([
      'icon.svg',
      'main.js',
      'manifest.json',
    ])
  })

  it('builds byte-identically twice', () => {
    // Entry mtimes are pinned in pkgs/build.mjs for the same reason they are
    // in archive.ts. If this fails the clock has leaked into the build.
    build('iconedit')
    const first = bytesOf(id)
    build('iconedit')
    expect(Array.from(bytesOf(id))).toEqual(Array.from(first))
  })

  it('claims .bicon, so Tracker opens one with it', () => {
    build('iconedit')
    const { manifest } = readPackage(bytesOf(id))
    expect(manifest.extensions).toEqual(['.bicon'])
    expect(manifest.permissions).toEqual(['fs'])
  })
})

/**
 * `init` writes a directory; `build` packs it; Coffee Shop reads it. The
 * scaffold is only worth having if that whole line still holds, so the test
 * walks it end to end rather than asserting on the files it wrote.
 *
 * Everything lands in a temp directory: the Packages workflow uploads the
 * contents of `pkgs/dist`, so a placeholder `com.example.*` package built into
 * it here would ship in the artifact.
 */
describe('pkgs/build.mjs init', () => {
  let tmp = ''

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'beanweb-pkg-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const init = (...args: string[]) =>
    execFileSync(process.execPath, [join(ROOT, 'pkgs', 'build.mjs'), 'init', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      // Piped rather than inherited: three of these expect a failure, and the
      // script's complaint on stderr would otherwise print in a passing run.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  const pack = (dir: string) =>
    execFileSync(process.execPath, [join(ROOT, 'pkgs', 'build.mjs'), dir, '--dist', join(tmp, 'dist')], {
      cwd: ROOT,
      encoding: 'utf8',
    })

  it('scaffolds a package that builds and installs unchanged', () => {
    const made = JSON.parse(
      init(
        'bean-paint',
        '--name',
        'Bean Paint',
        '--ext',
        '.bpaint',
        '--description',
        'A longer pitch.\nWith a second line.',
        '--into',
        tmp,
        '--json',
      ),
    )
    expect(made.id).toBe('com.example.beanpaint')
    expect(made.files).toEqual(['icon.svg', 'main.js', 'manifest.json'])

    pack(made.dir)
    const contents = readPackage(
      new Uint8Array(readFileSync(join(tmp, 'dist', `${made.id}.pkg`))),
    )
    expect(errorsIn(validatePackage(contents))).toEqual([])
    expect(contents.manifest.name).toBe('Bean Paint')
    expect(contents.manifest.extensions).toEqual(['.bpaint'])
    expect(contents.manifest.permissions).toEqual(['fs'])
    expect(contents.manifest.description).toBe('A longer pitch.\nWith a second line.')
  })

  it('leaves description out of the manifest when none is given', () => {
    const made = JSON.parse(init('bean-paint', '--into', tmp, '--json'))
    pack(made.dir)
    const contents = readPackage(
      new Uint8Array(readFileSync(join(tmp, 'dist', `${made.id}.pkg`))),
    )
    expect(contents.manifest.description).toBeUndefined()
  })

  it('names the app after the directory when nothing is given', () => {
    const made = JSON.parse(init('bean-paint', '--into', tmp, '--json'))
    expect(made.name).toBe('Bean Paint')
  })

  it('gives it an icon that survives the sanitiser', () => {
    // A package's icon is markup from a stranger rendered into this page, so
    // `packageIcon` sanitises it and falls back to the generic AppIcon when
    // nothing survives. Our own scaffold coming back generic would mean it had
    // shipped a blank icon to everyone who used it.
    const made = JSON.parse(init('bean-paint', '--into', tmp, '--json'))
    const svg = readFileSync(join(made.dir, 'icon.svg'), 'utf8')
    expect(packageIcon(svg)).not.toBe(AppIcon)
  })

  it('refuses to overwrite a package that is already there', () => {
    init('bean-paint', '--into', tmp)
    const entry = join(tmp, 'bean-paint', 'main.js')
    const before = readFileSync(entry, 'utf8')
    expect(() => init('bean-paint', '--into', tmp)).toThrow()
    expect(readFileSync(entry, 'utf8')).toBe(before)
  })

  it('refuses a directory name that is not one', () => {
    expect(() => init('Bean Paint', '--into', tmp)).toThrow()
    expect(() => init('../escape', '--into', tmp)).toThrow()
  })
})
