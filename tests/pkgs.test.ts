import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readPackage } from '@/lib/packages/archive'
import { errorsIn, validatePackage } from '@/lib/packages/manifest'
import { MAX_PACKAGE_BYTES } from '@/lib/packages/types'

/**
 * The sample packages in `pkgs/` are built by their own script, with no
 * dependency on `src/`. That independence is the point of them, and it is also
 * how they could quietly stop being installable -- nothing else here would
 * notice. So the build runs, and its output goes through the same reader the
 * Installer uses.
 */

const ROOT = join(__dirname, '..')
const build = (name: string) =>
  execFileSync(process.execPath, [join(ROOT, 'pkgs', 'build.mjs'), name], { cwd: ROOT })

const bytesOf = (id: string) => new Uint8Array(readFileSync(join(ROOT, 'pkgs', 'dist', `${id}.pkg`)))

describe('pkgs/iconedit', () => {
  const id = 'com.beanweb.iconedit'

  it('builds a package the Installer accepts', () => {
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
