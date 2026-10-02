import { cloneJson, deepFreeze, isJsonObject } from './json.js'
import type { ContentBlock, JsonValue, ToolResult } from './types.js'

/** A result made of a single text block. */
export function text(value: string): ToolResult {
  return Object.freeze({ content: Object.freeze([Object.freeze({ type: 'text', text: value })]) })
}

/**
 * A result carrying JSON. Objects also go into `structuredContent`, which
 * MCP reserves for objects; every value is serialized as text too, for
 * clients that only read `content`.
 */
export function json(value: JsonValue): ToolResult {
  const copy = cloneJson(value)
  if (!copy.ok) throw new TypeError('json(): value is not plain JSON data')
  const frozen = deepFreeze(copy.value)
  const content = Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(frozen) })])
  return isJsonObject(frozen)
    ? Object.freeze({ content, structuredContent: frozen })
    : Object.freeze({ content })
}

/**
 * Turns whatever a handler returned into a frozen ToolResult, or `undefined`
 * if it is neither a string nor a well-formed result. Handlers written in
 * JavaScript, or adapted from existing code, can return anything; nothing
 * malformed reaches the client.
 */
export function normalizeOutput(output: unknown): ToolResult | undefined {
  if (typeof output === 'string') return text(output)
  const copy = cloneJson(output)
  if (!copy.ok || !isJsonObject(copy.value)) return undefined
  const { content, structuredContent, isError } = copy.value
  if (!Array.isArray(content)) return undefined
  const blocks: ContentBlock[] = []
  for (const item of content as readonly JsonValue[]) {
    const block = toBlock(item)
    if (!block) return undefined
    blocks.push(block)
  }
  if (structuredContent !== undefined && !isJsonObject(structuredContent)) return undefined
  if (isError !== undefined && typeof isError !== 'boolean') return undefined
  return Object.freeze({
    content: Object.freeze(blocks),
    ...(structuredContent === undefined
      ? {}
      : { structuredContent: deepFreeze(structuredContent) }),
    ...(isError === undefined ? {} : { isError }),
  })
}

function toBlock(item: JsonValue): ContentBlock | undefined {
  if (!isJsonObject(item)) return undefined
  const { type, text: value, data, mimeType } = item
  if (type === 'text')
    return typeof value === 'string' ? Object.freeze({ type, text: value }) : undefined
  if (
    (type === 'image' || type === 'audio') &&
    typeof data === 'string' &&
    typeof mimeType === 'string'
  ) {
    return Object.freeze({ type, data, mimeType })
  }
  return undefined
}
