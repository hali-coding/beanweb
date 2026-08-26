import { useDesktop } from '@/store/desktop'
import { joinPath, useFs } from '@/store/fs'

/**
 * The two doors between the virtual disk and the real computer.
 *
 * Lives here rather than in any caller because Tracker's File menu, a drop onto
 * a Tracker window and Terminal's `import`/`export` all offer the same thing,
 * and the size limit, the refusal wording and the collision rule must not be
 * able to drift between the three. Reads the stores through `getState()` for
 * the same reason `lib/disk.ts` does -- these are actions, not subscriptions,
 * and nothing renders from them.
 *
 * It is also the only seam a test can reach: the host picker and the download
 * anchor do not exist under jsdom, but `importFiles` takes a hand-built `File`.
 */

/**
 * Per file. The whole disk lives in one localStorage key and the quota is
 * around 5 MB; `store/fs.ts` swallows a quota failure silently, so without a
 * limit here a large import would look like it worked and be gone on reload.
 */
export const MAX_IMPORT_BYTES = 512 * 1024

/** NUL, or the replacement character a failed UTF-8 decode leaves behind. */
const looksBinary = (text: string) => /[\u0000\uFFFD]/.test(text)

/** Open the host's file picker. Resolves `[]` if the user cancels. */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    // Deliberately no `accept`: on Windows a filter list *replaces* "All
    // files" rather than adding to it, which would hide an extension-less
    // text file. What counts as text is decided by reading the bytes.
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true })
    // Where the browser fires it, this settles the promise on a cancelled
    // picker instead of leaving it pending for the life of the tab.
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}

/** "notes.txt" landing beside an existing "notes.txt" becomes "notes 2.txt". */
function uniqueName(dir: string, name: string): string {
  const nodes = useFs.getState().nodes
  if (!nodes[joinPath(dir, name)]) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 1
  let candidate = name
  while (nodes[joinPath(dir, candidate)]) candidate = `${stem} ${++n}${ext}`
  return candidate
}

/**
 * Read host files as text and write them into `dir`, resolving the paths
 * written. A file that is too large or is not text is skipped; the skipped
 * ones are reported together in one alert rather than one apiece.
 */
export async function importFiles(files: File[], dir: string): Promise<string[]> {
  const parent = useFs.getState().nodes[dir]
  if (!parent || parent.kind !== 'dir') return []

  const written: string[] = []
  const refused: string[] = []

  for (const file of files) {
    // A directory drop hands over paths, not bare names.
    const name = file.name.split(/[\/]/).pop() ?? ''
    if (!name) continue

    if (file.size > MAX_IMPORT_BYTES) {
      refused.push(`"${name}" is larger than ${MAX_IMPORT_BYTES / 1024} KiB.`)
      continue
    }

    const text = await file.text()
    if (looksBinary(text)) {
      refused.push(`"${name}" is not a text file.`)
      continue
    }

    // Read fresh each time, so two files of the same name in one drop do not
    // collide with each other.
    const target = joinPath(dir, uniqueName(dir, name))
    useFs.getState().write(target, text)
    written.push(target)
  }

  if (refused.length) {
    void useDesktop.getState().showAlert('stop', 'Import', refused.join('\n'))
  }
  return written
}

/** Pick and import in one call -- what all three entry points invoke. */
export async function importFromHost(dir: string): Promise<string[]> {
  return importFiles(await pickFiles(), dir)
}

/**
 * Hand a text node to the browser as a download. False if the path is not a
 * text node -- directories and application stubs have no content to write.
 */
export function exportNode(path: string): boolean {
  const node = useFs.getState().nodes[path]
  if (!node || node.kind !== 'text') return false

  const blob = new Blob([node.content ?? ''], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = node.name
  // An anchor outside the document does not reliably start a download.
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking in the same task races the download; let the click finish first.
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}
