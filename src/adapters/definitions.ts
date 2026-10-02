import { ToolDefinitionError } from '../errors.js'
import { readProperty } from '../json.js'
import { compileJsonSchema } from '../schema/jsonSchema.js'
import {
  type AuditRetention,
  type CallContext,
  type ConfirmMode,
  defineTool,
  type Tool,
} from '../tool.js'
import type { JsonObject, Sensitivity, ToolOutput } from '../types.js'

/**
 * What a foreign tool definition does not say: how much harm the tool can do
 * and who may use it. Declared per tool, never defaulted.
 */
export interface Governance {
  readonly sensitivity: Sensitivity
  readonly reversible: boolean
  readonly roles: readonly [string, ...string[]]
  readonly title?: string
  readonly confirm?: ConfirmMode
  /** What the audit log may keep; nothing but metadata by default. */
  readonly audit?: AuditRetention
  readonly timeoutMs?: number
  readonly summarize?: (args: JsonObject) => string
}

/** Runs any of the imported tools, by name. Arguments are already validated. */
export type Dispatcher<TContext> = (
  name: string,
  args: JsonObject,
  call: CallContext<TContext>,
) => Promise<ToolOutput>

/** A tool without parameters accepts nothing, rather than anything. */
const NO_PARAMETERS = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
})

/**
 * Turns tool definitions written for an LLM API into bridge tools, with one
 * dispatcher for all of them. Accepted shapes:
 *
 * - Anthropic: `{ name, description, input_schema }`
 * - MCP: `{ name, description, inputSchema }`
 * - OpenAI: `{ type: 'function', function: { name, description, parameters } }`,
 *   or `{ type: 'function', name, description, parameters }`
 *
 * Every definition needs an entry in `governance`, and every entry a
 * definition: a tool nobody classified, or a classification for a tool that
 * does not exist (a typo), fails at startup, all names listed at once.
 * Schemas are compiled in the same strict mode as `jsonSchema()`.
 */
export function importDefinitions<TContext = unknown>(
  definitions: readonly unknown[],
  dispatch: Dispatcher<TContext>,
  governance: Readonly<Record<string, Governance>>,
): Tool<TContext>[] {
  const parsed = definitions.map(normalize)

  const seen = new Set<string>()
  for (const { name } of parsed) {
    if (seen.has(name)) {
      throw new ToolDefinitionError('duplicate_name', `two definitions are named "${name}"`, {
        tool: name,
      })
    }
    seen.add(name)
  }

  const missing = parsed.map(({ name }) => name).filter((name) => !Object.hasOwn(governance, name))
  if (missing.length > 0) {
    throw new ToolDefinitionError(
      'missing_governance',
      `no governance declared for: ${missing.join(', ')}. Declare sensitivity, reversible and roles for each.`,
    )
  }
  const unknown = Object.keys(governance).filter((name) => !seen.has(name))
  if (unknown.length > 0) {
    throw new ToolDefinitionError(
      'unknown_governance',
      `governance declared for tools that have no definition: ${unknown.join(', ')}`,
    )
  }

  return parsed.map(({ name, description, schema }) => {
    const rules = governance[name]
    if (rules === undefined) throw new ToolDefinitionError('missing_governance', name)
    return defineTool<JsonObject, TContext>({
      ...rules,
      name,
      description,
      args: compileJsonSchema(schema ?? NO_PARAMETERS, name),
      handler: (args, call) => dispatch(name, args, call),
    })
  })
}

interface Normalized {
  readonly name: string
  readonly description: string
  readonly schema: unknown
}

function normalize(definition: unknown, index: number): Normalized {
  if (typeof definition !== 'object' || definition === null) {
    throw new ToolDefinitionError(
      'invalid_definition',
      `definition #${String(index)} is not an object`,
    )
  }
  // OpenAI chat completions nest the function one level down.
  const nested = readProperty(definition, 'function')
  const source = typeof nested === 'object' && nested !== null ? nested : definition

  const name = readProperty(source, 'name')
  if (typeof name !== 'string') {
    throw new ToolDefinitionError('invalid_name', `definition #${String(index)} has no name`)
  }
  const description = readProperty(source, 'description')
  if (typeof description !== 'string' || description.trim() === '') {
    throw new ToolDefinitionError(
      'invalid_description',
      `tool "${name}": a description is required, it is all the model reads`,
      { tool: name },
    )
  }
  const schema =
    readProperty(source, 'input_schema') ??
    readProperty(source, 'inputSchema') ??
    readProperty(source, 'parameters')
  return { name, description, schema }
}
