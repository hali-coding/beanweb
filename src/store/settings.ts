import { create } from 'zustand'
import { DEFAULT_MODEL } from '@/lib/models'

/**
 * Desktop settings, persisted to localStorage.
 *
 * Currently just the Anthropic API key. The key is supplied by the user and
 * lives only in this browser: BeanWeb has no backend, so there is nowhere else
 * to put it. That means any script on the page can read it. Acceptable for a
 * local desktop toy you run yourself; never ship a build with a key baked in,
 * and never commit one.
 */

const STORAGE_KEY = 'beanweb.settings.v1'

interface Persisted {
  apiKey: string
  /** Selected chat model. Defaults to the cheapest one we know a price for. */
  model: string
}

const EMPTY: Persisted = { apiKey: '', model: DEFAULT_MODEL }

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_MODEL,
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
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),

  setApiKey: (key) => {
    const apiKey = key.trim()
    persist({ apiKey, model: get().model })
    set({ apiKey })
  },

  clearApiKey: () => {
    persist({ apiKey: '', model: get().model })
    set({ apiKey: '' })
  },

  setModel: (model) => {
    persist({ apiKey: get().apiKey, model })
    set({ model })
  },
}))

/** Never render a key in full; this is what the UI shows instead. */
export function maskKey(key: string): string {
  if (!key) return 'not set'
  return key.length <= 12 ? '••••' : `${key.slice(0, 7)}…${key.slice(-4)}`
}
