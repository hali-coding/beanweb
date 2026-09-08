import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { MANIFEST_NAME, encodeText, readPackage, writePackage } from '@/lib/packages/archive'
import { errorsIn, parseManifest, validatePackage } from '@/lib/packages/manifest'
import {
  MAX_UNPACKED_BYTES,
  PackageError,
  type PackageContents,
  type PackageManifest,
} from '@/lib/packages/types'

function manifest(over: Partial<PackageManifest> = {}): PackageManifest {
  return {
    format: 1,
    id: 'com.example.beanpaint',
    name: 'Bean Paint',
    version: '1.0.0',
    kind: 'sandboxed',
    entry: 'main.js',
    window: { defaultW: 480, defaultH: 360 },
    permissions: [],
    ...over,
  }
}

function contents(over: Partial<PackageManifest> = {}, files: Record<string, string> = {}): PackageContents {
  const m = manifest(over)
  const out: Record<string, Uint8Array> = { 'main.js': encodeText('bw.setTitle("hi")\n') }
  for (const [k, v] of Object.entries(files)) out[k] = encodeText(v)
  return { manifest: m, files: out }
}

describe('archive', () => {
  it('round-trips contents through the zip', () => {
    const c = contents({}, { 'icon.svg': '<svg viewBox="0 0 32 32"/>' })
    const back = readPackage(writePackage(c))

    expect(back.manifest).toEqual(c.manifest)
    expect(Object.keys(back.files).sort()).toEqual(['icon.svg', 'main.js', MANIFEST_NAME])
    expect(new TextDecoder().decode(back.files['icon.svg'])).toBe('<svg viewBox="0 0 32 32"/>')
  })

  it('writes the same bytes every time', () => {
    // Entry mtimes are pinned, so a package built twice is the same file. If
    // this fails the clock has leaked into the format.
    const c = contents()
    expect(Array.from(writePackage(c))).toEqual(Array.from(writePackage(c)))
  })

  it('does not depend on the order files were added', () => {
    const a: PackageContents = {
      manifest: manifest(),
      files: { 'a.js': encodeText('a'), 'b.js': encodeText('b') },
    }
    const b: PackageContents = {
      manifest: manifest(),
      files: { 'b.js': encodeText('b'), 'a.js': encodeText('a') },
    }
    expect(Array.from(writePackage(a))).toEqual(Array.from(writePackage(b)))
  })

  it('writes manifest.json from the model, not from files', () => {
    const c = contents()
    c.files[MANIFEST_NAME] = encodeText('{"id":"stale"}')
    expect(readPackage(writePackage(c)).manifest.id).toBe('com.example.beanpaint')
  })

  it('refuses something that is not an archive', () => {
    expect(() => readPackage(encodeText('not a zip'))).toThrow(PackageError)
  })

  it('refuses an archive with no manifest', () => {
    // Built with fflate directly: writePackage always emits a manifest, so a
    // package without one cannot be produced through the front door.
    const raw = zipSync({ 'main.js': encodeText('nope') })
    expect(() => readPackage(raw)).toThrow(/no manifest\.json/)
  })

  it('refuses a package that unpacks to more than the cap', () => {
    // Highly compressible: a few KiB of zip claiming many MiB unpacked.
    const big = new Uint8Array(MAX_UNPACKED_BYTES + 1024)
    const bomb = writePackage({ manifest: manifest(), files: { 'main.js': big } })
    expect(() => readPackage(bomb)).toThrow(/unpacks to more than/)
  })
})

describe('parseManifest', () => {
  it('fills defaults for a sparse manifest', () => {
    const m = parseManifest('{"id":"a.b","name":"A"}')
    expect(m.window).toEqual({ defaultW: 420, defaultH: 320, minW: undefined, minH: undefined })
    expect(m.permissions).toEqual([])
    // Optional fields are absent, not undefined-valued: see parseManifest.
    expect('singleton' in m).toBe(false)
    expect('icon' in m).toBe(false)
  })

  it('throws on JSON that is not an object', () => {
    expect(() => parseManifest('[]')).toThrow(PackageError)
    expect(() => parseManifest('nope')).toThrow(PackageError)
  })
})

describe('validatePackage', () => {
  const errs = (c: PackageContents) => errorsIn(validatePackage(c)).map((p) => p.field)

  it('passes a good package', () => {
    expect(validatePackage(contents())).toEqual([])
  })

  it('rejects a bad id', () => {
    expect(errs(contents({ id: 'nodots' }))).toContain('id')
    expect(errs(contents({ id: 'Has.Caps' }))).toContain('id')
    expect(errs(contents({ id: '' }))).toContain('id')
  })

  it('rejects a format from the future', () => {
    expect(errs(contents({ format: 99 }))).toContain('format')
  })

  it('rejects a kind it cannot run', () => {
    expect(errs(contents({ kind: 'native' as never }))).toContain('kind')
  })

  it('rejects an entry that escapes the package', () => {
    expect(errs(contents({ entry: '../evil.js' }))).toContain('entry')
    expect(errs(contents({ entry: '/etc/passwd' }))).toContain('entry')
  })

  it('rejects an entry that is not in the archive', () => {
    expect(errs(contents({ entry: 'missing.js' }))).toContain('entry')
  })

  it('warns rather than fails on an unknown permission', () => {
    const problems = validatePackage(contents({ permissions: ['nuclear' as never] }))
    expect(errorsIn(problems)).toEqual([])
    expect(problems[0].severity).toBe('warning')
  })

  it('rejects a malformed extension', () => {
    expect(errs(contents({ extensions: ['bpaint'] }))).toContain('extensions')
  })
})
