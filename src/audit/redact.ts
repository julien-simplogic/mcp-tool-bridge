import { isJsonArray, isJsonObject } from '../json.js'
import type { JsonObject, JsonValue, ToolResult } from '../types.js'
import type { AuditedResult } from './events.js'

export const REDACTED = '[REDACTED]'

/**
 * Keys masked wherever they appear in a kept value, compared without case,
 * `-` or `_`: `apiKey`, `API_KEY` and `x-api-key` all match `apikey`.
 * Matching is by substring (`accessToken`, `client_secret`). A second line of
 * defence: by default the audit keeps no content at all.
 */
const SECRET_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
] as const

/** A kept string longer than this is cut. */
export const MAX_KEPT_STRING = 500
/** A wildcard (`*`), or a kept array, keeps at most this many items. */
export const MAX_KEPT_ITEMS = 100

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[-_]/g, '')
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part))
}

/**
 * The fields of `value` a tool declared it may keep, keyed by their JSON
 * Pointer: `{ "/messageId": "m-1" }`. A `*` segment matches every element of
 * an array or every property of an object; such a pointer keeps its matches
 * as an array. Kept values are copied, masked on secret-looking keys and
 * bounded; nothing else of `value` is referenced. `undefined` when nothing
 * is declared.
 *
 * This runs when the audit event is built: the full value never lives in the
 * event object, so it cannot resurface in an exception trace or a debug dump.
 */
export function keepDeclared(
  value: JsonValue,
  pointers: readonly string[],
): JsonObject | undefined {
  if (pointers.length === 0) return undefined
  const kept: Record<string, JsonValue> = {}
  for (const pointer of pointers) {
    const segments = parsePointer(pointer)
    const last = segments.at(-1)
    const secret = last !== undefined && last !== '*' && isSecretKey(last)
    const matches = resolve(value, segments).slice(0, MAX_KEPT_ITEMS)
    if (matches.length === 0) continue
    const copies = matches.map((match) => (secret ? REDACTED : bound(match)))
    kept[pointer] = segments.includes('*') ? copies : (copies[0] ?? null)
  }
  return kept
}

/** What the audit keeps of a tool result: the error flag and the declared fields. */
export function auditResult(result: ToolResult, pointers: readonly string[]): AuditedResult {
  const isError = result.isError === true
  const kept =
    result.structuredContent === undefined
      ? undefined
      : keepDeclared(result.structuredContent, pointers)
  return kept === undefined ? { isError } : { isError, kept }
}

function resolve(value: JsonValue, segments: readonly string[]): JsonValue[] {
  const [head, ...rest] = segments
  if (head === undefined) return [value]
  if (head === '*') {
    const children = isJsonArray(value)
      ? [...value]
      : isJsonObject(value)
        ? Object.values(value)
        : []
    return children.flatMap((child) => resolve(child, rest))
  }
  if (isJsonArray(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(head)) return []
    const item = value[Number(head)]
    return item === undefined ? [] : resolve(item, rest)
  }
  if (!isJsonObject(value) || !Object.hasOwn(value, head)) return []
  const item = value[head]
  return item === undefined ? [] : resolve(item, rest)
}

/** A copy of a kept value: secret-looking keys masked, strings cut, arrays capped. */
function bound(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value.length > MAX_KEPT_STRING ? `${value.slice(0, MAX_KEPT_STRING)}…` : value
  }
  if (isJsonArray(value)) return value.slice(0, MAX_KEPT_ITEMS).map(bound)
  if (!isJsonObject(value)) return value
  const out: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value))
    out[key] = isSecretKey(key) ? REDACTED : bound(item)
  return out
}

function parsePointer(pointer: string): readonly string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}
