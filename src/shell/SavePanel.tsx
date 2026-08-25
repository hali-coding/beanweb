import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ScrollView, TextControl } from '@/widgets/controls'
import { FolderIcon, TextFileIcon } from '@/lib/icons'
import { dirname, joinPath, useFs } from '@/store/fs'
import { selectSavePanels, useDesktop } from '@/store/desktop'
import type { SavePanelState } from '@/lib/types'

/**
 * BFilePanel in save mode: browse to a directory, type a name, Save.
 *
 * Like alerts, only the newest panel is shown and the rest queue behind it.
 */
export function SavePanel() {
  const panels = useDesktop(selectSavePanels)
  const panel = panels[panels.length - 1]
  // Keyed so each panel starts with its own directory and name state.
  return panel ? <SavePanelBody key={panel.id} panel={panel} /> : null
}

function SavePanelBody({ panel }: { panel: SavePanelState }) {
  const dismiss = useDesktop((s) => s.dismissSavePanel)
  const showAlert = useDesktop((s) => s.showAlert)

  const nodes = useFs((s) => s.nodes)
  const listOf = useFs((s) => s.list)

  const [dir, setDir] = useState(panel.directory)
  const [name, setName] = useState(panel.name)
  const nameRef = useRef<HTMLInputElement>(null)

  // Focus the name and preselect the stem, so typing replaces the name but
  // keeps the extension -- what every save dialog is expected to do.
  useEffect(() => {
    const el = nameRef.current
    if (!el) return
    el.focus()
    const dot = el.value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
  }, [])

  const entries = useMemo(() => {
    void nodes
    return listOf(dir)
  }, [nodes, listOf, dir])

  const atRoot = dir === '/'

  const confirm = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (trimmed.includes('/')) {
      await showAlert('stop', 'Save', 'A file name cannot contain "/".')
      return
    }
    const target = joinPath(dir, trimmed)
    const existing = nodes[target]
    if (existing?.kind === 'dir') {
      await showAlert('stop', 'Save', `"${trimmed}" is a folder.\nChoose another name.`)
      return
    }
    if (existing) {
      const answer = await showAlert(
        'warn',
        'Save',
        `"${trimmed}" already exists.\nReplace it?`,
        ['Cancel', 'Replace'],
        0,
      )
      if (answer !== 1) return
    }
    dismiss(panel.id, target)
  }, [dir, dismiss, name, nodes, panel.id, showAlert])

  const cancel = useCallback(() => dismiss(panel.id, null), [dismiss, panel.id])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void confirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    },
    [cancel, confirm],
  )

  return (
    <div className="b-alert-scrim" onKeyDown={onKeyDown}>
      <div className="savepanel" role="dialog" aria-modal="true" aria-label={panel.title}>
        <div className="savepanel-nav">
          <Button
            className="savepanel-up"
            disabled={atRoot}
            aria-label="Parent folder"
            onClick={() => setDir(dirname(dir))}
          >
            ▲
          </Button>
          <span className="savepanel-dir b-fixed">{dir}</span>
        </div>

        <ScrollView className="savepanel-list">
          {entries.length === 0 ? (
            <p className="savepanel-empty">This folder is empty.</p>
          ) : (
            entries.map((node) => (
              <button
                key={node.path}
                type="button"
                className="savepanel-row"
                data-dim={node.kind === 'app'}
                onDoubleClick={() => node.kind === 'dir' && setDir(node.path)}
                onClick={() => {
                  // Clicking a file adopts its name; folders need a double-click
                  // to enter, matching Tracker.
                  if (node.kind === 'text') setName(node.name)
                }}
              >
                {node.kind === 'dir' ? <FolderIcon size={16} /> : <TextFileIcon size={16} />}
                <span className="savepanel-row-name">{node.name}</span>
              </button>
            ))
          )}
        </ScrollView>

        <div className="savepanel-name">
          <label htmlFor="savepanel-name-field">Save as:</label>
          <TextControl
            id="savepanel-name-field"
            ref={nameRef}
            value={name}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="savepanel-buttons">
          <Button onClick={cancel}>Cancel</Button>
          <Button isDefault disabled={!name.trim()} onClick={() => void confirm()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
