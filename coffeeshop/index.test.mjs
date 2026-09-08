import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { zipSync } from 'fflate'

import { MAX_ICON_BYTES, buildIndex, matchesQuery } from './index.mjs'

const encoder = new TextEncoder()

function pkg({ id, name = 'Test App', version = '1.0.0', summary, description, publisher, icon }) {
  const manifest = {
    format: 1,
    id,
    name,
    version,
    kind: 'sandboxed',
    entry: 'main.js',
    window: { defaultW: 300, defaultH: 200 },
    permissions: [],
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(publisher ? { publisher } : {}),
    ...(icon ? { icon: 'icon.svg' } : {}),
  }
  const files = {
    'manifest.json': encoder.encode(JSON.stringify(manifest)),
    'main.js': encoder.encode('// noop'),
  }
  if (icon) files['icon.svg'] = encoder.encode(icon)
  return zipSync(files)
}

describe('buildIndex', () => {
  let dir = ''

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'coffeeshop-'))
  })
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads every .pkg into a listing, ignoring other files', () => {
    writeFileSync(
      join(dir, 'beanpaint.pkg'),
      pkg({
        id: 'com.example.beanpaint',
        summary: 'Paint',
        description: 'A longer pitch.\n\nWith a second paragraph.',
        publisher: 'Example',
      }),
    )
    writeFileSync(join(dir, 'notes.txt'), 'not a package')

    const { listings, warnings } = buildIndex(dir)
    assert.equal(warnings.length, 0)
    assert.equal(listings.length, 1)
    assert.deepEqual(
      {
        id: listings[0].id,
        name: listings[0].name,
        summary: listings[0].summary,
        description: listings[0].description,
        publisher: listings[0].publisher,
      },
      {
        id: 'com.example.beanpaint',
        name: 'Test App',
        summary: 'Paint',
        description: 'A longer pitch.\n\nWith a second paragraph.',
        publisher: 'Example',
      },
    )
    assert.ok(listings[0].sizeBytes > 0)
  })

  it('leaves description out of the listing when the manifest has none', () => {
    writeFileSync(join(dir, 'nodescription.pkg'), pkg({ id: 'com.example.nodescription' }))
    const { listings } = buildIndex(dir)
    assert.equal(listings.find((l) => l.id === 'com.example.nodescription').description, undefined)
  })

  it('carries a small icon and drops an oversized one', () => {
    writeFileSync(join(dir, 'iconed.pkg'), pkg({ id: 'com.example.iconed', icon: '<svg/>' }))
    writeFileSync(join(dir, 'bigicon.pkg'), pkg({ id: 'com.example.bigicon', icon: 'x'.repeat(MAX_ICON_BYTES + 1) }))

    const { listings } = buildIndex(dir)
    const iconed = listings.find((l) => l.id === 'com.example.iconed')
    const bigicon = listings.find((l) => l.id === 'com.example.bigicon')
    assert.equal(iconed.iconSvg, '<svg/>')
    assert.equal(bigicon.iconSvg, undefined)
  })

  it('warns on a broken archive rather than throwing', () => {
    writeFileSync(join(dir, 'broken.pkg'), 'not a zip at all')
    const { listings, warnings } = buildIndex(dir)
    assert.ok(warnings.some((w) => w.includes('broken.pkg')))
    assert.ok(!listings.some((l) => l.id === undefined))
  })

  it('keeps the first package when two claim the same id', () => {
    const clean = mkdtempSync(join(tmpdir(), 'coffeeshop-dup-'))
    try {
      writeFileSync(join(clean, 'a.pkg'), pkg({ id: 'com.example.dup', name: 'First' }))
      writeFileSync(join(clean, 'b.pkg'), pkg({ id: 'com.example.dup', name: 'Second' }))
      const { listings, warnings } = buildIndex(clean)
      assert.equal(listings.length, 1)
      assert.equal(listings[0].name, 'First')
      assert.ok(warnings.some((w) => w.includes('duplicate id')))
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })
})

describe('matchesQuery', () => {
  const listing = { id: 'com.example.beanpaint', name: 'Bean Paint', summary: 'A painting program', publisher: 'Example' }

  it('matches on name, summary, publisher and id, case-insensitively', () => {
    assert.ok(matchesQuery(listing, ''))
    assert.ok(matchesQuery(listing, 'bean'))
    assert.ok(matchesQuery(listing, 'PAINTING'))
    assert.ok(matchesQuery(listing, 'example'))
    assert.ok(matchesQuery(listing, 'com.example'))
    assert.ok(!matchesQuery(listing, 'nonexistent'))
  })
})
