import type { JsonObject, JsonValue } from './types.js'

export type JsonCloneResult =
  { readonly ok: true; readonly value: JsonValue } | { readonly ok: false }

const NOT_JSON = Symbol('not-json')

/**
 * Deep-copies `value` if, and only if, it is plain JSON data: strings, finite
 * numbers, booleans, null, arrays and plain objects. Properties whose value is
 * `undefined` are dropped, as `JSON.stringify` would. Anything else (functions,
 * dates, maps, class instances, cycles, NaN) makes the whole value non-JSON.
 *
 * Arguments that cross MCP are JSON by construction; this guard is for hosts
 * that call the bridge directly, and it gives every later step (validation,
 * audit, confirmation digests) a value nobody else holds a reference to.
 */
export function cloneJson(value: unknown): JsonCloneResult {
  const copy = cloneValue(value, new Set())
  return copy === NOT_JSON ? { ok: false } : { ok: true, value: copy }
}

function cloneValue(value: unknown, ancestors: Set<object>): JsonValue | typeof NOT_JSON {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : NOT_JSON
  if (typeof value !== 'object') return NOT_JSON
  if (ancestors.has(value)) return NOT_JSON

  if (Array.isArray(value)) {
    ancestors.add(value)
    const items: JsonValue[] = []
    for (const item of value as readonly unknown[]) {
      const copy = cloneValue(item, ancestors)
      if (copy === NOT_JSON) return NOT_JSON
      items.push(copy)
    }
    ancestors.delete(value)
    return items
  }

  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return NOT_JSON

  ancestors.add(value)
  const out: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const copy = cloneValue(item, ancestors)
    if (copy === NOT_JSON) return NOT_JSON
    out[key] = copy
  }
  ancestors.delete(value)
  return out
}

/** `Array.isArray` narrows to `any[]`; this keeps the element type. */
export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Freezes a JSON value in place, recursively, and returns it. */
export function deepFreeze<T extends JsonValue>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** Escapes one segment of a JSON Pointer (RFC 6901). */
export function pointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

/** Reads a property of a value whose type is not trusted (configuration, JavaScript callers). */
export function readProperty(source: object, key: string): unknown {
  return Reflect.get(source, key) as unknown
}
