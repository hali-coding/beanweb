/**
 * Reading and checking a package's `manifest.json`.
 *
 * The split here is the same one `lib/draw/svg.ts` draws between throwing and
 * reporting: `parseManifest` throws only when there is nothing to look at, and
 * everything a human could reasonably be asked about comes back from
 * `validatePackage` as a list. That is `validateLevel`'s shape too, and for the
 * same reason -- Coffee Shop shows the list before installing, and one day a
 * packaging tool will show the same list before publishing. One implementation,
 * so a package that passes locally is a package that passes on the way in.
 */

import {
  FORMAT,
  PERMISSIONS,
  PackageError,
  type PackageContents,
  type PackageManifest,
  type PackageWindow,
  type Permission,
} from './types'

export interface Problem {
  severity: 'error' | 'warning'
  message: string
  /** Which manifest field it is about, when it is about one. */
  field?: string
}

/** Reverse-DNS: lower-case alphanumeric segments, at least two of them. */
const ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)+$/
const VERSION_RE = /^\d+(?:\.\d+)*(?:-[0-9a-z.]+)?$/i
const MAX_ID = 64
const MAX_NAME = 48

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Coerce parsed JSON into a manifest, filling defaults.
 *
 * Deliberately lenient: a missing or nonsense field becomes its default and is
 * then reported by `validateManifest`, rather than throwing here and giving the
 * user one problem at a time. Only "this is not an object at all" throws.
 */
export function parseManifest(text: string): PackageManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new PackageError(`manifest.json is not valid JSON: ${(err as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackageError('manifest.json is not a JSON object.')
  }
  const m = raw as Record<string, unknown>
  const win = (m.window && typeof m.window === 'object' ? m.window : {}) as Record<string, unknown>

  const window: PackageWindow = { defaultW: num(win.defaultW, 420), defaultH: num(win.defaultH, 320) }
  if (typeof win.minW === 'number') window.minW = win.minW
  if (typeof win.minH === 'number') window.minH = win.minH

  const out: PackageManifest = {
    format: num(m.format, 0),
    id: str(m.id).trim(),
    name: str(m.name).trim(),
    version: str(m.version).trim(),
    // Unknown kinds survive parsing so validate can name the one it found.
    kind: str(m.kind).trim() as PackageManifest['kind'],
    entry: str(m.entry).trim(),
    window,
    permissions: Array.isArray(m.permissions)
      ? (m.permissions.filter((p): p is string => typeof p === 'string') as Permission[])
      : [],
  }

  /*
   * Optional fields are assigned only when present, never set to `undefined`.
   * `JSON.stringify` drops an undefined-valued key, so a manifest carrying one
   * would come back from `writePackage` without it and the round trip would
   * not be an equality -- the same canonical-model rule `parseSVG` follows.
   */
  const publisher = str(m.publisher).trim()
  if (publisher) out.publisher = publisher
  const summary = str(m.summary).trim()
  if (summary) out.summary = summary
  const description = str(m.description).trim()
  if (description) out.description = description
  const icon = str(m.icon).trim()
  if (icon) out.icon = icon
  if (m.singleton === true) out.singleton = true
  if (Array.isArray(m.extensions)) {
    out.extensions = m.extensions
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.toLowerCase())
  }
  return out
}

/**
 * A path is safe inside the archive if it stays inside the archive. Rejects
 * absolute paths, `..` segments and Windows separators, which is the same
 * question the sandbox bridge asks about the virtual disk.
 */
export function isSafeEntryPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  return !path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
}

export function validateManifest(m: PackageManifest): Problem[] {
  const problems: Problem[] = []
  const err = (message: string, field?: string) =>
    problems.push({ severity: 'error', message, field })
  const warn = (message: string, field?: string) =>
    problems.push({ severity: 'warning', message, field })

  if (m.format > FORMAT) {
    err(`This package needs format ${m.format}; this version of BeanWeb reads ${FORMAT}.`, 'format')
  } else if (m.format < 1) {
    err('The manifest has no "format".', 'format')
  }

  if (!m.id) err('The package has no id.', 'id')
  else if (m.id.length > MAX_ID) err(`The id is longer than ${MAX_ID} characters.`, 'id')
  else if (!ID_RE.test(m.id)) {
    err('The id must be lower-case reverse-DNS, e.g. "com.example.beanpaint".', 'id')
  }

  if (!m.name) err('The package has no name.', 'name')
  else if (m.name.length > MAX_NAME) err(`The name is longer than ${MAX_NAME} characters.`, 'name')

  if (!m.version) err('The package has no version.', 'version')
  else if (!VERSION_RE.test(m.version)) warn(`"${m.version}" is not a dotted version.`, 'version')

  if (m.kind !== 'sandboxed') {
    err(`"${m.kind || '(none)'}" is not a package kind this BeanWeb runs.`, 'kind')
  }

  if (!m.entry) err('The manifest names no entry script.', 'entry')
  else if (!isSafeEntryPath(m.entry)) err(`"${m.entry}" is not a path inside the package.`, 'entry')

  if (m.icon !== undefined && !isSafeEntryPath(m.icon)) {
    err(`"${m.icon}" is not a path inside the package.`, 'icon')
  }

  const { defaultW, defaultH, minW, minH } = m.window
  if (defaultW < 120 || defaultW > 4000) err('The default width is out of range.', 'window')
  if (defaultH < 80 || defaultH > 4000) err('The default height is out of range.', 'window')
  if (minW !== undefined && minW > defaultW) warn('The minimum width exceeds the default.', 'window')
  if (minH !== undefined && minH > defaultH) {
    warn('The minimum height exceeds the default.', 'window')
  }

  for (const ext of m.extensions ?? []) {
    if (!ext.startsWith('.') || ext.length < 2 || /[\/\\.\s]/.test(ext.slice(1))) {
      err(`"${ext}" is not a file extension.`, 'extensions')
    }
  }

  /*
   * An unknown permission is a warning, not an error: it is simply not granted,
   * so the package runs with less than it asked for rather than not at all.
   * That is the forward-compatible direction -- the failure is safe.
   */
  for (const p of m.permissions) {
    if (!PERMISSIONS.includes(p)) warn(`"${p}" is not a permission this BeanWeb grants.`, 'permissions')
  }

  return problems
}

/** The manifest's problems, plus the ones only the archive can answer. */
export function validatePackage(contents: PackageContents): Problem[] {
  const { manifest, files } = contents
  const problems = validateManifest(manifest)

  if (manifest.entry && isSafeEntryPath(manifest.entry) && !(manifest.entry in files)) {
    problems.push({
      severity: 'error',
      message: `The entry script "${manifest.entry}" is not in the package.`,
      field: 'entry',
    })
  }
  if (manifest.icon && isSafeEntryPath(manifest.icon) && !(manifest.icon in files)) {
    problems.push({
      severity: 'warning',
      message: `The icon "${manifest.icon}" is not in the package; the generic one is used.`,
      field: 'icon',
    })
  }
  return problems
}

export const errorsIn = (problems: Problem[]): Problem[] =>
  problems.filter((p) => p.severity === 'error')
