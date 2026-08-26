import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MenuBar } from '@/widgets/Menu'
import type { MenuDef } from '@/widgets/Menu'
import { StyledEditIcon } from '@/lib/icons'
import { basename, dirname, useFs } from '@/store/fs'
import { useDesktop } from '@/store/desktop'
import { useCloseGuard } from '@/lib/closeGuards'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './stylededit.css'

const FONT_SIZES = [10, 12, 14, 18, 24]

export function StyledEdit({ windowId, args }: AppProps) {
  const [path, setPath] = useState<string | null>(args?.path ?? null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [fontSize, setFontSize] = useState(12)
  const [monospace, setMonospace] = useState(false)
  const [wrap, setWrap] = useState(true)

  const areaRef = useRef<HTMLTextAreaElement>(null)

  const read = useFs((s) => s.read)
  const write = useFs((s) => s.write)
  const setTitle = useDesktop((s) => s.setTitle)
  const showAlert = useDesktop((s) => s.showAlert)
  const showSavePanel = useDesktop((s) => s.showSavePanel)
  const showOpenPanel = useDesktop((s) => s.showOpenPanel)
  const requestClose = useDesktop((s) => s.requestClose)

  // Load the file once per path. Later external writes are deliberately not
  // pulled in -- clobbering what someone is typing would be worse.
  useEffect(() => {
    if (path) setText(read(path) ?? '')
    setDirty(false)
  }, [path, read])

  useEffect(() => {
    const name = path ? basename(path) : 'Untitled'
    setTitle(windowId, dirty ? `${name} *` : name)
  }, [dirty, path, setTitle, windowId])

  /** Prompt for a location and name. Resolves null if the user cancels. */
  const saveAs = useCallback(async (): Promise<string | null> => {
    const target = await showSavePanel(
      'Save as',
      path ? dirname(path) : '/boot/home/documents',
      path ? basename(path) : 'Untitled.txt',
    )
    if (!target) return null
    write(target, text)
    setPath(target)
    setDirty(false)
    return target
  }, [path, showSavePanel, text, write])

  /** An untitled document has nowhere to go, so Save becomes Save as. */
  const save = useCallback(async (): Promise<string | null> => {
    if (!path) return saveAs()
    write(path, text)
    setDirty(false)
    return path
  }, [path, saveAs, text, write])

  /**
   * Anything that throws the document away asks first. `what` finishes the
   * sentence, so closing and opening another file read as the same prompt.
   * Returns false to abort whatever was about to happen.
   */
  const confirmDiscard = useCallback(
    async (what: string) => {
      if (!dirty) return true
      const answer = await showAlert(
        'warn',
        'StyledEdit',
        `Save changes to "${path ? basename(path) : 'Untitled'}" ${what}`,
        ['Cancel', "Don't save", 'Save'],
        2,
      )
      if (answer === 0) return false
      if (answer === 2 && !(await save())) return false // save panel cancelled
      return true
    },
    [dirty, path, save, showAlert],
  )

  // Registered as this window's close guard, so *every* close path -- the tab's
  // close box, Alt+W and File > Close -- gets the same prompt.
  useCloseGuard(windowId, () => confirmDiscard('before closing?'))

  /**
   * Replace the document in this window with one from disk.
   *
   * The text is set here rather than left to the load effect: reopening the
   * file already showing does not change `path`, so the effect would not run
   * and a modified buffer would never revert.
   */
  const open = useCallback(async () => {
    if (!(await confirmDiscard('before opening another?'))) return
    const target = await showOpenPanel(
      'Open document',
      path ? dirname(path) : '/boot/home/documents',
    )
    if (!target) return
    setText(read(target) ?? '')
    setPath(target)
    setDirty(false)
  }, [confirmDiscard, path, read, showOpenPanel])

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'File',
        items: [
          { label: 'Open…', shortcut: 'Alt+O', onSelect: () => void open() },
          { separator: true },
          { label: 'Save', shortcut: 'Alt+S', disabled: !dirty && Boolean(path), onSelect: () => void save() },
          { label: 'Save as…', onSelect: () => void saveAs() },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      {
        title: 'Edit',
        items: [
          { label: 'Select all', shortcut: 'Alt+A', onSelect: () => areaRef.current?.select() },
          { separator: true },
          {
            label: 'Insert date',
            onSelect: () => {
              const area = areaRef.current
              if (!area) return
              const stamp = new Date().toLocaleString()
              const start = area.selectionStart
              setText((t) => t.slice(0, start) + stamp + t.slice(area.selectionEnd))
              setDirty(true)
            },
          },
        ],
      },
      {
        title: 'Font',
        items: [
          ...FONT_SIZES.map((size) => ({
            label: `${size} pt`,
            checked: fontSize === size,
            onSelect: () => setFontSize(size),
          })),
          { separator: true },
          {
            label: 'Fixed width',
            checked: monospace,
            onSelect: () => setMonospace((m) => !m),
          },
          { label: 'Wrap lines', checked: wrap, onSelect: () => setWrap((w) => !w) },
        ],
      },
    ],
    [requestClose, dirty, fontSize, monospace, open, path, save, saveAs, wrap, windowId],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // R5 used Alt for shortcuts where other systems use Control.
      if (!e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        void save()
      } else if (key === 'o') {
        e.preventDefault()
        void open()
      }
    },
    [open, save],
  )

  return (
    <div className="sedit">
      <MenuBar menus={menus} />
      <textarea
        ref={areaRef}
        className="sedit-area b-scroll selectable"
        value={text}
        spellCheck={false}
        wrap={wrap ? 'soft' : 'off'}
        aria-label="Document text"
        style={{
          fontSize,
          lineHeight: 1.35,
          fontFamily: monospace ? 'var(--font-fixed)' : 'var(--font-plain)',
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
        }}
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
        }}
        onKeyDown={onKeyDown}
      />
      <div className="sedit-status b-fixed">
        {path ?? 'Untitled — not saved yet'}
        <span className="b-spacer" />
        {text.length} chars
      </div>
    </div>
  )
}

registerApp({
  id: 'styledit',
  name: 'StyledEdit',
  component: StyledEdit,
  icon: StyledEditIcon,
  defaultW: 480,
  defaultH: 380,
  minW: 260,
  minH: 180,
})
