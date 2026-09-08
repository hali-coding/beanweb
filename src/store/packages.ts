import { create } from 'zustand'

import type { InstalledPackage, PackageFiles, PackageManifest } from '@/lib/packages/types'
import { parseManifest } from '@/lib/packages/manifest'

/**
 * What is installed, and what each installed thing is made of.
 *
 * The two live apart on purpose. The **index** -- one manifest per package plus
 * when and where it came from -- is small, and it goes to `localStorage` where
 * it can be read synchronously: `main.tsx` has to register every installed app
 * into the registry *before the first render*, or a window restored for one
 * resolves to nothing and paints as empty chrome. The **payload** -- the
 * package's actual files -- is binary, can be hundreds of KiB, and is only
 * wanted when a window for that app actually opens, so it goes to IndexedDB.
 *
 * Putting payloads in `localStorage` instead would be the wrong trade twice
 * over: the disk already shares that ~5 MB quota under `beanweb.fs.v1`,
 * `store/fs.ts` swallows a quota failure silently, and base64 would add a third
 * again on top. `lib/keystore.ts` is the IndexedDB precedent this follows.
 *
 * Everything here fails soft, for the same reason the keystore does: a browser
 * with no IndexedDB (private-mode variants, jsdom without a shim) still boots,
 * still lists what the index says is installed, and simply cannot run it.
 */

const STORAGE_KEY = 'beanweb.packages.v1'

const DB_NAME = 'beanweb.packages'
const STORE = 'payloads'

/* --- the index, in localStorage ----------------------------------------- */

interface Record_ {
  installed: InstalledPackage[]
}

function readRecord(): Partial<Record_> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Record_>) : {}
  } catch {
    return {}
  }
}

/**
 * As in `store/settings.ts`: no version inside the payload and no migrate step,
 * because every field is validated on the way in. A record written before a
 * manifest field existed reads back with that field's default.
 *
 * The manifest goes back through `parseManifest`, so the shape the rest of the
 * app sees is the same whether it came from an archive or from the disk.
 */
export function load(): InstalledPackage[] {
  const parsed = readRecord()
  if (!Array.isArray(parsed.installed)) return []

  const out: InstalledPackage[] = []
  for (const entry of parsed.installed) {
    if (!entry || typeof entry !== 'object') continue
    let manifest: PackageManifest
    try {
      manifest = parseManifest(JSON.stringify(entry.manifest))
    } catch {
      // A record we cannot read is a record we cannot run. Dropping it is the
      // only option that leaves Coffee Shop able to show the rest.
      continue
    }
    if (!manifest.id) continue
    out.push({
      manifest,
      installedAt: typeof entry.installedAt === 'number' ? entry.installedAt : 0,
      sourceId: typeof entry.sourceId === 'string' ? entry.sourceId : 'unknown',
      sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0,
      ...(typeof entry.iconSvg === 'string' ? { iconSvg: entry.iconSvg } : {}),
    })
  }
  return out
}

let saveTimer: number | undefined

function persist(installed: InstalledPackage[]) {
  clearTimeout(saveTimer)
  // Coalesce a burst of installs into one write, as store/fs.ts does.
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ installed } satisfies Record_))
    } catch {
      /* Quota or private-mode failure: the session still works in memory. */
    }
  }, 250) as unknown as number
}

/* --- payloads, in IndexedDB ---------------------------------------------- */

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('packages blocked'))
  })
}

/**
 * The payload database, opened once.
 *
 * Memoised as the promise rather than the connection, the same reasoning
 * `lib/keystore.ts` gives for its key: two reads racing during boot would each
 * open their own otherwise.
 *
 * Opening per operation is not just the wasted round trip. Nothing here closes
 * a connection, so every read and write left one open for the life of the tab,
 * and an open connection blocks a version upgrade -- with `open`'s `onblocked`
 * rejecting, the first bump of the schema past 1 would have found a dozen of
 * this session's own connections in its way and failed.
 */
let pending: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  if (pending) return pending

  const attempt = (async (): Promise<IDBDatabase | null> => {
    if (typeof indexedDB === 'undefined') return null
    try {
      const conn = await open()
      /* Another tab upgrading the schema is blocked while this connection is
         open, so step out of its way and let the next call reopen. */
      conn.onversionchange = () => {
        conn.close()
        pending = null
      }
      conn.onclose = () => {
        pending = null
      }
      return conn
    } catch {
      return null
    }
  })()

  pending = attempt
  /*
   * Memoise the connection, never the failure to get one. A browser that had
   * no IndexedDB when this module was evaluated may have one by the first real
   * call -- which is precisely the case in the suite, where `tests/setup.ts`
   * imports this store before a test file installs `fake-indexeddb`. Caching
   * the "no" there wedged every install for the rest of the run.
   */
  void attempt.then((conn) => {
    if (!conn && pending === attempt) pending = null
  })
  return attempt
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
  const conn = await db()
  if (!conn) return fallback
  try {
    return await fn(conn)
  } catch {
    /* A transaction on a connection that has since closed fails here rather
       than through `onclose`. Dropping the memo costs one reopen and is the
       only way out if the held connection is dead. */
    pending = null
    return fallback
  }
}

/** Read one package's files. Null when this browser cannot store them. */
export function readPayload(id: string): Promise<PackageFiles | null> {
  return withDb(
    (db) =>
      new Promise<PackageFiles | null>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
        req.onsuccess = () => resolve((req.result as PackageFiles | undefined) ?? null)
        req.onerror = () => reject(req.error)
      }),
    null,
  )
}

/** False when the payload could not be stored, which install must not ignore. */
export function writePayload(id: string, files: PackageFiles): Promise<boolean> {
  return withDb(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(files, id)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
    false,
  )
}

export function deletePayload(id: string): Promise<boolean> {
  return withDb(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(id)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
    false,
  )
}

/* --- the store ----------------------------------------------------------- */

interface PackagesStore {
  installed: InstalledPackage[]
  /** Add or replace by id, newest install last. */
  put: (pkg: InstalledPackage) => void
  drop: (id: string) => void
  get: (id: string) => InstalledPackage | undefined
  clear: () => void
}

export const usePackages = create<PackagesStore>((set, get) => {
  const commit = (installed: InstalledPackage[]) => {
    set({ installed })
    persist(installed)
  }

  return {
    installed: load(),

    put: (pkg) => commit([...get().installed.filter((p) => p.manifest.id !== pkg.manifest.id), pkg]),
    drop: (id) => commit(get().installed.filter((p) => p.manifest.id !== id)),
    get: (id) => get().installed.find((p) => p.manifest.id === id),
    clear: () => commit([]),
  }
})

/**
 * Resolves once the payload store has been reached at least once, so a caller
 * can tell "no code for this package" from "IndexedDB has not answered yet".
 *
 * Resolve-never-reject, the same contract as `keyReady` in `store/settings.ts`:
 * a browser that cannot open the database is in exactly the state of one with
 * nothing stored, and both leave Coffee Shop able to list and uninstall.
 */
export const packagesReady: Promise<void> = withDb(async () => undefined, undefined)
