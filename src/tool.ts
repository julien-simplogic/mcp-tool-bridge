import { ToolDefinitionError, type ToolDefinitionErrorCode } from './errors.js'
import { readProperty } from './json.js'
import {
  type ArgIssue,
  type ArgsSchema,
  freezeRootSchema,
  type JsonSchemaObject,
} from './schema/types.js'
import { isSensitivity, type Principal, type Sensitivity, type ToolOutput } from './types.js'

/**
 * `auto` lets the bridge's policy decide from `sensitivity` and `reversible`.
 * `always` forces a confirmation whatever the policy. There is deliberately
 * no way to opt a tool *out* of the policy.
 */
export type ConfirmMode = 'auto' | 'always'

/** What a handler knows about the call it serves. */
export interface CallContext<TContext> {
  readonly principal: Principal
  /** Whatever the host built for this principal (database client, tenant…). */
  readonly context: TContext
  /** Aborted when the call times out or the client cancels it. */
  readonly signal: AbortSignal
  /** Unique per call; the same id appears in every audit event of the call. */
  readonly callId: string
}

export type ToolHandler<TArgs, TContext> = (
  args: TArgs,
  call: CallContext<TContext>,
) => Promise<ToolOutput>

/**
 * A tool declaration. The governance fields — `sensitivity`, `reversible`,
 * `roles` — are required and have no default: a tool nobody classified is a
 * startup error, not a tool open to everyone.
 */
export interface ToolDefinition<TArgs, TContext> {
  /** Unique within a registry. MCP allows `A-Z a-z 0-9 _ - .`, 1 to 128 characters. */
  readonly name: string
  readonly title?: string
  /** What the model reads to decide whether and how to call the tool. */
  readonly description: string
  readonly args: ArgsSchema<TArgs>
  readonly sensitivity: Sensitivity
  /** Can the effect be undone? An irreversible tool is confirmed one level earlier. */
  readonly reversible: boolean
  /** A principal needs at least one of these roles to see or call the tool. */
  readonly roles: readonly [string, ...string[]]
  readonly confirm?: ConfirmMode
  /** One sentence describing this specific call, shown to whoever confirms it. */
  readonly summarize?: (args: NoInfer<TArgs>) => string
  /**
   * What the audit log may keep of this tool's calls. By default, nothing but
   * metadata (tool, principal, argument digest, verdict, duration). Keeping
   * content is a written decision: JSON Pointers into the arguments
   * (`args`) and into the structured result (`result`); `*` matches every
   * element. A `read_email` tool would keep `{ args: ['/messageId'] }` and nothing else.
   */
  readonly audit?: AuditRetention
  readonly timeoutMs?: number
  readonly handler: ToolHandler<NoInfer<TArgs>, TContext>
}

/** JSON Pointers of the fields the audit log may keep. Empty by default. */
export interface AuditRetention {
  readonly args?: readonly string[]
  readonly result?: readonly string[]
}

declare const contextType: unique symbol

/**
 * A declared tool: an immutable descriptor. It carries no way to execute the
 * handler; only the bridge can, after its checks. `TContext` is the context
 * the handler expects; a tool that needs none fits any registry.
 */
export interface Tool<TContext = unknown> {
  readonly name: string
  readonly title: string | undefined
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly sensitivity: Sensitivity
  readonly reversible: boolean
  readonly roles: readonly string[]
  readonly confirm: ConfirmMode
  /** What the audit may keep; both lists are empty unless the tool declared otherwise. */
  readonly audit: { readonly args: readonly string[]; readonly result: readonly string[] }
  readonly timeoutMs: number | undefined
  /** Type-level only: keeps a tool needing `{ db }` out of a registry that cannot provide it. */
  readonly [contextType]?: (context: TContext) => void
}

/** Arguments validated and bound to the handler, ready to run. */
export type PreparedCall<TContext> =
  | {
      readonly ok: true
      readonly summary: string
      readonly run: (call: CallContext<TContext>) => Promise<ToolOutput>
    }
  | { readonly ok: false; readonly issues: readonly ArgIssue[] }

interface ToolInternals<TContext> {
  readonly prepare: (input: unknown) => PreparedCall<TContext>
}

/** Every tool built by `defineTool`, and how to run it. Not exported from the package. */
const internals = new WeakMap<object, ToolInternals<never>>()

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const MAX_TIMEOUT_MS = 2 ** 31 - 1

export function defineTool<TArgs, TContext = unknown>(
  definition: ToolDefinition<TArgs, TContext>,
): Tool<TContext> {
  // The checks run on the declaration as `unknown`: the types already rule
  // these mistakes out for TypeScript callers, not for JavaScript ones or for
  // declarations assembled at runtime.
  const descriptor = checkDefinition(definition)
  const { args, handler, summarize } = definition
  const { name, title } = descriptor

  const tool: Tool<TContext> = Object.freeze({
    ...descriptor,
    inputSchema: freezeRootSchema(args.jsonSchema, name),
  })

  const prepare = (input: unknown): PreparedCall<TContext> => {
    const parsed = args.parse(input)
    if (!parsed.ok) return { ok: false, issues: parsed.issues }
    const value = parsed.value
    return {
      ok: true,
      summary: summarize ? summarize(value) : (title ?? name),
      run: (call) => handler(value, call),
    }
  }
  internals.set(tool, { prepare })
  return tool
}

/** True for descriptors produced by `defineTool`, and only those. */
export function isTool(value: unknown): value is Tool {
  return typeof value === 'object' && value !== null && internals.has(value)
}

/** @internal Used by the bridge; not part of the public API. */
export function prepareCall<TContext>(
  tool: Tool<TContext>,
  input: unknown,
): PreparedCall<TContext> {
  // Sound: the entry was stored by defineTool together with this very tool.
  const found = internals.get(tool) as ToolInternals<TContext> | undefined
  if (!found) {
    throw new ToolDefinitionError('not_a_tool', 'this object was not created by defineTool()')
  }
  return found.prepare(input)
}

/** MCP behaviour hints, derived from the declaration. */
export interface ToolAnnotations {
  readonly title?: string
  /** `sensitivity: "none"` means the tool has no side effect. */
  readonly readOnlyHint: boolean
  /** Irreversible tools are flagged as destructive. */
  readonly destructiveHint: boolean
}

/** What the model is shown of a tool. Roles and sensitivity levels stay server-side. */
export interface ExposedTool {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly annotations: ToolAnnotations
}

export function exposeTool(tool: Tool<never>): ExposedTool {
  const readOnly = tool.sensitivity === 'none'
  const destructive = !readOnly && !tool.reversible
  return tool.title === undefined
    ? {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
      }
    : {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, readOnlyHint: readOnly, destructiveHint: destructive },
      }
}

type Descriptor = Omit<Tool, 'inputSchema'>
type Fail = (code: ToolDefinitionErrorCode, message: string) => ToolDefinitionError

function checkDefinition(definition: unknown): Descriptor {
  if (typeof definition !== 'object' || definition === null) {
    throw new ToolDefinitionError('invalid_definition', 'a tool definition must be an object')
  }
  const name = readProperty(definition, 'name')
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    throw new ToolDefinitionError(
      'invalid_name',
      `invalid tool name ${JSON.stringify(name)}: use 1 to 128 characters among A-Z a-z 0-9 _ - .`,
    )
  }
  const fail: Fail = (code, message) =>
    new ToolDefinitionError(code, `tool "${name}": ${message}`, { tool: name })

  const title = readProperty(definition, 'title')
  if (!(title === undefined || isNonEmptyString(title))) {
    throw fail('invalid_title', '`title` must be a non-empty string when present')
  }
  const description = readProperty(definition, 'description')
  if (!isNonEmptyString(description)) {
    throw fail('invalid_description', '`description` is required: it is all the model reads')
  }
  if (!isArgsSchema(readProperty(definition, 'args'))) {
    throw fail(
      'invalid_schema',
      '`args` must come from jsonSchema(), zodSchema() or match ArgsSchema',
    )
  }
  const sensitivity = readProperty(definition, 'sensitivity')
  if (!isSensitivity(sensitivity)) {
    throw fail('invalid_sensitivity', 'expected none, low, medium, high or critical')
  }
  const reversible = readProperty(definition, 'reversible')
  if (typeof reversible !== 'boolean') {
    throw fail('invalid_reversible', '`reversible` must be declared, true or false')
  }
  const roles = checkRoles(readProperty(definition, 'roles'), fail)
  const confirm = readProperty(definition, 'confirm') ?? 'auto'
  if (confirm !== 'auto' && confirm !== 'always') {
    throw fail('invalid_confirm', '`confirm` must be "auto" or "always"')
  }
  const summarize = readProperty(definition, 'summarize')
  if (summarize !== undefined && typeof summarize !== 'function') {
    throw fail('invalid_summarize', '`summarize` must be a function')
  }
  const audit = checkAudit(readProperty(definition, 'audit'), fail)
  const timeoutMs = readProperty(definition, 'timeoutMs')
  if (!(timeoutMs === undefined || isTimeout(timeoutMs))) {
    throw fail('invalid_timeout', '`timeoutMs` must be a positive integer of milliseconds')
  }
  if (typeof readProperty(definition, 'handler') !== 'function') {
    throw fail('invalid_handler', '`handler` must be a function')
  }

  return { name, title, description, sensitivity, reversible, roles, confirm, audit, timeoutMs }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isTimeout(value: unknown): value is number {
  return (
    Number.isInteger(value) && typeof value === 'number' && value > 0 && value <= MAX_TIMEOUT_MS
  )
}

function isArgsSchema(value: unknown): value is ArgsSchema<unknown> {
  if (typeof value !== 'object' || value === null) return false
  return 'parse' in value && typeof value.parse === 'function' && 'jsonSchema' in value
}

function checkRoles(value: unknown, fail: Fail): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('invalid_roles', '`roles` must list at least one role')
  }
  const roles = new Set<string>()
  for (const role of value as readonly unknown[]) {
    if (typeof role !== 'string' || role === '' || role.trim() !== role) {
      throw fail('invalid_roles', `invalid role ${JSON.stringify(role)}`)
    }
    roles.add(role)
  }
  return Object.freeze([...roles])
}

function checkAudit(
  value: unknown,
  fail: Fail,
): { readonly args: readonly string[]; readonly result: readonly string[] } {
  if (value === undefined)
    return Object.freeze({ args: Object.freeze([]), result: Object.freeze([]) })
  if (typeof value !== 'object' || value === null) {
    throw fail('invalid_audit', '`audit` must be an object such as { args: ["/messageId"] }')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'args' && key !== 'result') {
      throw fail('invalid_audit', `unknown audit field ${JSON.stringify(key)}: use args or result`)
    }
  }
  return Object.freeze({
    args: checkPointers(readProperty(value, 'args'), 'audit.args', fail),
    result: checkPointers(readProperty(value, 'result'), 'audit.result', fail),
  })
}

function checkPointers(value: unknown, field: string, fail: Fail): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value))
    throw fail('invalid_audit', `\`${field}\` must be an array of JSON Pointers`)
  const pointers: string[] = []
  for (const pointer of value as readonly unknown[]) {
    if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/') {
      throw fail(
        'invalid_audit',
        `${JSON.stringify(pointer)} in ${field} is not a JSON Pointer such as "/messageId"`,
      )
    }
    pointers.push(pointer)
  }
  return Object.freeze(pointers)
}
