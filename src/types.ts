/**
 * How much harm a tool can do, from `none` (no side effect at all) to
 * `critical`. The level drives the confirmation guard and the MCP
 * `readOnlyHint` annotation; it is never shown to the model as such.
 */
export const SENSITIVITY_LEVELS = ['none', 'low', 'medium', 'high', 'critical'] as const

export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number]

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === 'string' && (SENSITIVITY_LEVELS as readonly string[]).includes(value)
}

/** Position of a level on the scale: `none` is 0, `critical` is 4. */
export function sensitivityRank(level: Sensitivity): number {
  return SENSITIVITY_LEVELS.indexOf(level)
}

/**
 * Who is calling. The bridge only reads `id` (for audit and for binding
 * confirmations) and `roles` (for access control); anything else the host
 * needs belongs in its own context.
 */
export interface Principal {
  readonly id: string
  readonly roles: readonly string[]
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface TextContent {
  readonly type: 'text'
  readonly text: string
}

export interface ImageContent {
  readonly type: 'image'
  /** Base64-encoded bytes. */
  readonly data: string
  readonly mimeType: string
}

export interface AudioContent {
  readonly type: 'audio'
  /** Base64-encoded bytes. */
  readonly data: string
  readonly mimeType: string
}

export type ContentBlock = TextContent | ImageContent | AudioContent

/** The shape of an MCP `tools/call` result, restricted to what the bridge emits. */
export interface ToolResult {
  readonly content: readonly ContentBlock[]
  readonly structuredContent?: JsonObject
  readonly isError?: boolean
}

/**
 * What a handler may return: a plain string (sent as text) or a full result,
 * usually built with `text()` or `json()`.
 */
export type ToolOutput = string | ToolResult
