import { ToolDefinitionError } from '../errors.js'
import { cloneJson, deepFreeze, isJsonObject } from '../json.js'
import type { JsonObject } from '../types.js'

/** A JSON Schema whose root is an object, as MCP requires for tool inputs. */
export interface JsonSchemaObject extends JsonObject {
  readonly type: 'object'
}

/** One reason the arguments were rejected. `path` is a JSON Pointer; the root is `""`. */
export interface ArgIssue {
  readonly path: string
  readonly message: string
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ArgIssue[] }

/**
 * The contract every argument schema meets, whatever produced it. `jsonSchema`
 * is what the model sees; `parse` is what the bridge enforces. Both adapters
 * shipped with the package derive the two from a single declaration, so they
 * cannot drift apart.
 */
export interface ArgsSchema<T> {
  readonly jsonSchema: JsonSchemaObject
  readonly parse: (input: unknown) => ParseResult<T>
}

/** Beyond this, more issues add noise for the model, not information. */
export const MAX_ISSUES = 20

export const NOT_JSON_ISSUE: ArgIssue = Object.freeze({
  path: '',
  message: 'must be plain JSON data',
})

/**
 * Snapshots a schema produced by an adapter or written by hand: plain JSON,
 * root `type: "object"`, deeply frozen so that later edits to the source
 * object cannot change what the model is shown.
 */
export function freezeRootSchema(schema: unknown, tool?: string): JsonSchemaObject {
  const copy = cloneJson(schema)
  if (!copy.ok || !isJsonObject(copy.value)) {
    throw new ToolDefinitionError('invalid_schema', 'an argument schema must be plain JSON data', {
      tool,
    })
  }
  const root = copy.value
  if (!isRootObjectSchema(root)) {
    throw new ToolDefinitionError(
      'invalid_schema',
      'MCP requires the root of an argument schema to be `type: "object"`',
      { tool },
    )
  }
  return deepFreeze(root)
}

function isRootObjectSchema(schema: JsonObject): schema is JsonSchemaObject {
  return schema.type === 'object'
}
