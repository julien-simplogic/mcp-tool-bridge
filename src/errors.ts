export type ToolDefinitionErrorCode =
  | 'invalid_definition'
  | 'invalid_name'
  | 'invalid_title'
  | 'invalid_description'
  | 'invalid_schema'
  | 'invalid_sensitivity'
  | 'invalid_reversible'
  | 'invalid_roles'
  | 'invalid_confirm'
  | 'invalid_summarize'
  | 'invalid_redact'
  | 'invalid_timeout'
  | 'invalid_handler'
  | 'duplicate_name'
  | 'not_a_tool'

/**
 * A tool declaration is wrong. Thrown at startup — by `defineTool`, a schema
 * adapter or the registry — never while serving a call.
 */
export class ToolDefinitionError extends Error {
  override readonly name = 'ToolDefinitionError'
  readonly code: ToolDefinitionErrorCode
  /** The offending tool, when its name is known. */
  readonly tool: string | undefined

  constructor(
    code: ToolDefinitionErrorCode,
    message: string,
    options?: { readonly tool?: string | undefined; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.tool = options?.tool
  }
}

/**
 * An expected failure that the model is allowed to read: "no invoice with
 * this number", "the slot is already booked". Its message is returned as the
 * tool result. Any other exception thrown by a handler is reported to the
 * model as a generic failure, and its details go to the audit log only.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError'
}
