/**
 * The interpreter's only route to the outside world.
 *
 * Everything impure goes through here, which is what lets the whole runtime be
 * tested with no DOM: pass `recordingHost()` and assert on the call log.
 */
export interface Host {
  /** Write text. The interpreter emits newlines explicitly, never implicitly. */
  print(text: string): void
  /** Clear the console. */
  cls(): void
  /**
   * The program has started drawing. The app opens its screen window here —
   * called once per run, and again whenever SCREEN changes mode, rather than
   * on every pixel.
   */
  show(): void
  /**
   * The next keystroke waiting, or "" if none. INKEY$ reads it, and so does a
   * bare SLEEP, which waits for one.
   */
  inkey(): string
}

export interface HostCall {
  call: 'print' | 'cls' | 'show'
  text?: string
}

export interface RecordingHost extends Host {
  calls: HostCall[]
  /** Everything printed, joined — the usual thing a test wants to assert on. */
  output(): string
  /** Queue a keystroke for INKEY$ to find. */
  press(key: string): void
}

export function recordingHost(): RecordingHost {
  const calls: HostCall[] = []
  const keys: string[] = []
  return {
    calls,
    print: (text) => calls.push({ call: 'print', text }),
    cls: () => calls.push({ call: 'cls' }),
    show: () => calls.push({ call: 'show' }),
    inkey: () => keys.shift() ?? '',
    press: (key) => {
      keys.push(key)
    },
    output: () =>
      calls
        .filter((c) => c.call === 'print')
        .map((c) => c.text ?? '')
        .join(''),
  }
}
