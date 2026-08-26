import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalIcon } from '@/lib/icons'
import { basename, dirname, resolvePath, useFs } from '@/store/fs'
import { useDesktop } from '@/store/desktop'
import { launchApp, listApps, registerApp } from './registry'
import type { AppProps } from './registry'
import './terminal.css'

interface Line {
  id: number
  text: string
  kind: 'out' | 'echo' | 'err'
}

const FORTUNES = [
  'The Web site you seek cannot be located,\nbut countless more exist.',
  'Chaos reigns within.\nReflect, repent, and reboot.\nOrder shall return.',
  'Three things are certain:\ndeath, taxes, and lost data.\nGuess which has occurred.',
  'Yesterday it worked.\nToday it is not working.\nsoftware is like that.',
]

let lineSeq = 0

export function Terminal({ windowId, args }: AppProps) {
  const [cwd, setCwd] = useState(args?.cwd ?? '/boot/home')
  const [lines, setLines] = useState<Line[]>(() => [
    { id: ++lineSeq, kind: 'out', text: 'BeanWeb Terminal — type `help` for a list of commands.' },
    { id: ++lineSeq, kind: 'out', text: '' },
  ])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIndex, setHistIndex] = useState(-1)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const fs = useFs

  const emit = useCallback((text: string, kind: Line['kind'] = 'out') => {
    setLines((prev) => [...prev, { id: ++lineSeq, kind, text }])
  }, [])

  // Keep the newest output in view after every append.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // A terminal you have to click into before it accepts keys is broken. Grab
  // focus on open and whenever this window becomes the active one again.
  const isActive = useDesktop((s) => s.activeId === windowId)
  useEffect(() => {
    if (isActive) inputRef.current?.focus()
  }, [isActive])

  const focusInput = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    if (target === inputRef.current) return
    // Clicking output text should place a selection, not steal the caret.
    if (target.closest('.term-line')) return
    // preventDefault matters more than the focus() call: without it the
    // browser's default mousedown action moves focus to the body immediately
    // after we set it, which is why clicking the black area appeared dead.
    e.preventDefault()
    inputRef.current?.focus()
  }, [])

  const run = useCallback(
    (raw: string) => {
      const trimmed = raw.trim()
      emit(`${cwd}> ${trimmed}`, 'echo')
      if (!trimmed) return

      const [cmd, ...rest] = trimmed.split(/\s+/)
      const arg = rest.join(' ')
      const state = fs.getState()

      switch (cmd) {
        case 'help':
          emit(
            [
              'ls [dir]        list a directory',
              'cd <dir>        change directory',
              'pwd             print working directory',
              'cat <file>      print a file',
              'edit <file>     open a file in StyledEdit',
              'basic <file>    open a program in BASIC',
              'open <app>      launch an application',
              'mkdir <dir>     create a directory',
              'touch <file>    create an empty file',
              'rm <path>       remove a file or directory',
              'echo <text>     print text',
              'tree            show the tree below here',
              'apps            list installed applications',
              'date            print the current date',
              'uname           print system information',
              'fortune         print a haiku',
              'clear           clear the screen',
            ].join('\n'),
          )
          break

        case 'ls': {
          const target = arg ? resolvePath(cwd, arg) : cwd
          const node = state.nodes[target]
          if (!node) return emit(`ls: ${arg || target}: no such file or directory`, 'err')
          if (node.kind !== 'dir') return emit(node.name)
          const items = state.list(target)
          if (!items.length) return emit('(empty)')
          emit(items.map((n) => (n.kind === 'dir' ? `${n.name}/` : n.name)).join('\n'))
          break
        }

        case 'cd': {
          const target = arg ? resolvePath(cwd, arg) : '/boot/home'
          const node = state.nodes[target]
          if (!node) return emit(`cd: ${arg}: no such file or directory`, 'err')
          if (node.kind !== 'dir') return emit(`cd: ${arg}: not a directory`, 'err')
          setCwd(target)
          break
        }

        case 'pwd':
          emit(cwd)
          break

        case 'cat': {
          if (!arg) return emit('cat: missing operand', 'err')
          const target = resolvePath(cwd, arg)
          const node = state.nodes[target]
          if (!node) return emit(`cat: ${arg}: no such file or directory`, 'err')
          if (node.kind === 'dir') return emit(`cat: ${arg}: is a directory`, 'err')
          emit(node.content ?? '')
          break
        }

        case 'edit': {
          if (!arg) return emit('edit: missing operand', 'err')
          const target = resolvePath(cwd, arg)
          if (state.nodes[target]?.kind === 'dir') return emit(`edit: ${arg}: is a directory`, 'err')
          if (!state.nodes[target]) state.write(target, '')
          launchApp('styledit', { path: target }, basename(target))
          break
        }

        case 'basic': {
          if (!arg) return emit('basic: missing operand', 'err')
          const target = resolvePath(cwd, arg)
          if (state.nodes[target]?.kind === 'dir') return emit(`basic: ${arg}: is a directory`, 'err')
          if (!state.nodes[target]) state.write(target, '')
          launchApp('basic', { path: target }, basename(target))
          break
        }

        case 'open': {
          if (!arg) return emit('open: missing operand', 'err')
          const app = listApps().find((a) => a.id === arg.toLowerCase() || a.name.toLowerCase() === arg.toLowerCase())
          if (!app) return emit(`open: ${arg}: no such application`, 'err')
          launchApp(app.id)
          break
        }

        case 'apps':
          emit(listApps().map((a) => `${a.id.padEnd(12)} ${a.name}`).join('\n'))
          break

        case 'mkdir': {
          if (!arg) return emit('mkdir: missing operand', 'err')
          const target = resolvePath(cwd, arg)
          if (!state.nodes[dirname(target)]) return emit(`mkdir: ${arg}: no such parent`, 'err')
          if (!state.mkdir(target)) return emit(`mkdir: ${arg}: already exists`, 'err')
          break
        }

        case 'touch': {
          if (!arg) return emit('touch: missing operand', 'err')
          const target = resolvePath(cwd, arg)
          if (!state.nodes[dirname(target)]) return emit(`touch: ${arg}: no such parent`, 'err')
          if (!state.nodes[target]) state.write(target, '')
          break
        }

        case 'rm': {
          if (!arg) return emit('rm: missing operand', 'err')
          const target = resolvePath(cwd, arg)
          if (!state.remove(target)) return emit(`rm: ${arg}: no such file or directory`, 'err')
          break
        }

        case 'echo':
          emit(arg)
          break

        case 'tree': {
          const walk = (dir: string, depth: number): string[] => {
            if (depth > 3) return []
            return state.list(dir).flatMap((n) => [
              `${'  '.repeat(depth)}${n.kind === 'dir' ? '+ ' : '- '}${n.name}`,
              ...(n.kind === 'dir' ? walk(n.path, depth + 1) : []),
            ])
          }
          const out = walk(cwd, 0)
          emit(out.length ? out.join('\n') : '(empty)')
          break
        }

        case 'date':
          emit(new Date().toString())
          break

        case 'uname':
          emit('BeanWeb 0.1.0 (javascript) dom')
          break

        case 'whoami':
          emit('baron')
          break

        case 'fortune':
          emit(FORTUNES[Math.floor(Math.random() * FORTUNES.length)])
          break

        case 'clear':
          setLines([])
          break

        default:
          emit(`${cmd}: command not found`, 'err')
      }
    },
    [cwd, emit, fs],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        // A command that opens a window hands focus to it inside this very
        // dispatch, and the browser then performs Enter's default action
        // against whatever now holds focus -- typing a newline into the app
        // just launched. `basic <file>` used to land one in the editor, whose
        // onChange then overwrote the file it had just loaded. Same family as
        // the click-to-focus rule: the default action has to be cancelled.
        e.preventDefault()
        run(input)
        if (input.trim()) setHistory((h) => [...h, input])
        setInput('')
        setHistIndex(-1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!history.length) return
        const next = histIndex < 0 ? history.length - 1 : Math.max(0, histIndex - 1)
        setHistIndex(next)
        setInput(history[next])
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (histIndex < 0) return
        const next = histIndex + 1
        if (next >= history.length) {
          setHistIndex(-1)
          setInput('')
        } else {
          setHistIndex(next)
          setInput(history[next])
        }
      }
    },
    [histIndex, history, input, run],
  )

  return (
    <div className="term" onPointerDown={focusInput}>
      <div className="term-scroll b-scroll" ref={scrollRef}>
        {lines.map((line) => (
          <pre key={line.id} className={`term-line term-line--${line.kind} selectable`}>
            {line.text}
          </pre>
        ))}
        <div className="term-prompt">
          <span className="term-cwd">{cwd}&gt;</span>
          <input
            ref={inputRef}
            className="term-input"
            value={input}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Terminal input"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
    </div>
  )
}

registerApp({
  id: 'terminal',
  name: 'Terminal',
  component: Terminal,
  icon: TerminalIcon,
  defaultW: 540,
  defaultH: 340,
  minW: 280,
  minH: 160,
})
