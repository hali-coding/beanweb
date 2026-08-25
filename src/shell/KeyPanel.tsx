import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, TextControl } from '@/widgets/controls'
import { selectKeyPrompts, useDesktop } from '@/store/desktop'
import { maskKey } from '@/store/settings'
import type { KeyPromptState } from '@/lib/types'

/**
 * API key entry. Deliberately blunt about where the key ends up: BeanWeb has no
 * backend, so the key is stored in this browser and is readable by anything
 * running on the page.
 */
export function KeyPanel() {
  const prompts = useDesktop(selectKeyPrompts)
  const prompt = prompts[prompts.length - 1]
  return prompt ? <KeyPanelBody key={prompt.id} prompt={prompt} /> : null
}

function KeyPanelBody({ prompt }: { prompt: KeyPromptState }) {
  const dismiss = useDesktop((s) => s.dismissKeyPrompt)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const save = useCallback(() => {
    const key = value.trim()
    if (key) dismiss(prompt.id, key)
  }, [dismiss, prompt.id, value])

  const cancel = useCallback(() => dismiss(prompt.id, null), [dismiss, prompt.id])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        save()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    },
    [cancel, save],
  )

  return (
    <div className="b-alert-scrim" onKeyDown={onKeyDown}>
      <div className="keypanel" role="dialog" aria-modal="true" aria-label="Anthropic API key">
        <h2 className="keypanel-title">Anthropic API key</h2>

        <p className="keypanel-note">
          BeanWeb has no server, so your key is kept in this browser only
          (localStorage). Anything running on this page can read it — use a key
          you are willing to rotate, and never publish a build with one set.
        </p>

        <label className="keypanel-field" htmlFor="keypanel-input">
          <span>Key</span>
          <TextControl
            id="keypanel-input"
            ref={inputRef}
            type="password"
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder="sk-ant-..."
            onChange={(e) => setValue(e.target.value)}
          />
        </label>

        <p className="keypanel-current">Currently stored: {maskKey(prompt.current)}</p>

        <div className="keypanel-buttons">
          <Button onClick={cancel}>Cancel</Button>
          <Button isDefault disabled={!value.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
