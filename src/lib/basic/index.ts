/**
 * Public surface of the BASIC runtime.
 *
 * Callers should reach for `build()` rather than parsing and compiling
 * separately: it is the only supported way to turn source into something the
 * interpreter accepts.
 */
export { build } from './build'
export { Interpreter } from './interpreter'
export type { Status, SliceOptions } from './interpreter'
export { BasicError } from './errors'
export { recordingHost } from './host'
export type { Host, RecordingHost } from './host'
export { Screen } from './screen'
export type { Sprite, PutAction, LineShape } from './screen'
export { MODES, EGA16, pixelAspect } from './modes'
export type { ModeInfo } from './modes'
export { tokenize } from './tokens'
export type { Token, TokenKind } from './tokens'
export { parseProgram, parseExpression } from './parser'
export { compile } from './compiler'
export type { Compiled, Instr } from './compiler'
