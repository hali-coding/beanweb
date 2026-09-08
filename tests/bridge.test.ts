import { describe, expect, it } from 'vitest'

import {
  createBridge,
  isGuestMessage,
  packageRoot,
  resolveForPackage,
  resolveInPackage,
  type BridgeHost,
} from '@/lib/packages/bridge'
import { buildDocument } from '@/lib/packages/document'
import { encodeText } from '@/lib/packages/archive'
import type { PackageManifest, Permission } from '@/lib/packages/types'

const PKG = 'com.example.beanpaint'

function fakeHost(): BridgeHost & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    setTitle: (t) => void calls.push(`setTitle:${t}`),
    close: () => void calls.push('close'),
    alert: async (kind, text) => {
      calls.push(`alert:${kind}:${text}`)
      return 0
    },
    readFile: (p) => {
      calls.push(`read:${p}`)
      return 'contents'
    },
    writeFile: (p, c) => void calls.push(`write:${p}:${c}`),
    listDir: (p) => {
      calls.push(`list:${p}`)
      return ['a.txt']
    },
    removeFile: (p) => {
      calls.push(`remove:${p}`)
      return true
    },
  }
}

const bridge = (permissions: Permission[] = ['fs'], openPath?: string) => {
  const host = fakeHost()
  return { host, handle: createBridge({ pkgId: PKG, permissions, openPath }, host) }
}

describe('the package path jail', () => {
  it('resolves a plain name inside the package folder', () => {
    expect(resolveInPackage(PKG, 'notes.txt')).toBe(`${packageRoot(PKG)}/notes.txt`)
    expect(resolveInPackage(PKG, './a/b.txt')).toBe(`${packageRoot(PKG)}/a/b.txt`)
  })

  it('refuses everything that escapes', () => {
    for (const path of [
      '../../../boot/home/documents/secret.txt',
      '..',
      '/boot/home/documents/secret.txt',
      '/',
      '../' + PKG + '-evil/x',
    ]) {
      expect(resolveInPackage(PKG, path), path).toBeNull()
    }
  })

  it('refuses a path that is not a string', () => {
    expect(resolveInPackage(PKG, undefined)).toBeNull()
    expect(resolveInPackage(PKG, 42)).toBeNull()
    expect(resolveInPackage(PKG, '')).toBeNull()
  })
})

describe('the opened document', () => {
  const DOC = '/boot/home/documents/logo.bicon'
  const ctx = { pkgId: PKG, permissions: ['fs'] as Permission[], openPath: DOC }

  it('is reachable by its exact path, though it is outside the folder', () => {
    expect(resolveInPackage(PKG, DOC)).toBeNull()
    expect(resolveForPackage(ctx, DOC)).toBe(DOC)
  })

  it('grants nothing else in the folder it happens to live in', () => {
    expect(resolveForPackage(ctx, '/boot/home/documents/secret.txt')).toBeNull()
    expect(resolveForPackage(ctx, '/boot/home/documents')).toBeNull()
    // No relative route to it either.
    expect(resolveForPackage(ctx, '../../documents/logo.bicon')).toBeNull()
  })

  it('grants nothing at all when the window was not opened on one', () => {
    expect(resolveForPackage({ pkgId: PKG, permissions: ['fs'] }, DOC)).toBeNull()
  })

  it('is reported by ready, so the guest knows to load it', async () => {
    const { handle } = bridge(['fs'], DOC)
    const reply = await handle({ id: 1, verb: 'ready' })
    expect(reply.value).toEqual({ pkgId: PKG, root: packageRoot(PKG), path: DOC })
  })

  it('is null on ready when there is none', async () => {
    const { handle } = bridge()
    expect((await handle({ id: 1, verb: 'ready' })).value).toMatchObject({ path: null })
  })

  it('can be read and written but not deleted', async () => {
    const { handle, host } = bridge(['fs'], DOC)
    expect((await handle({ id: 2, verb: 'fs.read', path: DOC })).ok).toBe(true)
    expect((await handle({ id: 3, verb: 'fs.write', path: DOC, content: 'x' })).ok).toBe(true)

    const removed = await handle({ id: 4, verb: 'fs.remove', path: DOC })
    expect(removed.ok).toBe(false)
    expect(removed.error).toMatch(/Cannot remove the opened document/)
    expect(host.calls).toEqual([`read:${DOC}`, `write:${DOC}:x`])
  })

  it('still needs the fs permission', async () => {
    const { handle } = bridge([], DOC)
    expect((await handle({ id: 5, verb: 'fs.read', path: DOC })).ok).toBe(false)
  })
})

describe('the bridge', () => {
  it('answers ready with the package root', async () => {
    const { handle } = bridge()
    const reply = await handle({ id: 1, verb: 'ready' })
    expect(reply).toEqual({
      id: 1,
      ok: true,
      value: { pkgId: PKG, root: packageRoot(PKG), path: null },
    })
  })

  it('refuses a verb it does not know', async () => {
    const { handle } = bridge()
    const reply = await handle({ id: 2, verb: 'eval' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/not something a package can ask for/)
  })

  it('refuses filesystem verbs without the permission', async () => {
    const { handle, host } = bridge([])
    for (const verb of ['fs.read', 'fs.write', 'fs.list', 'fs.remove']) {
      const reply = await handle({ id: 3, verb, path: 'a.txt', content: 'x' })
      expect(reply.ok, verb).toBe(false)
      expect(reply.error).toMatch(/did not ask for filesystem access/)
    }
    expect(host.calls).toEqual([])
  })

  it('refuses a read that escapes the package folder', async () => {
    const { handle, host } = bridge()
    const reply = await handle({ id: 4, verb: 'fs.read', path: '../../documents/secret.txt' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/outside the package folder/)
    // The important half: the host was never asked.
    expect(host.calls).toEqual([])
  })

  it('reads and writes inside the package folder', async () => {
    const { handle, host } = bridge()
    expect(await handle({ id: 5, verb: 'fs.read', path: 'notes.txt' })).toEqual({
      id: 5,
      ok: true,
      value: 'contents',
    })
    await handle({ id: 6, verb: 'fs.write', path: 'notes.txt', content: 'hi' })
    expect(host.calls).toEqual([
      `read:${packageRoot(PKG)}/notes.txt`,
      `write:${packageRoot(PKG)}/notes.txt:hi`,
    ])
  })

  it('will not let a package delete its own folder', async () => {
    const { handle } = bridge()
    const reply = await handle({ id: 7, verb: 'fs.remove', path: '.' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/Cannot remove the package folder/)
  })

  it('caps a title rather than letting it push the chrome around', async () => {
    const { handle, host } = bridge()
    await handle({ id: 8, verb: 'setTitle', title: `  ${'x'.repeat(200)}  ` })
    expect(host.calls[0]).toBe(`setTitle:${'x'.repeat(64)}`)
  })

  it('does not throw when the host does', async () => {
    const host = fakeHost()
    host.readFile = () => {
      throw new Error('disk on fire')
    }
    const handle = createBridge({ pkgId: PKG, permissions: ['fs'] }, host)
    expect(await handle({ id: 9, verb: 'fs.read', path: 'a.txt' })).toEqual({
      id: 9,
      ok: false,
      error: 'disk on fire',
    })
  })

  it('recognises only well-formed messages', () => {
    expect(isGuestMessage({ id: 1, verb: 'ready' })).toBe(true)
    expect(isGuestMessage({ verb: 'ready' })).toBe(false)
    expect(isGuestMessage({ id: '1', verb: 'ready' })).toBe(false)
    expect(isGuestMessage(null)).toBe(false)
    expect(isGuestMessage('ready')).toBe(false)
  })
})

describe('the guest document', () => {
  const manifest: PackageManifest = {
    format: 1,
    id: PKG,
    name: 'Bean Paint',
    version: '1.0.0',
    kind: 'sandboxed',
    entry: 'main.js',
    window: { defaultW: 400, defaultH: 300 },
    permissions: [],
  }

  it('carries a CSP that denies by default and blocks the network', () => {
    const doc = buildDocument(manifest, { 'main.js': encodeText('1') })
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("connect-src 'none'")
  })

  it('puts the shim in before the package script', () => {
    const doc = buildDocument(manifest, { 'main.js': encodeText('window.bw.close()') })
    expect(doc.indexOf('window.bw =')).toBeLessThan(doc.indexOf('window.bw.close()'))
  })

  it('does not let a package end the script block early', () => {
    // A literal </script> in the source would otherwise close the element and
    // spill the rest of the program into the document as markup.
    const doc = buildDocument(manifest, {
      'main.js': encodeText('var s = "</script><img src=x onerror=alert(1)>"'),
    })
    expect(doc).not.toContain('</script><img')
    expect(doc).toContain('<\\/script>')
  })

  it('runs the package script inside the body, not the head', () => {
    // A package whose first line touches document.body must find one. The
    // script has to come after <body>, or the parser leaves it in the head.
    const doc = buildDocument(manifest, { 'main.js': encodeText('document.body.x = 1') })
    expect(doc.indexOf('<body>')).toBeLessThan(doc.indexOf('document.body.x'))
    expect(doc.indexOf('</head>')).toBeLessThan(doc.indexOf('<body>'))
  })

  it('reports a missing entry rather than building a broken page', () => {
    expect(buildDocument(manifest, {})).toContain('has no "main.js"')
  })
})
