import { afterEach, describe, expect, it, vi } from 'vitest'

import { BASE_URL, coffeeShopSource } from '@/lib/packages/coffeeshop'
import { PackageError } from '@/lib/packages/types'

/**
 * The Coffee Shop `PackageSource` against a mocked `fetch`, the same seam
 * `docs/packages.md`'s "Adding a source" section describes -- `list()` and
 * `fetch()` are the entire contract, so these are the two things worth
 * pinning down: it builds the right URLs, and it treats the network as
 * untrusted input rather than trusting whatever comes back.
 */

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CoffeeShopSource.list', () => {
  it('fetches the catalogue and normalises each row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: 'com.example.a', name: 'A', version: '1.0.0', kind: 'sandboxed', sizeBytes: 100 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const listings = await coffeeShopSource.list()
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/packages`)
    expect(listings).toEqual([
      { id: 'com.example.a', name: 'A', version: '1.0.0', kind: 'sandboxed', sizeBytes: 100 },
    ])
  })

  it('encodes a query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await coffeeShopSource.list('bean paint')
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/packages?q=bean%20paint`)
  })

  it('drops a row missing what a listing needs, rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          { id: 'com.example.good', name: 'Good', version: '1.0.0', kind: 'sandboxed' },
          { id: 'com.example.bad' }, // no name, version or kind
          { name: 'No id', version: '1.0.0', kind: 'sandboxed' },
          { id: 'com.example.weird', name: 'Weird', version: '1.0.0', kind: 'not-a-real-kind' },
        ]),
      ),
    )

    const listings = await coffeeShopSource.list()
    expect(listings.map((l) => l.id)).toEqual(['com.example.good'])
  })

  it('raises a PackageError when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('network error')),
    )
    await expect(coffeeShopSource.list()).rejects.toBeInstanceOf(PackageError)
  })

  it('raises a PackageError on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    await expect(coffeeShopSource.list()).rejects.toBeInstanceOf(PackageError)
  })
})

describe('CoffeeShopSource.fetch', () => {
  it('downloads the package bytes for an id', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes))
    vi.stubGlobal('fetch', fetchMock)

    const result = await coffeeShopSource.fetch('com.example.a')
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/packages/com.example.a/download`)
    expect(Array.from(result!)).toEqual([1, 2, 3, 4])
  })

  it('resolves null when asked for nothing, without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await coffeeShopSource.fetch()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('raises a PackageError for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await expect(coffeeShopSource.fetch('com.example.missing')).rejects.toBeInstanceOf(PackageError)
  })
})
