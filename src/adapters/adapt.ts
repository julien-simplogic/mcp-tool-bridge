import type { CallContext, ToolHandler } from '../tool.js'
import type { ToolOutput } from '../types.js'

/** How to talk to an existing function: what to give it, and how to read its answer. */
export interface AdaptSpec<TArgs, TContext, TInput, TResult> {
  /** Builds the function's input from the validated arguments and the call. */
  readonly input: (args: TArgs, call: CallContext<TContext>) => TInput
  /** Turns the function's result into the tool output; `envelope()` fits here. */
  readonly output: (result: TResult) => ToolOutput
}

/**
 * Turns an existing function into a handler, without rewriting it: the
 * bridge validates the arguments, `input` maps them to what the function
 * expects, and `output` maps its result back.
 *
 * ```ts
 * handler: adapt((action: LegacyAction) => legacy.execute(action), {
 *   input: (args, call) => ({ userId: call.principal.id, data: JSON.stringify(args) }),
 *   output: fromLegacy, // an envelope()
 * }),
 * ```
 *
 * Pass methods bound (`legacy.execute.bind(legacy)`) or wrapped in an arrow
 * function: `adapt` calls `fn` without a receiver.
 */
export function adapt<TArgs, TContext, TInput, TResult>(
  fn: (input: TInput) => TResult | Promise<TResult>,
  spec: AdaptSpec<TArgs, TContext, TInput, TResult>,
): ToolHandler<TArgs, TContext> {
  return async (args, call) => spec.output(await fn(spec.input(args, call)))
}
