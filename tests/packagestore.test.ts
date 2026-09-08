// jsdom has no IndexedDB, and payloads live there.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The payload store's IndexedDB connection.
 *
 * Booted through a fresh copy of the module for each case, the way
 * `tests/keystore.test.ts` does: the connection is memoised at module scope
 * and `packagesReady` opens it at import, so a second test would otherwise be
 * looking at the first one's connection.
 */
async function boot() {
  vi.resetModules()
  const mod = await import('@/store/packages')
  await mod.packagesReady
  return mod
}

describe('the payload store', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('opens one connection however many operations run', async () => {
    // Opening per operation leaks a connection apiece, and an open connection
    // blocks a version upgrade -- so a schema bump would be blocked by this
    // session's own leftovers. Counted here because nothing else would notice.
    const open = vi.spyOn(indexedDB, 'open')
    const { readPayload, writePayload, deletePayload } = await boot()

    await writePayload('a.b', { 'main.js': new Uint8Array([1]) })
    await readPayload('a.b')
    await readPayload('a.b')
    await writePayload('c.d', { 'main.js': new Uint8Array([2]) })
    await deletePayload('c.d')

    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
  })

  it('does not open a second connection for concurrent calls', async () => {
    const { readPayload, writePayload } = await boot()
    const open = vi.spyOn(indexedDB, 'open')

    // The memo holds a promise, not a connection, so callers racing before the
    // first open resolves all wait on the same one.
    await Promise.all([
      writePayload('a.b', { 'x': new Uint8Array([1]) }),
      readPayload('a.b'),
      readPayload('e.f'),
    ])

    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('does not memoise the absence of IndexedDB', async () => {
    /*
     * `tests/setup.ts` imports this store, so in a suite run it is evaluated
     * before a test file installs `fake-indexeddb`. Caching that first "no
     * IndexedDB here" answer wedged every install for the rest of the run --
     * the memo has to hold a connection, never the failure to get one.
     */
    const real = globalThis.indexedDB
    // @ts-expect-error -- deleting a global the module reads at import time
    delete globalThis.indexedDB

    const { readPayload, writePayload } = await boot()
    expect(await readPayload('a.b')).toBeNull()

    globalThis.indexedDB = real
    expect(await writePayload('a.b', { 'main.js': new Uint8Array([7]) })).toBe(true)
    const back = await readPayload('a.b')
    expect(Array.from(back!['main.js'])).toEqual([7])
  })

  it('round-trips a payload', async () => {
    const { readPayload, writePayload } = await boot()
    await writePayload('a.b', { 'main.js': new Uint8Array([1, 2, 3]) })

    const back = await readPayload('a.b')
    expect(back).toBeTruthy()
    expect(Array.from(back!['main.js'])).toEqual([1, 2, 3])
  })

  it('reports a missing payload as null, not as a failure', async () => {
    const { readPayload } = await boot()
    expect(await readPayload('nothing.here')).toBeNull()
  })

  it('deletes a payload', async () => {
    const { readPayload, writePayload, deletePayload } = await boot()
    await writePayload('a.b', { 'main.js': new Uint8Array([1]) })
    expect(await deletePayload('a.b')).toBe(true)
    expect(await readPayload('a.b')).toBeNull()
  })
})
