import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { FromSchema, JSONSchema } from 'json-schema-to-ts'
import { ToolDefinitionError } from '../errors.js'
import { cloneJson, isJsonObject, pointerSegment } from '../json.js'
import type { JsonObject } from '../types.js'
import {
  type ArgIssue,
  type ArgsSchema,
  freezeRootSchema,
  MAX_ISSUES,
  NOT_JSON_ISSUE,
  type ParseResult,
} from './types.js'

/** A JSON Schema literal whose root is an object. */
export type ObjectJsonSchema = Exclude<JSONSchema, boolean> & { readonly type: 'object' }

/**
 * The argument type a schema describes. A property with a `default` stays
 * optional: defaults are not applied (see `jsonSchema`), so the handler must
 * not be told the property is always there.
 */
export type ArgsOf<S> = S extends JSONSchema
  ? FromSchema<S, { keepDefaultedPropertiesOptional: true }>
  : never

/** `unknown` for a valid schema; otherwise the full JSON Schema type, to report the faulty keyword. */
type ValidSchema<S> = S extends JSONSchema ? unknown : JSONSchema

/**
 * Wraps a JSON Schema (draft 2020-12) literal. Declare it inline or `as const`
 * and the handler's argument type is inferred from it.
 *
 * The schema is compiled once, here, in Ajv's strict mode: an unknown
 * keyword, an unknown format or a `required` property missing from
 * `properties` fails at startup instead of silently accepting bad input.
 * Defaults are documentation for the model; they are not applied, and no
 * type coercion takes place: `"3"` is not a number.
 */
export function jsonSchema<const S extends { readonly type: 'object' }>(
  schema: S & ValidSchema<NoInfer<S>>,
): ArgsSchema<ArgsOf<S>> {
  // The type parameter is only constrained to `{ type: "object" }`; the full
  // JSON Schema check (`ValidSchema`) runs once `S` is known. Constraining `S`
  // to the whole JSON Schema type instead makes TypeScript expand that type
  // while it infers `defineTool`'s arguments, and `args: jsonSchema({…})`
  // written inline then exceeds the compiler's instantiation limits.
  type Args = ArgsOf<S>
  const compiled = compileJsonSchema(schema)

  const parse = (input: unknown): ParseResult<Args> => {
    const result = compiled.parse(input)
    if (!result.ok) return result
    // The one assertion of this module, and a sound one: Ajv has just checked
    // the value against the very schema `Args` is computed from.
    const typed: unknown = result.value
    return { ok: true, value: typed as Args }
  }

  return Object.freeze({ jsonSchema: compiled.jsonSchema, parse })
}

/**
 * The runtime core of `jsonSchema`, for schemas whose shape is only known at
 * runtime (tool definitions imported from elsewhere). Same compilation, same
 * strictness; the arguments are typed as a plain JSON object.
 *
 * @internal Not exported from the package.
 */
export function compileJsonSchema(schema: unknown, tool?: string): ArgsSchema<JsonObject> {
  const root = freezeRootSchema(schema, tool)

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  })
  addFormats(ajv)

  let validate: ValidateFunction
  try {
    validate = ajv.compile(root)
  } catch (error) {
    const prefix = tool === undefined ? '' : `tool "${tool}": `
    throw new ToolDefinitionError(
      'invalid_schema',
      `${prefix}invalid JSON Schema: ${messageOf(error)}`,
      {
        tool,
        cause: error,
      },
    )
  }

  const parse = (input: unknown): ParseResult<JsonObject> => {
    const copy = cloneJson(input)
    if (!copy.ok) return { ok: false, issues: [NOT_JSON_ISSUE] }
    const value = copy.value
    if (!validate(value)) return { ok: false, issues: toIssues(validate.errors) }
    // The root is `type: "object"`, so a valid value is an object.
    if (!isJsonObject(value))
      return { ok: false, issues: [{ path: '', message: 'must be object' }] }
    return { ok: true, value }
  }

  return Object.freeze({ jsonSchema: root, parse })
}

function toIssues(errors: readonly ErrorObject[] | null | undefined): readonly ArgIssue[] {
  if (!errors || errors.length === 0) return [{ path: '', message: 'is invalid' }]
  return errors.slice(0, MAX_ISSUES).map((error) => {
    const params: Readonly<Record<string, unknown>> = error.params
    let path = error.instancePath
    if (error.keyword === 'required' && typeof params.missingProperty === 'string') {
      path += `/${pointerSegment(params.missingProperty)}`
    }
    if (error.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
      path += `/${pointerSegment(params.additionalProperty)}`
    }
    return { path, message: error.message ?? 'is invalid' }
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
