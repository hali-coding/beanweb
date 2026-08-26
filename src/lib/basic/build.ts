import { compile } from './compiler'
import type { Compiled } from './compiler'
import { parseProgram } from './parser'

/** Parse and compile source into a runnable program. */
export function build(source: string): Compiled {
  return compile(parseProgram(source))
}
