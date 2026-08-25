import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Anthropic from '@anthropic-ai/sdk'
import { MenuBar } from '@/widgets/Menu'
import type { MenuDef } from '@/widgets/Menu'
import { Button, ScrollView } from '@/widgets/controls'
import { ClaudeIcon } from '@/lib/icons'
import { useDesktop } from '@/store/desktop'
import { maskKey, useSettings } from '@/store/settings'
import {
  FALLBACK_MODELS,
  formatPrice,
  requestShape,
  sortByPrice,
  toOption,
} from '@/lib/models'
import type { ModelOption } from '@/lib/models'
import { useCloseGuard } from '@/lib/closeGuards'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './claude.css'

/** Ceiling we ask for; clamped down to whatever the chosen model allows. */
const DESIRED_MAX_TOKENS = 64000

const SYSTEM_PROMPT =
  'You are Claude, running inside BeanWeb, a browser tribute to the BeOS R5 ' +
  'desktop. Keep replies concise and plain-text; the chat pane is narrow and ' +
  'renders no markdown.'

interface Turn {
  id: number
  role: 'user' | 'assistant'
  text: string
}

let turnSeq = 0
const turn = (role: Turn['role'], text: string): Turn => ({ id: ++turnSeq, role, text })

/** The SDK's message shape; history is resent in full on every request. */
type History = Anthropic.MessageParam[]

export function Claude({ windowId }: AppProps) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [usage, setUsage] = useState<string | null>(null)
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS)
  const [polling, setPolling] = useState(false)

  const apiKey = useSettings((s) => s.apiKey)
  const setApiKey = useSettings((s) => s.setApiKey)
  const clearApiKey = useSettings((s) => s.clearApiKey)
  const model = useSettings((s) => s.model)
  const setModel = useSettings((s) => s.setModel)

  const showAlert = useDesktop((s) => s.showAlert)
  const showKeyPrompt = useDesktop((s) => s.showKeyPrompt)
  const requestClose = useDesktop((s) => s.requestClose)
  const isActive = useDesktop((s) => s.activeId === windowId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const historyRef = useRef<History>([])
  const controllerRef = useRef<AbortController | null>(null)

  /* --- streaming buffer -------------------------------------------------
     Text deltas arrive far faster than 60fps. Accumulate them in a ref and
     flush once per animation frame, the same trick the window manager uses for
     drag: a long reply costs one render per frame, not one per token. */
  const pendingRef = useRef('')
  const frameRef = useRef(0)

  const flush = useCallback(() => {
    frameRef.current = 0
    const text = pendingRef.current
    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, text }]
    })
  }, [])

  const appendDelta = useCallback(
    (delta: string) => {
      pendingRef.current += delta
      if (!frameRef.current) frameRef.current = requestAnimationFrame(flush)
    },
    [flush],
  )

  // Keep the newest text in view.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // A chat box you have to click into is broken; same rule as the Terminal.
  useEffect(() => {
    if (isActive && !streaming) inputRef.current?.focus()
  }, [isActive, streaming])

  const focusInput = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    if (target === inputRef.current) return
    if (target.closest('.claude-turn') || target.closest('button')) return
    // Without preventDefault the browser's default mousedown hands focus back
    // to the body immediately after we set it.
    e.preventDefault()
    inputRef.current?.focus()
  }, [])

  useEffect(
    () => () => {
      // Abandon an in-flight request if the window goes away.
      controllerRef.current?.abort()
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  useCloseGuard(windowId, async () => {
    if (!streaming) return true
    const answer = await showAlert(
      'warn',
      'Claude',
      'A reply is still streaming.\nClose anyway and discard it?',
      ['Cancel', 'Close'],
      0,
    )
    return answer === 1
  })

  /** Ask for a key, store it, and hand it back. Null means the user cancelled. */
  const promptForKey = useCallback(async (): Promise<string | null> => {
    const key = await showKeyPrompt(apiKey)
    if (key) setApiKey(key)
    return key
  }, [apiKey, setApiKey, showKeyPrompt])

  const reportError = useCallback(
    async (err: unknown) => {
      // Typed classes, most specific first -- never string-match messages.
      if (err instanceof Anthropic.AuthenticationError) {
        await showAlert(
          'stop',
          'Claude',
          'The API key was rejected (401).\nCheck it under Settings → Set API key.',
        )
      } else if (err instanceof Anthropic.RateLimitError) {
        await showAlert('warn', 'Claude', 'Rate limited (429).\nWait a moment and try again.')
      } else if (err instanceof Anthropic.APIError) {
        await showAlert('stop', 'Claude', `API error ${err.status}.\n${err.message}`)
      } else {
        await showAlert('stop', 'Claude', String((err as Error)?.message ?? err))
      }
    },
    [showAlert],
  )

  const selected = useMemo(
    () => models.find((m) => m.id === model),
    [models, model],
  )

  /**
   * Ask the API which models this key can actually reach. Failure is not fatal:
   * the fallback list stays in place so the picker always has something.
   */
  const pollModels = useCallback(
    async (key: string, announce = false) => {
      if (!key || polling) return
      setPolling(true)
      try {
        const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true })
        const found: ModelOption[] = []
        // list() auto-paginates.
        for await (const info of client.models.list({ limit: 50 })) {
          found.push(toOption(info))
        }
        if (found.length) setModels(sortByPrice(found))
        if (announce) {
          await showAlert('info', 'Claude', `${found.length} models available to this key.`)
        }
      } catch (err) {
        if (announce) await reportError(err)
      } finally {
        setPolling(false)
      }
    },
    [polling, reportError, showAlert],
  )

  // Refresh the catalogue whenever a key becomes available.
  useEffect(() => {
    if (apiKey) void pollModels(apiKey)
    // pollModels is intentionally omitted: it changes on every poll toggle and
    // would re-fire this effect in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || streaming) return

    let key = apiKey
    if (!key) {
      const entered = await promptForKey()
      if (!entered) return
      key = entered
    }

    setDraft('')
    setTurns((prev) => [...prev, turn('user', text), turn('assistant', '')])
    historyRef.current = [...historyRef.current, { role: 'user', content: text }]
    pendingRef.current = ''
    setStreaming(true)

    try {
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true })
      const stream = client.messages
        .stream({
          model,
          // max_tokens is clamped to the model's cap and `thinking` is only
          // sent when the model accepts adaptive -- both are 400s otherwise.
          ...requestShape(selected, DESIRED_MAX_TOKENS),
          system: SYSTEM_PROMPT,
          messages: historyRef.current,
        })
        .on('text', appendDelta)

      controllerRef.current = stream.controller

      const final = await stream.finalMessage()

      // content is a discriminated union; narrow before reading .text.
      const reply = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      pendingRef.current = reply
      historyRef.current = [...historyRef.current, { role: 'assistant', content: reply }]
      setUsage(`${final.usage.input_tokens} in / ${final.usage.output_tokens} out`)
    } catch (err) {
      // An abort is a normal outcome: keep whatever streamed in.
      const aborted =
        (err as Error)?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError
      if (aborted) {
        historyRef.current = [
          ...historyRef.current,
          { role: 'assistant', content: pendingRef.current || '(stopped)' },
        ]
      } else {
        // Roll the whole exchange back: history already dropped the user
        // message, so the transcript must drop it too or the two disagree.
        // Hand the text back to the composer rather than losing it.
        historyRef.current = historyRef.current.slice(0, -1)
        setTurns((prev) => prev.slice(0, -2))
        setDraft(text)
        await reportError(err)
      }
    } finally {
      controllerRef.current = null
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }
      flush()
      setStreaming(false)
    }
  }, [apiKey, appendDelta, draft, flush, model, promptForKey, reportError, selected, streaming])

  const stop = useCallback(() => controllerRef.current?.abort(), [])

  const newConversation = useCallback(() => {
    controllerRef.current?.abort()
    historyRef.current = []
    pendingRef.current = ''
    setTurns([])
    setUsage(null)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Enter sends, Shift+Enter is a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    },
    [send],
  )

  const menus: MenuDef[] = useMemo(
    () => [
      {
        title: 'Chat',
        items: [
          { label: 'New conversation', onSelect: newConversation },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      {
        title: 'Model',
        items: [
          ...sortByPrice(models).map((m) => ({
            label: `${m.name} — ${formatPrice(m.price)}`,
            checked: m.id === model,
            onSelect: () => setModel(m.id),
          })),
          { separator: true },
          {
            label: polling ? 'Refreshing…' : 'Refresh model list',
            disabled: !apiKey || polling,
            onSelect: () => void pollModels(apiKey, true),
          },
        ],
      },
      {
        title: 'Settings',
        items: [
          { label: 'Set API key…', onSelect: () => void promptForKey() },
          {
            label: 'Clear API key',
            disabled: !apiKey,
            onSelect: clearApiKey,
          },
        ],
      },
    ],
    [
      apiKey,
      clearApiKey,
      model,
      models,
      newConversation,
      polling,
      pollModels,
      promptForKey,
      requestClose,
      setModel,
      windowId,
    ],
  )

  return (
    <div className="claude" onPointerDown={focusInput}>
      <MenuBar menus={menus} />

      <ScrollView className="claude-transcript" ref={scrollRef}>
        {turns.length === 0 ? (
          <p className="claude-empty">
            {apiKey
              ? 'Ask Claude something.'
              : 'No API key set yet — sending your first message will ask for one.'}
          </p>
        ) : (
          turns.map((t) => (
            <div key={t.id} className="claude-turn" data-role={t.role}>
              <span className="claude-who">{t.role === 'user' ? 'You' : 'Claude'}</span>
              <p className="claude-text selectable">
                {t.text}
                {streaming && t.role === 'assistant' && t.id === turns[turns.length - 1]?.id ? (
                  <span className="claude-caret" aria-hidden />
                ) : null}
              </p>
            </div>
          ))
        )}
      </ScrollView>

      <div className="claude-composer">
        <textarea
          ref={inputRef}
          className="claude-input b-scroll selectable"
          value={draft}
          rows={3}
          spellCheck={false}
          placeholder="Message Claude…"
          aria-label="Message"
          disabled={streaming}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <Button onClick={stop}>Stop</Button>
        ) : (
          <Button isDefault disabled={!draft.trim()} onClick={() => void send()}>
            Send
          </Button>
        )}
      </div>

      <div className="claude-status b-fixed">
        <span title={formatPrice(selected?.price)}>{selected?.name ?? model}</span>
        <span className="b-spacer" />
        <span>{usage ?? `key ${maskKey(apiKey)}`}</span>
      </div>
    </div>
  )
}

registerApp({
  id: 'claude',
  name: 'Claude',
  component: Claude,
  icon: ClaudeIcon,
  defaultW: 460,
  defaultH: 520,
  minW: 320,
  minH: 300,
  singleton: true,
})
