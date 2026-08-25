import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { AuthenticationError, RateLimitError } from '@anthropic-ai/sdk'
import { Claude } from '@/apps/Claude'
import { Alerts } from '@/shell/Alerts'
import { KeyPanel } from '@/shell/KeyPanel'
import { useDesktop } from '@/store/desktop'
import { useSettings } from '@/store/settings'

/**
 * The SDK is mocked so no test can reach the network. The real error classes
 * are kept as statics on the mock constructor, so the component's
 * `instanceof Anthropic.AuthenticationError` branches still work.
 */

const construct = vi.fn()
const streamFn = vi.fn()
const listFn = vi.fn()

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  function MockAnthropic(this: unknown, opts: unknown) {
    construct(opts)
    return { messages: { stream: streamFn }, models: { list: listFn } }
  }
  // Object.assign alone does not reliably carry the static error classes, so
  // copy the ones the component branches on explicitly.
  Object.assign(MockAnthropic, actual.default, {
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
    AuthenticationError: actual.AuthenticationError,
    RateLimitError: actual.RateLimitError,
  })
  return { ...actual, default: MockAnthropic }
})

/** A controllable stand-in for client.messages.stream(). */
function makeStream() {
  const handlers: Record<string, (t: string) => void> = {}
  const controller = { abort: vi.fn() }
  let settle!: (m: unknown) => void
  let reject!: (e: unknown) => void
  const final = new Promise<unknown>((res, rej) => {
    settle = res
    reject = rej
  })
  const stream = {
    on(event: string, cb: (t: string) => void) {
      handlers[event] = cb
      return stream
    },
    finalMessage: () => final,
    controller,
  }
  return {
    stream,
    emit: (t: string) => handlers.text?.(t),
    finish: (text: string) =>
      settle({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 11, output_tokens: 22 },
      }),
    fail: (err: unknown) => reject(err),
    controller,
  }
}

/** models.list() returns an auto-paginating async iterable. */
function modelPage(models: unknown[]) {
  return { async *[Symbol.asyncIterator]() { for (const m of models) yield m } }
}

const modelInfo = (
  id: string,
  opts: { adaptive?: boolean; maxTokens?: number | null; name?: string } = {},
) => ({
  type: 'model',
  id,
  display_name: opts.name ?? id,
  created_at: '2026-01-01T00:00:00Z',
  max_input_tokens: 200000,
  max_tokens: opts.maxTokens ?? 64000,
  capabilities: {
    thinking: { supported: true, types: { adaptive: { supported: opts.adaptive ?? false }, enabled: { supported: true } } },
  },
})

/** Build a real SDK error without needing its constructor signature. */
function sdkError<T>(Cls: new (...args: never[]) => T, fields: Record<string, unknown>): T {
  return Object.assign(Object.create(Cls.prototype) as object, fields) as T
}

function mount() {
  const id = useDesktop.getState().openWindow({ appId: 'claude', title: 'Claude' })
  const view = render(
    <>
      <Claude windowId={id} />
      <KeyPanel />
      <Alerts />
    </>,
  )
  return { id, ...view }
}

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const composer = () => $<HTMLTextAreaElement>('.claude-input')!
const button = (label: string) =>
  $$<HTMLButtonElement>('.claude button').find((b) => b.textContent === label)!
const turns = () =>
  $$('.claude-turn').map((n) => ({
    role: n.getAttribute('data-role'),
    text: n.querySelector('.claude-text')?.textContent ?? '',
  }))
const alertText = () => $('.b-alert-text')?.textContent ?? null
const alertButton = (label: string) =>
  $$<HTMLButtonElement>('.b-alert-buttons .b-button').find((b) => b.textContent === label)!

const type = (text: string) => fireEvent.change(composer(), { target: { value: text } })
const send = () => fireEvent.click(button('Send'))

beforeEach(() => {
  construct.mockClear()
  streamFn.mockReset()
  listFn.mockReset()
  listFn.mockReturnValue(modelPage([]))
})

describe('Claude chat', () => {
  it('shows a hint and no client until a key exists', () => {
    mount()
    expect($('.claude-empty')?.textContent).toContain('No API key set')
    expect(construct).not.toHaveBeenCalled()
  })

  it('asks for a key instead of sending when none is set', async () => {
    mount()
    type('hello')
    send()
    await waitFor(() => expect($('.keypanel')).toBeTruthy())
    // Nothing was sent and no client was built.
    expect(streamFn).not.toHaveBeenCalled()
    expect(construct).not.toHaveBeenCalled()
    expect(turns()).toHaveLength(0)
  })

  it('stores a key entered in the panel', async () => {
    mount()
    type('hello')
    send()
    await waitFor(() => expect($('.keypanel')).toBeTruthy())

    fireEvent.change($('#keypanel-input')!, { target: { value: 'sk-ant-test-key' } })
    fireEvent.click($$<HTMLButtonElement>('.keypanel .b-button').find((b) => b.textContent === 'Save')!)
    await waitFor(() => expect($('.keypanel')).toBeNull())
    expect(useSettings.getState().apiKey).toBe('sk-ant-test-key')
  })

  it('never renders the key in full', async () => {
    useSettings.setState({ apiKey: 'sk-ant-abcdefghijklmnop' })
    mount()
    const status = $('.claude-status')?.textContent ?? ''
    expect(status).not.toContain('abcdefghijklmnop')
    expect(status).toContain('…')
  })

  describe('with a key set', () => {
    beforeEach(() => useSettings.setState({ apiKey: 'sk-ant-test' }))

    it('streams a reply and records usage', async () => {
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      type('hi there')
      send()

      await waitFor(() => expect(streamFn).toHaveBeenCalled())
      expect(construct).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk-ant-test', dangerouslyAllowBrowser: true }),
      )
      expect(streamFn.mock.calls[0][0]).toMatchObject({
        model: 'claude-haiku-4-5', // the cheapest, and the default
        messages: [{ role: 'user', content: 'hi there' }],
      })

      s.emit('Hel')
      s.emit('lo.')
      await waitFor(() => expect(turns()[1].text).toContain('Hello.'))

      s.finish('Hello.')
      await waitFor(() => expect($('.claude-status')?.textContent).toContain('11 in / 22 out'))
      expect(turns()).toEqual([
        { role: 'user', text: 'hi there' },
        { role: 'assistant', text: 'Hello.' },
      ])
    })

    it('resends the whole history on the next turn', async () => {
      const first = makeStream()
      streamFn.mockReturnValueOnce(first.stream)
      mount()
      type('one')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalledTimes(1))
      first.finish('first reply')
      await waitFor(() => expect(turns()[1].text).toBe('first reply'))

      const second = makeStream()
      streamFn.mockReturnValueOnce(second.stream)
      type('two')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalledTimes(2))

      // The API is stateless: turn two must carry all three messages.
      expect(streamFn.mock.calls[1][0].messages).toEqual([
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'two' },
      ])
    })

    it('swaps Send for Stop while streaming and aborts on click', async () => {
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      type('long one')
      send()

      await waitFor(() => expect(button('Stop')).toBeTruthy())
      s.emit('partial text')
      await waitFor(() => expect(turns()[1].text).toContain('partial text'))

      fireEvent.click(button('Stop'))
      expect(s.controller.abort).toHaveBeenCalled()

      // Aborting is a normal outcome: the partial reply survives.
      s.fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      await waitFor(() => expect(button('Send')).toBeTruthy())
      expect(turns()[1].text).toContain('partial text')
      expect(alertText()).toBeNull()
    })

    it('reports a rejected key through an alert and drops the failed turn', async () => {
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      type('hi')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalled())

      s.fail(sdkError(AuthenticationError, { status: 401, message: 'bad key' }))
      await waitFor(() => expect(alertText()).toContain('401'))
      expect(alertText()).toContain('key')

      fireEvent.click(alertButton('OK'))
      await waitFor(() => expect($('.b-alert')).toBeNull())
      // The whole exchange rolls back and the text returns to the composer,
      // so the transcript and the resent history cannot disagree.
      expect(turns()).toHaveLength(0)
      expect(composer().value).toBe('hi')
    })

    it('reports rate limiting distinctly from auth failure', async () => {
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      type('hi')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalled())

      s.fail(sdkError(RateLimitError, { status: 429, message: 'slow down' }))
      await waitFor(() => expect(alertText()).toContain('429'))
      expect(alertText()).not.toContain('401')
    })

    it('clears the transcript on New conversation', async () => {
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      type('hi')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalled())
      s.finish('reply')
      await waitFor(() => expect(turns()).toHaveLength(2))

      fireEvent.pointerDown(
        $$('.claude .b-menubar-item').find((n) => n.textContent === 'Chat')!,
        { button: 0 },
      )
      await waitFor(() => expect($('.b-menu')).toBeTruthy())
      fireEvent.click($$('.b-menu-item').find((n) => n.textContent?.includes('New conversation'))!)
      await waitFor(() => expect(turns()).toHaveLength(0))
    })

    it('closes without a prompt when idle', async () => {
      const { id } = mount()
      await useDesktop.getState().requestClose(id)
      expect(useDesktop.getState().windows[id]).toBeUndefined()
      expect($('.b-alert')).toBeNull()
    })

    it('guards the close while a reply is in flight', async () => {
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      const { id } = mount()
      type('hi')
      send()
      await waitFor(() => expect(button('Stop')).toBeTruthy())

      void useDesktop.getState().requestClose(id)
      await waitFor(() => expect(alertText()).toContain('still streaming'))
      fireEvent.click(alertButton('Cancel'))
      await waitFor(() => expect($('.b-alert')).toBeNull())
      expect(useDesktop.getState().windows[id]).toBeDefined()
    })
  })

  describe('model selection', () => {
    const openModelMenu = async () => {
      fireEvent.pointerDown(
        $$('.claude .b-menubar-item').find((n) => n.textContent === 'Model')!,
        { button: 0 },
      )
      await waitFor(() => expect($('.b-menu')).toBeTruthy())
      return $$('.b-menu-item').map((n) => n.textContent?.replace('•', '').trim() ?? '')
    }

    it('defaults to the cheapest model', () => {
      expect(useSettings.getState().model).toBe('claude-haiku-4-5')
      mount()
      expect($('.claude-status')?.textContent).toContain('claude-haiku-4-5')
    })

    it('lists fallback models cheapest first before any poll', async () => {
      mount()
      const items = await openModelMenu()
      const priced = items.filter((t) => t.includes('per Mtok'))
      expect(priced[0]).toContain('claude-haiku-4-5')
      expect(priced[0]).toContain('$1/$5')
      expect(priced.at(-1)).toContain('claude-opus-5')
    })

    it('polls the API once a key is present and shows what came back', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test' })
      listFn.mockReturnValue(
        modelPage([
          modelInfo('claude-opus-5', { adaptive: true, name: 'Claude Opus 5' }),
          modelInfo('claude-haiku-4-5', { name: 'Claude Haiku 4.5' }),
        ]),
      )
      mount()
      await waitFor(() => expect(listFn).toHaveBeenCalled())

      const items = await openModelMenu()
      const priced = items.filter((t) => t.includes('per Mtok'))
      // Sorted by price, and using the API's display names.
      expect(priced[0]).toContain('Claude Haiku 4.5')
      expect(priced[1]).toContain('Claude Opus 5')
    })

    it('polls once per key, not in a loop', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test' })
      listFn.mockReturnValue(modelPage([modelInfo('claude-haiku-4-5')]))
      mount()
      await waitFor(() => expect(listFn).toHaveBeenCalled())
      // Setting state the poll itself owns must not re-trigger the effect.
      await new Promise((r) => setTimeout(r, 120))
      expect(listFn).toHaveBeenCalledTimes(1)
    })

    it('keeps the fallback list when the poll fails', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test' })
      listFn.mockImplementation(() => {
        throw sdkError(AuthenticationError, { status: 401, message: 'nope' })
      })
      mount()
      await waitFor(() => expect(listFn).toHaveBeenCalled())
      // A background poll must not raise an alert or empty the picker.
      expect(alertText()).toBeNull()
      const items = await openModelMenu()
      expect(items.filter((t) => t.includes('per Mtok')).length).toBeGreaterThan(0)
    })

    it('switches model and persists the choice', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test' })
      mount()
      const items = await openModelMenu()
      const index = items.findIndex((t) => t.includes('claude-opus-5'))
      fireEvent.click($$('.b-menu-item')[index])
      await waitFor(() => expect(useSettings.getState().model).toBe('claude-opus-5'))
      expect($('.claude-status')?.textContent).toContain('claude-opus-5')
    })

    it('sends the selected model, not the default', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test', model: 'claude-opus-5' })
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      type('hi')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalled())
      expect(streamFn.mock.calls[0][0].model).toBe('claude-opus-5')
    })

    it('omits thinking for a model that does not support adaptive', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test', model: 'claude-haiku-4-5' })
      listFn.mockReturnValue(modelPage([modelInfo('claude-haiku-4-5', { adaptive: false })]))
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      await waitFor(() => expect(listFn).toHaveBeenCalled())
      type('hi')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalled())
      // Sending adaptive thinking to Haiku 4.5 is a 400.
      expect(streamFn.mock.calls[0][0]).not.toHaveProperty('thinking')
    })

    it('sends adaptive thinking for a model that supports it', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test', model: 'claude-opus-5' })
      listFn.mockReturnValue(modelPage([modelInfo('claude-opus-5', { adaptive: true })]))
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      await waitFor(() => expect(listFn).toHaveBeenCalled())
      type('hi')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalled())
      expect(streamFn.mock.calls[0][0].thinking).toEqual({ type: 'adaptive' })
    })

    it('clamps max_tokens to the model cap the API reported', async () => {
      useSettings.setState({ apiKey: 'sk-ant-test', model: 'claude-haiku-4-5' })
      listFn.mockReturnValue(modelPage([modelInfo('claude-haiku-4-5', { maxTokens: 8192 })]))
      const s = makeStream()
      streamFn.mockReturnValue(s.stream)
      mount()
      await waitFor(() => expect(listFn).toHaveBeenCalled())
      type('hi')
      send()
      await waitFor(() => expect(streamFn).toHaveBeenCalled())
      expect(streamFn.mock.calls[0][0].max_tokens).toBe(8192)
    })
  })
})
