import { describe, expect, it } from 'vitest'
import { basename, dirname, joinPath, resolvePath, useFs } from '@/store/fs'

const fs = () => useFs.getState()

describe('path helpers', () => {
  it('splits paths', () => {
    expect(dirname('/boot/home/readme.txt')).toBe('/boot/home')
    expect(dirname('/boot')).toBe('/')
    expect(dirname('/')).toBe('/')
    expect(basename('/boot/home/readme.txt')).toBe('readme.txt')
    expect(basename('/')).toBe('/')
    expect(joinPath('/', 'boot')).toBe('/boot')
    expect(joinPath('/boot', 'home')).toBe('/boot/home')
  })

  it('resolves . and .. against a working directory', () => {
    expect(resolvePath('/boot/home', 'documents')).toBe('/boot/home/documents')
    expect(resolvePath('/boot/home', '..')).toBe('/boot')
    expect(resolvePath('/boot/home', '../../')).toBe('/')
    expect(resolvePath('/boot/home', './documents/./tips.txt')).toBe('/boot/home/documents/tips.txt')
    expect(resolvePath('/boot/home', '/boot/apps')).toBe('/boot/apps')
    // Climbing past the root clamps rather than producing a broken path.
    expect(resolvePath('/', '../../..')).toBe('/')
  })
})

describe('filesystem', () => {
  it('seeds a disk with the expected shape', () => {
    expect(fs().exists('/boot/home/readme.txt')).toBe(true)
    expect(fs().read('/boot/home/readme.txt')).toContain('Welcome to BeanWeb')
    expect(fs().list('/boot/home').map((n) => n.name)).toContain('documents')
  })

  it('lists directories first, then case-insensitively by name', () => {
    fs().write('/boot/home/apple.txt', 'a')
    fs().mkdir('/boot/home/Zebra')
    const names = fs().list('/boot/home').map((n) => n.name)
    const firstFile = names.findIndex((n) => n.endsWith('.txt'))
    const lastDir = names.lastIndexOf('Zebra')
    expect(lastDir).toBeLessThan(firstFile)
  })

  it('writes and reads back', () => {
    fs().write('/boot/home/new.txt', 'hello')
    expect(fs().read('/boot/home/new.txt')).toBe('hello')
    fs().write('/boot/home/new.txt', 'changed')
    expect(fs().read('/boot/home/new.txt')).toBe('changed')
  })

  it('refuses to mkdir over an existing node', () => {
    expect(fs().mkdir('/boot/home/fresh')).toBe(true)
    expect(fs().mkdir('/boot/home/fresh')).toBe(false)
  })

  it('removes a directory with its whole subtree', () => {
    fs().mkdir('/boot/home/tree')
    fs().mkdir('/boot/home/tree/inner')
    fs().write('/boot/home/tree/inner/deep.txt', 'x')
    expect(fs().remove('/boot/home/tree')).toBe(true)
    expect(fs().exists('/boot/home/tree/inner/deep.txt')).toBe(false)
    expect(fs().exists('/boot/home/tree')).toBe(false)
  })

  it('never removes the root', () => {
    expect(fs().remove('/')).toBe(false)
    expect(fs().exists('/')).toBe(true)
  })

  it('renames a directory and re-parents its descendants', () => {
    fs().mkdir('/boot/home/old')
    fs().write('/boot/home/old/child.txt', 'kept')
    expect(fs().rename('/boot/home/old', 'renamed')).toBe(true)
    expect(fs().exists('/boot/home/old/child.txt')).toBe(false)
    expect(fs().read('/boot/home/renamed/child.txt')).toBe('kept')
  })

  it('rejects renames that collide or contain a separator', () => {
    fs().mkdir('/boot/home/one')
    fs().mkdir('/boot/home/two')
    expect(fs().rename('/boot/home/one', 'two')).toBe(false)
    expect(fs().rename('/boot/home/one', 'a/b')).toBe(false)
    expect(fs().rename('/boot/home/nope', 'x')).toBe(false)
  })
})
