import { isJsonArray, isJsonObject } from '../json.js'
import type { ContentBlock, JsonValue, ToolResult } from '../types.js'
import type { AuditedResult } from './events.js'

export const REDACTED = '[REDACTED]'

/**
 * Keys masked wherever they appear, compared without case, `-` or `_`:
 * `apiKey`, `API_KEY` and `x-api-key` all match `apikey`. Matching is by
 * substring (`accessToken`, `client_secret`): masking a harmless field costs
 * less than logging a secret.
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

/** Beyond this, result text in the audit log is cut. */
export const MAX_AUDITED_TEXT = 2000

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[-_]/g, '')
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part))
}

/**
 * A masked copy of `value`: secret-looking keys anywhere, plus the tool's own
 * JSON Pointers. The input is not modified.
 */
export function redact(value: JsonValue, pointers: readonly string[] = []): JsonValue {
  let masked = maskSecretKeys(value)
  for (const pointer of pointers) masked = maskPointer(masked, parsePointer(pointer))
  return masked
}

function maskSecretKeys(value: JsonValue): JsonValue {
  if (isJsonArray(value)) return value.map((item) => maskSecretKeys(item))
  if (!isJsonObject(value)) return value
  const out: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : maskSecretKeys(item)
  }
  return out
}

function maskPointer(value: JsonValue, path: readonly string[]): JsonValue {
  const [head, ...rest] = path
  if (head === undefined) return REDACTED
  if (isJsonArray(value)) {
    const index = /^(0|[1-9][0-9]*)$/.test(head) ? Number(head) : -1
    if (index < 0 || index >= value.length) return value
    return value.map((item, i) => (i === index ? maskPointer(item, rest) : item))
  }
  if (!isJsonObject(value) || !Object.hasOwn(value, head)) return value
  const item = value[head]
  if (item === undefined) return value
  return { ...value, [head]: maskPointer(item, rest) }
}

function parsePointer(pointer: string): readonly string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/** What the audit log keeps of a tool result. */
export function auditResult(result: ToolResult, pointers: readonly string[] = []): AuditedResult {
  const fullText = result.content.map(describeBlock).join('\n')
  const truncated = fullText.length > MAX_AUDITED_TEXT
  const text = truncated ? `${fullText.slice(0, MAX_AUDITED_TEXT)}…` : fullText
  const base = { text, truncated, isError: result.isError === true }
  return result.structuredContent === undefined
    ? base
    : { ...base, structuredContent: redact(result.structuredContent, pointers) }
}

function describeBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return `[image ${block.mimeType}]`
    case 'audio':
      return `[audio ${block.mimeType}]`
  }
}
