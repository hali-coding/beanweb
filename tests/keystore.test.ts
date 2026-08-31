// jsdom has no IndexedDB, so the sealed path -- the one that actually runs in a
// browser -- would otherwise never be exercised anywhere in this suite.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isSealed, resetKeystoreForTests, seal, unseal } from '@/lib/keystore'
import { DEFAULT_MODEL } from '@/lib/models'

const KEY = 'sk-ant-api03-secret-value'
const STORAGE_KEY = 'beanweb.settings.v1'

/** A brand new browser profile: no device key, and nothing sealed under one. */
function freshProfile() {
  globalThis.indexedDB = new IDBFactory()
  resetKeystoreForTests()
}

/** The same profile after a reload: IndexedDB survives, the module does not. */
function reload() {
  resetKeystoreForTests()
}

beforeEach(freshProfile)

describe('the keystore', () => {
  it('seals and unseals a secret', async () => {
    const sealed = await seal(KEY)
    expect(isSealed(sealed)).toBe(true)
    expect(JSON.stringify(sealed)).not.toContain(KEY)
    expect(await unseal(sealed!)).toBe(KEY)
  })

  it('uses a fresh nonce every time, so two seals of one secret differ', async () => {
    const a = await seal(KEY)
    const b = await seal(KEY)
    expect(a!.iv).not.toBe(b!.iv)
    expect(a!.data).not.toBe(b!.data)
  })

  it('keeps the device key across a reload', async () => {
    const sealed = await seal(KEY)
    reload()
    expect(await unseal(sealed!)).toBe(KEY)
  })

  /* The point of the whole exercise: a localStorage record copied to another
     profile is inert, because the key it was sealed under never left the first
     browser and cannot be read out of it in the first place. */
  it('cannot open a record sealed on another profile', async () => {
    const sealed = await seal(KEY)
    freshProfile()
    expect(await unseal(sealed!)).toBeNull()
  })

  it('refuses a tampered payload rather than returning rubbish', async () => {
    const sealed = await seal(KEY)
    const flipped = { ...sealed!, data: `A${sealed!.data.slice(1)}` }
    expect(await unseal(flipped)).toBeNull()
  })

  /* An http:// origin has no crypto.subtle and some private modes have no
     IndexedDB. Both mean "do not persist the key", never "persist it plainly". */
  it('returns null where the browser cannot seal', async () => {
    const real = globalThis.indexedDB
    // @ts-expect-error -- modelling a browser that does not provide it at all
    delete globalThis.indexedDB
    resetKeystoreForTests()

    expect(await seal(KEY)).toBeNull()

    globalThis.indexedDB = real
  })

  it('rejects a record that is not a sealed payload', () => {
    expect(isSealed(null)).toBe(false)
    expect(isSealed({ iv: 'abc' })).toBe(false)
    expect(isSealed({ iv: 'abc', data: '' })).toBe(false)
    expect(isSealed({ iv: 'abc', data: 'ZGF0YQ==' })).toBe(true)
  })
})

/*
 * The store's boot path. `hydrateKey` runs once at module load, so each of
 * these has to import a fresh copy of the module with localStorage already
 * standing in the state under test -- which is also the only honest way to
 * exercise a migration.
 */
describe('the settings store at boot', () => {
  async function boot() {
    vi.resetModules()
    return await import('@/store/settings')
  }

  it('unseals the stored key into the store', async () => {
    const sealed = await seal(KEY)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ key: sealed, model: DEFAULT_MODEL, theme: 'dark' }),
    )

    const { useSettings, keyReady } = await boot()
    expect(useSettings.getState().apiKey).toBe('')
    await keyReady
    expect(useSettings.getState().apiKey).toBe(KEY)
    expect(useSettings.getState().theme).toBe('dark')
  })

  it('boots with no key when the device key is gone', async () => {
    const sealed = await seal(KEY)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ key: sealed, theme: 'light' }))
    freshProfile()

    const { useSettings, keyReady } = await boot()
    await keyReady
    expect(useSettings.getState().apiKey).toBe('')
  })

  it('migrates a plaintext record, and the clear text does not survive it', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ apiKey: KEY, model: DEFAULT_MODEL, theme: 'light' }),
    )

    const { useSettings, keyReady } = await boot()
    // The key is adopted synchronously -- a migration must not cost the user
    // their key for the length of a decrypt.
    expect(useSettings.getState().apiKey).toBe(KEY)
    await keyReady

    await vi.waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).not.toContain(KEY)
    })
    const record = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(record.apiKey).toBeUndefined()
    expect(await unseal(record.key)).toBe(KEY)
  })

  it('writes the key sealed when the user sets one', async () => {
    const { useSettings } = await boot()
    useSettings.getState().setApiKey(KEY)

    await vi.waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull())
    const raw = localStorage.getItem(STORAGE_KEY) ?? ''
    expect(raw).not.toContain(KEY)
    expect(await unseal(JSON.parse(raw).key)).toBe(KEY)
  })

  it('clears the sealed record when the key is cleared', async () => {
    const { useSettings } = await boot()
    useSettings.getState().setApiKey(KEY)
    await vi.waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toContain('"iv"'))

    useSettings.getState().clearApiKey()
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').key).toBeNull()
    })
  })
})
