import { create } from 'zustand'

/**
 * A small in-memory filesystem, persisted to localStorage.
 *
 * Nodes are stored flat and keyed by path rather than by id: paths are what
 * Tracker, Terminal and StyledEdit all address files by, so keying on them
 * keeps every lookup O(1) and avoids a parallel id->path index.
 */

export type NodeKind = 'dir' | 'text' | 'app'

export interface FsNode {
  path: string
  name: string
  kind: NodeKind
  /** Text payload for `text` nodes. */
  content?: string
  /** Which app a `app` node launches. */
  appId?: string
  modified: number
}

const STORAGE_KEY = 'beanweb.fs.v1'

export const dirname = (path: string): string => {
  if (path === '/') return '/'
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export const basename = (path: string): string => {
  if (path === '/') return '/'
  return path.slice(path.lastIndexOf('/') + 1)
}

export const joinPath = (dir: string, name: string): string =>
  dir === '/' ? `/${name}` : `${dir}/${name}`

/** Resolve `.` and `..` against a working directory. */
export function resolvePath(cwd: string, input: string): string {
  const raw = input.startsWith('/') ? input : `${cwd}/${input}`
  const out: string[] = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`.replace(/\/+$/, '') || '/'
}

function dir(path: string): FsNode {
  return { path, name: basename(path), kind: 'dir', modified: Date.now() }
}

function file(path: string, content: string): FsNode {
  return { path, name: basename(path), kind: 'text', content, modified: Date.now() }
}

function app(path: string, appId: string): FsNode {
  return { path, name: basename(path), kind: 'app', appId, modified: Date.now() }
}

const README = `Welcome to BeanWeb.

This is a browser-resident tribute to the BeOS R5 desktop: the yellow
window tabs, the grey bevels, the Deskbar in the top-right corner.

Things worth trying:

  * Drag a window by its yellow tab.
  * Drag a tab sideways -- R5 lets tabs slide along the window's top edge.
  * Grab the hatched corner at the bottom right to resize.
  * Open a Terminal and run 'help'.
  * Everything you save here survives a reload; it lives in localStorage.

The filesystem, the shell and the clock all run in your tab -- there is
no backend. The one exception is the Claude app, which calls the Anthropic
API using a key you supply. That key is stored in this browser only.
`

const HAIKU = `The Web site you seek
cannot be located, but
countless more exist.

        -- NetPositive, on a 404
`

const TIPS = `Keyboard
--------
  Alt+W          close the active window
  Alt+Tab        cycle windows
  Escape         dismiss an open menu or alert

Terminal
--------
  ls, cd, cat, pwd, mkdir, touch, rm, echo, edit,
  open, clear, date, uname, help
`

const HELLO_BAS = `10 REM The traditional first program
20 PRINT "HELLO, WORLD"
30 FOR I = 1 TO 5
40 PRINT I; "SQUARED IS"; I * I
50 NEXT I
60 END
`

const GUESS_BAS = `10 REM Higher or lower. Press Stop to give up.
20 LET N = 42
30 LET T = 0
40 INPUT "GUESS 1 TO 100"; G
50 LET T = T + 1
60 IF G < N THEN PRINT "HIGHER" : GOTO 40
70 IF G > N THEN PRINT "LOWER" : GOTO 40
80 PRINT "GOT IT IN"; T; "TRIES"
90 END
`

const STARS_BAS = `' A starfield, to show the screen window off.
' Graphics open a window of their own; press a key to stop.
SCREEN 13
RANDOMIZE TIMER

CONST COUNT = 120
DIM x(COUNT), y(COUNT), speed(COUNT)

FOR i = 1 TO COUNT
  x(i) = RND * 319
  y(i) = RND * 199
  speed(i) = 1 + INT(RND * 3)
NEXT i

DO
  FOR i = 1 TO COUNT
    PRESET (x(i), y(i))
    x(i) = x(i) - speed(i)
    IF x(i) < 0 THEN
      x(i) = 319
      y(i) = RND * 199
    END IF
    PSET (x(i), y(i)), 16 + speed(i) * 5
  NEXT i
LOOP UNTIL INKEY$ <> ""

SCREEN 0
PRINT "Goodbye."
`

const SUNSET_BAS = `' Every graphics statement this BASIC knows, in one picture.
SCREEN 13

' Sky: one filled line per row, walking up the palette.
FOR i = 0 TO 199
  LINE (0, i)-(319, i), 17 + INT(i / 10)
NEXT i

' Sun, drawn as an outline and then flooded.
CIRCLE (160, 90), 40, 44
PAINT (160, 90), 44, 44

' Rays: an arc apiece, stepping round the circle.
FOR a = 0 TO 5
  CIRCLE (160, 90), 55, 44, a * 1.05, a * 1.05 + .4
NEXT a

' Sea, and a boat drawn with the macro language.
LINE (0, 150)-(319, 199), 1, BF
DRAW "C15 BM130,150 R60 G10 L40 H10"
DRAW "C15 BM160,150 U25 F25"

LOCATE 24, 10
COLOR 15
PRINT "BEANWEB QBASIC";
`

function seed(): Record<string, FsNode> {
  const nodes: FsNode[] = [
    dir('/'),
    dir('/boot'),
    dir('/boot/home'),
    dir('/boot/home/Desktop'),
    dir('/boot/home/config'),
    dir('/boot/home/documents'),
    dir('/boot/home/basic'),
    dir('/boot/apps'),
    dir('/boot/system'),

    file('/boot/home/readme.txt', README),
    file('/boot/home/documents/haiku.txt', HAIKU),
    file('/boot/home/documents/tips.txt', TIPS),
    file(
      '/boot/home/documents/todo.txt',
      'Replicants\nWorkspaces (3x3)\nPulse\nDeskCalc\nNetPositive\n',
    ),
    file(
      '/boot/system/version',
      'BeanWeb 0.1.0\nkernel: javascript\nabi: dom\n',
    ),

    file('/boot/home/basic/hello.bas', HELLO_BAS),
    file('/boot/home/basic/guess.bas', GUESS_BAS),
    file('/boot/home/basic/sunset.bas', SUNSET_BAS),
    file('/boot/home/basic/stars.bas', STARS_BAS),

    app('/boot/apps/Tracker', 'tracker'),
    app('/boot/apps/Terminal', 'terminal'),
    app('/boot/apps/StyledEdit', 'styledit'),
    app('/boot/apps/Tetris', 'tetris'),
    app('/boot/apps/BASIC', 'basic'),
    app('/boot/apps/Claude', 'claude'),
  ]
  return Object.fromEntries(nodes.map((n) => [n.path, n]))
}

function load(): Record<string, FsNode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return seed()
    const parsed = JSON.parse(raw) as Record<string, FsNode>
    // A missing root means the payload is not one of ours; start clean.
    if (!parsed['/']) return seed()
    return parsed
  } catch {
    return seed()
  }
}

let saveTimer: number | undefined
function persist(nodes: Record<string, FsNode>) {
  clearTimeout(saveTimer)
  // Coalesce bursts of edits (e.g. a text editor autosaving) into one write.
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes))
    } catch {
      /* Quota or private-mode failure: the session still works in memory. */
    }
  }, 250) as unknown as number
}

interface FsStore {
  nodes: Record<string, FsNode>
  list: (path: string) => FsNode[]
  read: (path: string) => string | undefined
  write: (path: string, content: string) => void
  mkdir: (path: string) => boolean
  remove: (path: string) => boolean
  rename: (path: string, name: string) => boolean
  exists: (path: string) => boolean
  reset: () => void
}

export const useFs = create<FsStore>((set, get) => ({
  nodes: load(),

  list: (path) => {
    const nodes = get().nodes
    return Object.values(nodes)
      .filter((n) => n.path !== '/' && dirname(n.path) === path)
      .sort((a, b) => {
        // Directories first, then case-insensitive by name -- Tracker's order.
        if (a.kind === 'dir' && b.kind !== 'dir') return -1
        if (b.kind === 'dir' && a.kind !== 'dir') return 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
  },

  read: (path) => get().nodes[path]?.content,

  write: (path, content) =>
    set((s) => {
      const existing = s.nodes[path]
      const node: FsNode = existing
        ? { ...existing, content, modified: Date.now() }
        : { path, name: basename(path), kind: 'text', content, modified: Date.now() }
      const nodes = { ...s.nodes, [path]: node }
      persist(nodes)
      return { nodes }
    }),

  mkdir: (path) => {
    if (get().nodes[path]) return false
    set((s) => {
      const nodes = { ...s.nodes, [path]: dir(path) }
      persist(nodes)
      return { nodes }
    })
    return true
  },

  remove: (path) => {
    if (path === '/' || !get().nodes[path]) return false
    set((s) => {
      const nodes = { ...s.nodes }
      // Removing a directory takes its whole subtree with it.
      const prefix = path === '/' ? '/' : `${path}/`
      for (const key of Object.keys(nodes)) {
        if (key === path || key.startsWith(prefix)) delete nodes[key]
      }
      persist(nodes)
      return { nodes }
    })
    return true
  },

  rename: (path, name) => {
    const node = get().nodes[path]
    if (!node || !name || name.includes('/')) return false
    const target = joinPath(dirname(path), name)
    if (get().nodes[target]) return false
    set((s) => {
      const nodes = { ...s.nodes }
      const prefix = `${path}/`
      for (const key of Object.keys(nodes)) {
        if (key === path) {
          nodes[target] = { ...nodes[key], path: target, name }
          delete nodes[key]
        } else if (key.startsWith(prefix)) {
          const moved = target + key.slice(path.length)
          nodes[moved] = { ...nodes[key], path: moved }
          delete nodes[key]
        }
      }
      persist(nodes)
      return { nodes }
    })
    return true
  },

  exists: (path) => Boolean(get().nodes[path]),

  reset: () => {
    const nodes = seed()
    persist(nodes)
    set({ nodes })
  },
}))
