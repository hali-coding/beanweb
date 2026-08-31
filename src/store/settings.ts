import { create } from 'zustand'
import { DEFAULT_MODEL } from '@/lib/models'
import { isSealed, seal, unseal, type Sealed } from '@/lib/keystore'
import type { Theme } from '@/lib/theme'

/**
 * Desktop settings, persisted to localStorage.
 *
 * The Anthropic API key is supplied by the user and lives only in this browser:
 * BeanWeb has no backend, so there is nowhere else to put it. It is not written
 * out in the clear, though -- `lib/keystore.ts` seals it against a
 * non-extractable key held in IndexedDB, and only the ciphertext reaches
 * localStorage. That keeps it out of a profile dump or a glance at devtools; it
 * is no defence against a script on the page, which can call `unseal` as easily
 * as this file does. Never ship a build with a key baked in, and never commit
 * one.
 *
 * Sealing is asynchronous, so the key is the one field that cannot be there on
 * the first tick: `load()` returns the rest synchronously and `keyReady`
 * resolves once the key has been decrypted into the store. Anything that needs
 * the key at boot must await it -- see `apps/Claude.tsx`.
 *
 * The theme is here rather than in `desktop.ts` because it outlives a session,
 * and it is a plain string: nothing in this file touches the DOM, so a test can
 * flip the theme without a document. Painting it is `shell/ThemeCurtain`'s job.
 */

const STORAGE_KEY = 'beanweb.settings.v1'

interface Persisted {
  apiKey: string
  /** Selected chat model. Defaults to the cheapest one we know a price for. */
  model: string
  /** Light unless the user has said otherwise -- R5 only ever had the one. */
  theme: Theme
}

/**
 * What is actually written. The key is sealed and the other two are not:
 * `index.html` reads the theme back before React boots to stamp the root, and
 * it cannot await a decrypt to do it.
 */
interface Record_ {
  key: Sealed | null
  model: string
  theme: Theme
}

function readRecord(): Partial<Record_> & { apiKey?: unknown } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Record_>) : {}
  } catch {
    return {}
  }
}

/*
 * There is no version inside the payload and no migrate step: every field is
 * validated on the way in, so a record written before a field existed simply
 * reads back as that field's default. Adding a field stays backwards
 * compatible as long as it is validated here too.
 *
 * `apiKey` is the one field read from a shape that is no longer written -- a
 * record from before sealing existed holds it as plain text. It is adopted here
 * and `hydrateKey` immediately rewrites the record sealed, which is what clears
 * the old plaintext off the disk.
 */
function load(): Persisted {
  const parsed = readRecord()
  return {
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_MODEL,
    theme: parsed.theme === 'dark' ? 'dark' : 'light',
  }
}

let saveTimer: number | undefined
/** Every commit takes a ticket. Sealing is async, so a write that returns to
 *  find a newer commit behind it drops its result rather than clobbering it. */
let generation = 0

function persist(state: Persisted) {
  clearTimeout(saveTimer)
  const mine = ++generation
  saveTimer = setTimeout(() => void writeRecord(state, mine), 250) as unknown as number
}

async function writeRecord(state: Persisted, mine: number) {
  // A browser that cannot seal gets `null`, and the key stays in memory for the
  // session. Falling back to plain text is the one thing this must not do.
  const key = state.apiKey ? await seal(state.apiKey) : null
  if (mine !== generation) return
  const record: Record_ = { key, model: state.model, theme: state.theme }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    /* Quota or private-mode failure: the session still works in memory. */
  }
}

interface SettingsStore extends Persisted {
  setApiKey: (key: string) => void
  clearApiKey: () => void
  setModel: (model: string) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

/**
 * The persisted subset of the store. Every mutator writes through this rather
 * than rebuilding the record inline, so adding a field means editing one place
 * instead of remembering to thread it through each setter.
 */
function snapshot(s: SettingsStore): Persisted {
  return { apiKey: s.apiKey, model: s.model, theme: s.theme }
}

export const useSettings = create<SettingsStore>((set, get) => {
  /* set() first, then persist the state that results. The write is debounced
     250 ms, so the order costs nothing and the setters stay one-liners. */
  const commit = (patch: Partial<Persisted>) => {
    set(patch)
    persist(snapshot(get()))
  }

  return {
    ...load(),

    setApiKey: (key) => commit({ apiKey: key.trim() }),
    clearApiKey: () => commit({ apiKey: '' }),
    setModel: (model) => commit({ model }),
    setTheme: (theme) => commit({ theme }),
    toggleTheme: () => commit({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
  }
})

/**
 * Decrypt the stored key into the store, or migrate a plaintext record.
 *
 * Runs once at module load and never again -- the key outlives the session, and
 * a second unseal would only race the user typing a new one. It resolves rather
 * than rejects on every failure: a browser that cannot decrypt is in exactly the
 * state of a browser that never had a key, which the Claude app already handles
 * by asking for one.
 */
async function hydrateKey() {
  const record = readRecord()

  // Plaintext record from before sealing existed: `load()` already adopted the
  // key into the store, so committing it writes the sealed shape and drops the
  // clear-text field. Deliberately unconditional -- if this browser cannot seal,
  // the rewrite still removes the plaintext, which is the point.
  if (typeof record.apiKey === 'string' && record.apiKey) {
    persist(snapshot(useSettings.getState()))
    return
  }

  if (!isSealed(record.key)) return
  const plain = await unseal(record.key)
  // A key typed during the decrypt wins: it is the newer intent, and it has
  // already been sealed and written by its own commit.
  if (plain && !useSettings.getState().apiKey) useSettings.setState({ apiKey: plain })
}

/** Resolves when the stored key has been decrypted into the store, or when it is
 *  settled that there is none. Await before reading `apiKey` at boot. */
export const keyReady: Promise<void> = hydrateKey()

/** Never render a key in full; this is what the UI shows instead. */
export function maskKey(key: string): string {
  if (!key) return 'not set'
  return key.length <= 12 ? '••••' : `${key.slice(0, 7)}…${key.slice(-4)}`
}
