import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_IMPORT_BYTES, exportNode, importFiles } from '@/lib/transfer'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'

/**
 * jsdom has no host picker, no downloads directory and no real drag, so these
 * drive `lib/transfer` directly with hand-built Files -- which is the reason
 * the logic lives there and not inside Tracker. `pickFiles` and the drop
 * handler are browser-only and are verified by hand.
 */

const fs = () => useFs.getState()
const alerts = () => useDesktop.getState().alerts

let clicks: HTMLAnchorElement[] = []

beforeEach(() => {
  clicks = []
  // Neither of these exists in jsdom.
  URL.createObjectURL = vi.fn(() => 'blob:test')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this)
  })
})

describe('importing from the host', () => {
  it('writes a text file into the target folder', async () => {
    const written = await importFiles([new File(['hi there'], 'notes.txt')], '/boot/home')

    expect(written).toEqual(['/boot/home/notes.txt'])
    expect(fs().read('/boot/home/notes.txt')).toBe('hi there')
    expect(alerts()).toHaveLength(0)
  })

  it('lands a colliding name beside the original rather than over it', async () => {
    await importFiles([new File(['first'], 'notes.txt')], '/boot/home')
    const written = await importFiles([new File(['second'], 'notes.txt')], '/boot/home')

    expect(written).toEqual(['/boot/home/notes 2.txt'])
    expect(fs().read('/boot/home/notes.txt')).toBe('first')
    expect(fs().read('/boot/home/notes 2.txt')).toBe('second')
  })

  it('dedupes two files of the same name in one drop', async () => {
    const written = await importFiles(
      [new File(['a'], 'dup.txt'), new File(['b'], 'dup.txt')],
      '/boot/home',
    )

    expect(written).toEqual(['/boot/home/dup.txt', '/boot/home/dup 2.txt'])
  })

  it('refuses a file that is not text, and writes nothing', async () => {
    const written = await importFiles([new File(['PNG\u0000\u0000'], 'photo.png')], '/boot/home')

    expect(written).toEqual([])
    expect(fs().exists('/boot/home/photo.png')).toBe(false)
    expect(alerts()[0].text).toContain('"photo.png" is not a text file.')
  })

  it('refuses a file over the size limit without reading it', async () => {
    const big = new File(['x'], 'big.log')
    Object.defineProperty(big, 'size', { value: MAX_IMPORT_BYTES + 1 })

    const written = await importFiles([big], '/boot/home')

    expect(written).toEqual([])
    expect(fs().exists('/boot/home/big.log')).toBe(false)
    expect(alerts()[0].text).toContain('"big.log" is larger than 512 KiB.')
  })

  it('reports every refusal in one alert, and still imports the good ones', async () => {
    const written = await importFiles(
      [
        new File(['ok'], 'good.txt'),
        new File(['\u0000'], 'a.bin'),
        new File(['\uFFFD'], 'b.bin'),
      ],
      '/boot/home',
    )

    expect(written).toEqual(['/boot/home/good.txt'])
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0].text.split('\n')).toHaveLength(2)
  })

  it('does nothing when the target is not a directory', async () => {
    const written = await importFiles([new File(['hi'], 'notes.txt')], '/boot/home/readme.txt')

    expect(written).toEqual([])
    expect(fs().exists('/boot/home/readme.txt/notes.txt')).toBe(false)
  })
})

describe('exporting to the host', () => {
  it('hands a text node to the browser under its own name', () => {
    expect(exportNode('/boot/home/readme.txt')).toBe(true)
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toBe('readme.txt')
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
  })

  it('leaves no anchor behind in the document', () => {
    exportNode('/boot/home/readme.txt')
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('refuses a folder, an application and a path that is not there', () => {
    expect(exportNode('/boot/home/documents')).toBe(false)
    expect(exportNode('/boot/apps/Tracker')).toBe(false)
    expect(exportNode('/boot/home/nope.txt')).toBe(false)
    expect(clicks).toHaveLength(0)
  })
})
