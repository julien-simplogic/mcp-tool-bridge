import type { ArgIssue } from '../schema/types.js'
import type { JsonValue } from '../types.js'

export type AuditTransport = 'stdio' | 'http' | 'direct'

/**
 * Why a call did not run. The model is told less: `forbidden` reaches it as
 * `unknown_tool`, so that probing tool names reveals nothing.
 */
export type RejectionReason =
  | 'unknown_tool'
  | 'forbidden'
  | 'invalid_arguments'
  | 'confirmation_invalid'
  | 'confirmation_expired'

/**
 * - `tool_error`: the handler threw a ToolError, its message reached the model.
 * - `exception`: anything else went wrong; the model only got a generic message.
 * - `timeout`, `aborted`: the bridge stopped waiting. The handler may still be running.
 * - `audit_unavailable`: the call was not executed because the audit log could not record it.
 */
export type FailureKind = 'tool_error' | 'exception' | 'timeout' | 'aborted' | 'audit_unavailable'

/** What the audit keeps of a result: bounded, and with secrets masked. */
export interface AuditedResult {
  readonly text: string
  readonly truncated: boolean
  readonly structuredContent?: JsonValue
  readonly isError: boolean
}

/** Fields every event carries. */
export interface AuditBase {
  /** Unique per event. */
  readonly id: string
  /** ISO 8601. */
  readonly at: string
  /** Shared by every event of one call, including its confirmation and redemption. */
  readonly callId: string
  readonly transport: AuditTransport
  readonly principal: { readonly id: string; readonly roles: readonly string[] }
  readonly tool: string
  /** The arguments as received, masked. Absent when they were not JSON. */
  readonly args?: JsonValue
}

/** What distinguishes one kind of event from another. */
export type AuditEventBody =
  | {
      readonly type: 'call.rejected'
      readonly reason: RejectionReason
      readonly issues?: readonly ArgIssue[]
    }
  | { readonly type: 'confirmation.issued'; readonly expiresAt: string; readonly summary: string }
  | { readonly type: 'confirmation.declined' }
  | { readonly type: 'call.started'; readonly confirmed: boolean }
  | {
      readonly type: 'call.succeeded'
      readonly confirmed: boolean
      readonly durationMs: number
      readonly result: AuditedResult
    }
  | {
      readonly type: 'call.failed'
      readonly confirmed: boolean
      readonly durationMs: number
      readonly error: { readonly kind: FailureKind; readonly message: string }
    }

/**
 * One line of the audit log. A call that runs produces `call.started` then
 * `call.succeeded` or `call.failed`; a confirmed call is preceded by
 * `confirmation.issued`, under the same `callId`.
 */
export type AuditEvent = AuditBase & AuditEventBody

export type AuditEventType = AuditEvent['type']

/**
 * Where audit events go. `write` may be synchronous or return a promise; the
 * bridge waits for it before going on, so events are recorded in order.
 */
export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>
}
