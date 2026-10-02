import { ToolError } from '../errors.js'
import type { ToolOutput } from '../types.js'

/** How to read the result envelope an existing function returns. */
export interface EnvelopeSpec<R> {
  /** Did the call succeed? */
  readonly ok: (result: R) => boolean
  /** What the model gets on success: a string, or `text()` / `json()`. */
  readonly value: (result: R) => ToolOutput
  /**
   * What the model reads on failure. It is shown as is: map raw errors
   * (stack traces, hostnames, SQL) to something the model may read.
   */
  readonly message: (result: R) => string
}

/**
 * Plugs an existing implementation that reports failure in its return value
 * (`{ success, data, error }`, `{ ok, detail }`…) into a handler, without
 * rewriting it. A failed envelope becomes a `ToolError`, so the bridge treats
 * it as an expected failure the model may read; a successful one becomes the
 * tool's output.
 *
 * ```ts
 * const fromLegacy = envelope<{ success: boolean; data?: Invoice; error?: string }>({
 *   ok: (r) => r.success,
 *   value: (r) => json({ invoiceId: r.data?.id ?? null }),
 *   message: (r) => r.error ?? 'The invoice could not be sent.',
 * })
 * handler: async (args) => fromLegacy(await legacy.sendInvoice(args.invoiceId)),
 * ```
 */
export function envelope<R>(spec: EnvelopeSpec<R>): (result: R) => ToolOutput {
  return (result) => {
    if (!spec.ok(result)) throw new ToolError(spec.message(result))
    return spec.value(result)
  }
}
