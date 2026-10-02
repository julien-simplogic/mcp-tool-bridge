import { cloneJson, deepFreeze, isJsonObject } from './json.js'
import type { JsonValue, ToolResult } from './types.js'

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
