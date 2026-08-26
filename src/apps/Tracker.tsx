import { useCallback, useMemo, useState } from 'react'
import { MenuBar } from '@/widgets/Menu'
import type { MenuDef } from '@/widgets/Menu'
import { ScrollView } from '@/widgets/controls'
import { FolderIcon, TextFileIcon, AppIcon, TrackerIcon } from '@/lib/icons'
import type { FsNode } from '@/store/fs'
import { basename, dirname, joinPath, useFs } from '@/store/fs'
import { useDesktop } from '@/store/desktop'
import { getApp, launchApp, registerApp } from './registry'
import type { AppProps } from './registry'
import './tracker.css'

type ViewMode = 'icon' | 'list'

function iconFor(node: FsNode, size: number) {
  if (node.kind === 'dir') return <FolderIcon size={size} />
  if (node.kind === 'app') {
    const Icon = (node.appId && getApp(node.appId)?.icon) || AppIcon
    return <Icon size={size} />
  }
  return <TextFileIcon size={size} />
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sizeOf(node: FsNode) {
  if (node.kind === 'dir') return '--'
  const bytes = node.content?.length ?? 0
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`
}

export function Tracker({ windowId, args }: AppProps) {
  const [path, setPath] = useState(args?.path ?? '/boot/home')
  const [mode, setMode] = useState<ViewMode>('icon')
  const [selected, setSelected] = useState<string | null>(null)

  const setTitle = useDesktop((s) => s.setTitle)
  const showAlert = useDesktop((s) => s.showAlert)
  const requestClose = useDesktop((s) => s.requestClose)

  // Subscribing to `nodes` keeps the listing live when another app writes a file.
  const nodes = useFs((s) => s.nodes)
  const mkdir = useFs((s) => s.mkdir)
  const remove = useFs((s) => s.remove)
  const listOf = useFs((s) => s.list)

  const entries = useMemo(() => {
    void nodes
    return listOf(path)
  }, [nodes, listOf, path])

  const navigate = useCallback(
    (next: string) => {
      setPath(next)
      setSelected(null)
      setTitle(windowId, basename(next) === '/' ? 'Disk' : basename(next))
    },
    [setTitle, windowId],
  )

  const openNode = useCallback(
    (node: FsNode) => {
      if (node.kind === 'dir') {
        navigate(node.path)
      } else if (node.kind === 'app' && node.appId) {
        launchApp(node.appId)
      } else if (node.name.toLowerCase().endsWith('.bas')) {
        // Programs open in the interpreter, everything else in the editor.
        launchApp('basic', { path: node.path }, node.name)
      } else {
        launchApp('styledit', { path: node.path }, node.name)
      }
    },
    [navigate],
  )

  const newFolder = useCallback(() => {
    let name = 'New folder'
    let n = 1
    while (nodes[joinPath(path, name)]) name = `New folder ${++n}`
    mkdir(joinPath(path, name))
  }, [mkdir, nodes, path])

  const deleteSelected = useCallback(async () => {
    if (!selected) return
    const node = nodes[selected]
    if (!node) return
    const answer = await showAlert(
      'warn',
      'Tracker',
      `Delete "${node.name}"?\nThis cannot be undone.`,
      ['Cancel', 'Delete'],
      1,
    )
    if (answer === 1) {
      remove(selected)
      setSelected(null)
    }
  }, [nodes, remove, selected, showAlert])

  const atRoot = path === '/'

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'File',
        items: [
          { label: 'New folder', shortcut: 'Alt+N', onSelect: newFolder },
          { separator: true },
          {
            label: 'Open',
            disabled: !selected,
            onSelect: () => selected && nodes[selected] && openNode(nodes[selected]),
          },
          { label: 'Move to Trash', disabled: !selected, onSelect: deleteSelected },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      {
        title: 'Window',
        items: [
          { label: 'Parent folder', shortcut: 'Alt+Up', disabled: atRoot, onSelect: () => navigate(dirname(path)) },
          { label: 'Home', onSelect: () => navigate('/boot/home') },
          { separator: true },
          {
            label: 'Open Terminal here',
            onSelect: () => launchApp('terminal', { cwd: path }),
          },
        ],
      },
      {
        title: 'View',
        items: [
          { label: 'Icon view', checked: mode === 'icon', onSelect: () => setMode('icon') },
          { label: 'List view', checked: mode === 'list', onSelect: () => setMode('list') },
        ],
      },
    ],
    [atRoot, requestClose, deleteSelected, mode, navigate, newFolder, nodes, openNode, path, selected, windowId],
  )

  return (
    <div className="tracker">
      <MenuBar menus={menus} />

      <div className="tracker-locbar">
        <button
          type="button"
          className="b-button tracker-up"
          disabled={atRoot}
          onClick={() => navigate(dirname(path))}
          aria-label="Parent folder"
        >
          ▲
        </button>
        <span className="tracker-path b-fixed">{path}</span>
      </div>

      <ScrollView className={`tracker-view tracker-view--${mode}`}>
        {entries.length === 0 ? (
          <p className="tracker-empty">This folder is empty.</p>
        ) : mode === 'icon' ? (
          entries.map((node) => (
            <button
              key={node.path}
              type="button"
              className="tracker-icon"
              data-selected={selected === node.path}
              onClick={() => setSelected(node.path)}
              onDoubleClick={() => openNode(node)}
            >
              {iconFor(node, 32)}
              <span className="tracker-icon-label">{node.name}</span>
            </button>
          ))
        ) : (
          <table className="tracker-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((node) => (
                <tr
                  key={node.path}
                  data-selected={selected === node.path}
                  onClick={() => setSelected(node.path)}
                  onDoubleClick={() => openNode(node)}
                >
                  <td>
                    <span className="tracker-cell-name">
                      {iconFor(node, 16)}
                      {node.name}
                    </span>
                  </td>
                  <td>{sizeOf(node)}</td>
                  <td>{formatDate(node.modified)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ScrollView>

      <div className="tracker-status b-fixed">
        {entries.length} item{entries.length === 1 ? '' : 's'}
        {selected ? ` — ${basename(selected)}` : ''}
      </div>
    </div>
  )
}

registerApp({
  id: 'tracker',
  name: 'Tracker',
  component: Tracker,
  icon: TrackerIcon,
  defaultW: 520,
  defaultH: 360,
  minW: 300,
  minH: 200,
})
