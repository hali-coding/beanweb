/**
 * Sealed storage for the one secret BeanWeb holds: the user's Anthropic API key.
 *
 * The key has to be recoverable -- every request sends it to the API -- so it
 * cannot be hashed, and anything the page can reverse on its own is decoration.
 * What IndexedDB buys is a *non-extractable* `CryptoKey`: the browser will
 * encrypt and decrypt with it all day and will never hand out its bytes, not to
 * this code and not to a `structuredClone`. `localStorage` then holds ciphertext
 * only.
 *
 * Read the boundary honestly. This defeats the passive cases -- a glance at
 * devtools, a `localStorage` dump, a synced or backed-up browser profile, the
 * next person on a shared machine. It does nothing about a hostile script on
 * the origin, which simply calls `unseal()` itself; that is the tradeoff
 * `dangerouslyAllowBrowser` already names in `apps/Claude.tsx`.
 *
 * Everything here fails soft. `crypto.subtle` is absent outside a secure
 * context and IndexedDB is absent in private-mode variants and under jsdom, so
 * `seal()` returns null and the key simply does not persist -- the session
 * still works, the user re-enters the key next boot. Writing it in the clear
 * instead is the one fallback deliberately not offered.
 */

const DB_NAME = 'beanweb.keystore'
const STORE = 'keys'
const RECORD = 'settings'

const ALGORITHM = 'AES-GCM'
/** AES-GCM's standard nonce width. Fresh per seal, stored beside the payload. */
const IV_BYTES = 12

/** What `localStorage` gets: base64 nonce and base64 ciphertext, nothing else. */
export interface Sealed {
  iv: string
  data: string
}

export function isSealed(value: unknown): value is Sealed {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<Sealed>
  return typeof s.iv === 'string' && typeof s.data === 'string' && s.data.length > 0
}

/* --- base64 -------------------------------------------------------------
   The payload is an API key, so tens of bytes; a loop is clearer than the
   chunked spread a large buffer would need. */

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// The explicit buffer type is TypeScript 5.7's generic Uint8Array biting: an
// un-annotated one widens to ArrayBufferLike, which SubtleCrypto will not take.
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text)
  const bytes = new Uint8Array(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

/* --- the IndexedDB record ----------------------------------------------- */

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('keystore blocked'))
  })
}

function read(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function write(db: IDBDatabase, value: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, RECORD)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * The device key, generated once and kept from then on.
 *
 * Memoised as the promise rather than the key: `seal` and `unseal` can both be
 * in flight during boot, and two concurrent misses would otherwise generate two
 * keys and race to store them -- the loser's ciphertext would be undecryptable
 * for the rest of the browser profile's life.
 */
let pending: Promise<CryptoKey | null> | null = null

function load(): Promise<CryptoKey | null> {
  pending ??= (async () => {
    if (!globalThis.crypto?.subtle || typeof indexedDB === 'undefined') return null
    try {
      const db = await open()
      const stored = await read(db)
      // A CryptoKey survives IndexedDB by structured clone; anything else in
      // that slot is a foreign write, and replacing it is the only way out.
      if (stored instanceof CryptoKey) return stored

      const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, false, [
        'encrypt',
        'decrypt',
      ])
      await write(db, key)
      return key
    } catch {
      return null
    }
  })()
  return pending
}

/** Encrypt a secret for `localStorage`. Null when this browser cannot seal, which
 *  the caller must read as "do not persist it", never as "persist it plainly". */
export async function seal(secret: string): Promise<Sealed | null> {
  const key = await load()
  if (!key) return null
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const data = await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      key,
      new TextEncoder().encode(secret),
    )
    return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }
  } catch {
    return null
  }
}

/** The inverse. Null for a record this browser cannot open -- a profile whose
 *  IndexedDB was cleared while `localStorage` survived, or a tampered payload,
 *  both of which mean the same thing to the caller: ask for the key again. */
export async function unseal(sealed: Sealed): Promise<string | null> {
  const key = await load()
  if (!key) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: fromBase64(sealed.iv) },
      key,
      fromBase64(sealed.data),
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/** Test seam: drops the memoised key so a suite can swap the environment
 *  underneath it. Nothing in the app calls this -- the key is meant to outlive
 *  every session on the profile. */
export function resetKeystoreForTests() {
  pending = null
}
