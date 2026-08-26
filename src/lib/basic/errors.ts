/**
 * A BASIC error always carries the line it happened on: the editor jumps to it,
 * and the console prints it the way a vintage interpreter would.
 */
export class BasicError extends Error {
  /** Program line number, or null for errors found before a line was known. */
  readonly line: number | null

  constructor(message: string, line: number | null = null) {
    super(message)
    this.name = 'BasicError'
    this.line = line
  }

  /** "Syntax error in 30" — the shape these messages traditionally take. */
  toString(): string {
    return this.line === null ? this.message : `${this.message} in ${this.line}`
  }
}

export const syntaxError = (message: string, line: number | null = null) =>
  new BasicError(`?${message}`, line)
