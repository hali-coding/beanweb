import { BasicError } from './errors'

/**
 * BASIC value semantics.
 *
 * Two types only: number and string. Following Microsoft BASIC, comparisons
 * yield -1 for true and 0 for false — not 1 — which is why `IF A = B THEN`
 * and `IF NOT X THEN` compose the way vintage listings expect.
 */

export type Value = number | string

export const TRUE = -1
export const FALSE = 0

export const isString = (v: Value): v is string => typeof v === 'string'

/** Whether a variable name denotes a string, i.e. ends in $. */
export const isStringName = (name: string) => name.endsWith('$')

/** The zero value a variable starts life with. */
export const defaultFor = (name: string): Value => (isStringName(name) ? '' : 0)

export function toNumber(v: Value, line: number | null = null): number {
  if (typeof v === 'number') return v
  throw new BasicError('?Type mismatch error', line)
}

export function toStringValue(v: Value, line: number | null = null): string {
  if (typeof v === 'string') return v
  throw new BasicError('?Type mismatch error', line)
}

/** Truthiness: zero is false, everything else true. Strings cannot be tested. */
export function truthy(v: Value, line: number | null = null): boolean {
  return toNumber(v, line) !== 0
}

/**
 * How BASIC prints a number: integers bare, and a leading space for
 * non-negatives where the minus sign would otherwise go.
 */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n > 0 ? 'INF' : '-INF'
  // Avoid 0.30000000000000004 while keeping useful precision.
  const rounded = Number(n.toPrecision(9))
  const text = Object.is(rounded, -0) ? '0' : String(rounded)
  return rounded < 0 ? text : ` ${text}`
}

export function format(v: Value): string {
  return isString(v) ? v : formatNumber(v)
}

/** Comparison across both types; mixing them is a type mismatch. */
export function compare(a: Value, b: Value, line: number | null = null): number {
  if (isString(a) !== isString(b)) throw new BasicError('?Type mismatch error', line)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
