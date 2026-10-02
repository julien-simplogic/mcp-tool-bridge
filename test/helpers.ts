import {
  createBridge,
  defineTool,
  jsonSchema,
  memorySink,
  ToolRegistry,
  type Bridge,
  type BridgeOptions,
  type MemorySink,
  type Principal,
  type Tool,
  type ToolDefinition,
} from '../src/index.js'
import type { CallContext } from '../src/tool.js'

export const reader: Principal = { id: 'alice', roles: ['reader'] }
export const editor: Principal = { id: 'bob', roles: ['reader', 'editor'] }
export const nobody: Principal = { id: 'eve', roles: [] }

const noArgs = jsonSchema({ type: 'object', properties: {}, additionalProperties: false })

/** A valid declaration, to be specialised field by field. */
export function baseDefinition(name = 'ping'): ToolDefinition<unknown, unknown> {
  return {
    name,
    description: 'Answers pong.',
    args: noArgs,
    sensitivity: 'none',
    reversible: true,
    roles: ['reader'],
    handler: () => Promise.resolve('pong'),
  }
}

export function makeTool(
  name: string,
  extra: Partial<ToolDefinition<unknown, unknown>> = {},
): Tool {
  return defineTool({ ...baseDefinition(name), ...extra })
}

/** Bypasses the types, to exercise the runtime checks JavaScript callers rely on. */
export function defineUnchecked(definition: unknown): Tool {
  return defineTool(definition as ToolDefinition<unknown, unknown>)
}

export function callContext<TContext>(
  context: TContext,
  principal: Principal = reader,
): CallContext<TContext> {
  return { principal, context, signal: new AbortController().signal, callId: 'call-1' }
}

export interface Harness<TContext> {
  readonly bridge: Bridge<TContext>
  readonly registry: ToolRegistry<TContext>
  readonly audit: MemorySink
  /** Moves the fake clock forward. */
  readonly advance: (ms: number) => void
  /** Audit event types, in order. */
  readonly trail: () => string[]
}

/** A bridge on a fake clock, with an in-memory audit log. */
export function setup<TContext = unknown>(
  tools: readonly Tool<TContext>[],
  options: Partial<BridgeOptions<TContext>> = {},
): Harness<TContext> {
  let clock = Date.UTC(2026, 9, 2, 12, 0, 0)
  const registry = new ToolRegistry<TContext>().register(...tools)
  const audit = memorySink()
  const bridge = createBridge<TContext>({
    registry,
    context: () => undefined as TContext,
    audit,
    now: () => clock,
    ...options,
  })
  return {
    bridge,
    registry,
    audit,
    advance: (ms) => {
      clock += ms
    },
    trail: () => audit.events.map((event) => event.type),
  }
}
