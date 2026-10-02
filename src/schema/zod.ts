import * as z from 'zod'
import { ToolDefinitionError } from '../errors.js'
import { cloneJson, isJsonObject, pointerSegment } from '../json.js'
import {
  type ArgIssue,
  type ArgsSchema,
  freezeRootSchema,
  MAX_ISSUES,
  NOT_JSON_ISSUE,
  type ParseResult,
} from './types.js'

/**
 * Wraps a Zod (v4) object schema. The JSON Schema shown to the model is
 * generated from the *input* side of the schema, so transforms and defaults
 * describe what the model must send, while the handler receives the parsed
 * output.
 *
 * Types that JSON cannot carry (dates, bigints, custom checks with no JSON
 * Schema equivalent) fail at startup. Refinements that do not translate to
 * JSON Schema are still enforced by `parse`, but the model is not told about
 * them: put the rule in the field's `.describe()` too. Async refinements are
 * not supported.
 */
export function zodSchema<S extends z.ZodObject>(schema: S): ArgsSchema<z.output<S>> {
  let generated: unknown
  try {
    generated = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'throw',
    })
  } catch (error) {
    throw new ToolDefinitionError(
      'invalid_schema',
      `this Zod schema has no JSON Schema equivalent: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const root = freezeRootSchema(withoutDialect(generated))

  const parse = (input: unknown): ParseResult<z.output<S>> => {
    const copy = cloneJson(input)
    if (!copy.ok) return { ok: false, issues: [NOT_JSON_ISSUE] }
    const result = schema.safeParse(copy.value)
    if (result.success) return { ok: true, value: result.data }
    return { ok: false, issues: toIssues(result.error.issues) }
  }

  return Object.freeze({ jsonSchema: root, parse })
}

/**
 * Drops the root `$schema` keyword: draft 2020-12 is already the MCP default,
 * and several LLM APIs reject tool schemas that carry it.
 */
function withoutDialect(generated: unknown): unknown {
  const copy = cloneJson(generated)
  if (!copy.ok || !isJsonObject(copy.value)) return generated
  return Object.fromEntries(Object.entries(copy.value).filter(([keyword]) => keyword !== '$schema'))
}

function toIssues(issues: readonly z.core.$ZodIssue[]): readonly ArgIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map((segment) => `/${pointerSegment(String(segment))}`).join(''),
    message: issue.message,
  }))
}
