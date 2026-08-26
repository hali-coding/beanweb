import { create } from 'zustand'
import { DEFAULT_MODEL } from '@/lib/models'
import type { Theme } from '@/lib/theme'

/**
 * Desktop settings, persisted to localStorage.
 *
 * The Anthropic API key is supplied by the user and lives only in this browser:
 * BeanWeb has no backend, so there is nowhere else to put it. That means any
 * script on the page can read it. Acceptable for a local desktop toy you run
 * yourself; never ship a build with a key baked in, and never commit one.
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

const EMPTY: Persisted = { apiKey: '', model: DEFAULT_MODEL, theme: 'light' }

/*
 * There is no version inside the payload and no migrate step: every field is
 * validated on the way in, so a record written before a field existed simply
 * reads back as that field's default. Adding a field stays backwards
 * compatible as long as it is validated here too.
 */
function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_MODEL,
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
    }
  } catch {
    return EMPTY
  }
}

let saveTimer: number | undefined
function persist(state: Persisted) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* Quota or private-mode failure: the session still works in memory. */
    }
  }, 250) as unknown as number
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

/** Never render a key in full; this is what the UI shows instead. */
export function maskKey(key: string): string {
  if (!key) return 'not set'
  return key.length <= 12 ? '••••' : `${key.slice(0, 7)}…${key.slice(-4)}`
}
