import type Anthropic from '@anthropic-ai/sdk'

/**
 * Model catalogue.
 *
 * The Models API reports id, display name, context window, output cap and
 * capabilities — but *not* price. Pricing therefore comes from the table below,
 * which is a cached snapshot and can drift; models missing from it still work,
 * they just sort last.
 *
 * Price is never shown in the app. It exists to order the picker cheapest
 * first and to pin `DEFAULT_MODEL`, which is why a stale rate is a cosmetic
 * problem here and not a lie told to the user.
 */

export interface Price {
  /** USD per million input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
}

/** Cached 2026-06-24. Anthropic first-party rates. */
export const PRICES: Record<string, Price> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Sonnet 5 has promotional pricing of $2/$10 through 2026-08-31; the standard
  // rate is used here so the ordering does not silently change when it lapses.
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
}

/**
 * The cheapest model we have a price for. Deliberately a constant rather than
 * "whatever sorts first": the live list may include models we hold no price
 * for, and the default must not shift under us.
 */
export const DEFAULT_MODEL = 'claude-haiku-4-5'

export interface ModelOption {
  id: string
  name: string
  price?: Price
  /** Output cap; null when the API did not report one. */
  maxTokens: number | null
  /** Context window. */
  maxInputTokens: number | null
  /** Whether `thinking: { type: 'adaptive' }` is accepted. */
  adaptiveThinking: boolean
}

/**
 * Used before a key exists and if the poll fails, so the picker is never empty.
 * Capabilities here are conservative: adaptive thinking is claimed only for the
 * families that shipped it, and gets corrected by the live poll.
 */
export const FALLBACK_MODELS: ModelOption[] = [
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-opus-5',
].map((id) => ({
  id,
  name: id,
  price: PRICES[id],
  maxTokens: null,
  maxInputTokens: null,
  adaptiveThinking: id !== 'claude-haiku-4-5',
}))

export function toOption(info: Anthropic.ModelInfo): ModelOption {
  return {
    id: info.id,
    name: info.display_name || info.id,
    price: PRICES[info.id],
    maxTokens: info.max_tokens,
    maxInputTokens: info.max_input_tokens,
    // Read support from the API rather than inferring it from the model name:
    // Haiku 4.5 predates adaptive thinking and 400s if it is sent.
    adaptiveThinking: info.capabilities?.thinking?.types?.adaptive?.supported ?? false,
  }
}

/** Cheapest first; models with no known price sort last, then by name. */
export function sortByPrice(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    if (a.price && b.price) {
      return a.price.input - b.price.input || a.price.output - b.price.output
    }
    if (a.price) return -1
    if (b.price) return 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Per-model request shaping. Sending `thinking` to a model that does not accept
 * adaptive, or a `max_tokens` above its cap, is a 400 — so both are derived from
 * the model rather than hard-coded.
 */
export function requestShape(model: ModelOption | undefined, desiredMaxTokens: number) {
  const cap = model?.maxTokens ?? desiredMaxTokens
  const shape: {
    max_tokens: number
    thinking?: { type: 'adaptive' }
  } = { max_tokens: Math.min(desiredMaxTokens, cap) }

  if (model?.adaptiveThinking) shape.thinking = { type: 'adaptive' }
  return shape
}
