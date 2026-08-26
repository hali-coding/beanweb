import { describe, expect, it } from 'vitest'
import { build } from '@/lib/basic'
import type { BasicError } from '@/lib/basic'
// Vite's ?raw import: node:fs and import.meta.url are not usable under jsdom.
import SOURCE from './fixtures/gorilla.bas?raw'

/**
 * The goal: run Microsoft's GORILLA.BAS (1990) unmodified.
 *
 * This is the progress meter for that. It is expected to fail until the
 * graphics, text-grid and sprite work lands; the message names the first thing
 * still missing, which is the next thing to build.
 */
describe('GORILLA.BAS', () => {
  it('is the real 1990 Microsoft listing', () => {
    expect(SOURCE).toContain('Q B a s i c   G o r i l l a s')
    expect(SOURCE).toContain('Copyright (C) Microsoft Corporation 1990')
    expect(SOURCE.split('\n').length).toBeGreaterThan(1000)
  })

  it.fails('compiles', () => {
    try {
      build(SOURCE)
    } catch (err) {
      const e = err as BasicError
      throw new Error(`first blocker -> line ${e.line}: ${e.message}`)
    }
  })
})
