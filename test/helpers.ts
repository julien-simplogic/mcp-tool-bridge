import {
  defineTool,
  jsonSchema,
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
