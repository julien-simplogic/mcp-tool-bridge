import { randomUUID } from 'node:crypto'
import { canAccess, parsePrincipal, visibleTools } from './access.js'
import type {
  AuditEventBody,
  AuditSink,
  AuditTransport,
  ConfirmationFailure,
  FailureKind,
  RejectionReason,
} from './audit/events.js'
import { auditResult, keepDeclared } from './audit/redact.js'
import { stderrJsonSink } from './audit/sinks.js'
import {
  type ConfirmationPolicy,
  type ConfirmationThreshold,
  DEFAULT_POLICY,
  isConfirmationThreshold,
  requiresConfirmation,
} from './confirmation/policy.js'
import {
  type ConfirmationRecord,
  type ConfirmationStore,
  MemoryConfirmationStore,
} from './confirmation/store.js'
import { digestArguments, hashToken, newToken } from './confirmation/token.js'
import { ToolError } from './errors.js'
import { cloneJson, deepFreeze, isJsonObject, readProperty } from './json.js'
import { ToolRegistry } from './registry.js'
import { normalizeOutput } from './result.js'
import { type ArgIssue, NOT_JSON_ISSUE } from './schema/types.js'
import { type ExposedTool, exposeTool, type PreparedCall, prepareCall, type Tool } from './tool.js'
import {
  isSensitivity,
  type JsonObject,
  type JsonValue,
  type Principal,
  type Sensitivity,
  type ToolResult,
} from './types.js'

/** Builds what handlers receive as `call.context`, once per executed call. */
export type ContextFactory<TContext> = (principal: Principal) => TContext | Promise<TContext>

export interface ConfirmationOptions {
  /** Default `high`. */
  readonly threshold?: ConfirmationThreshold
  /** Default true: irreversible tools are confirmed one level below the threshold. */
  readonly irreversibleLowersThreshold?: boolean
  /**
   * How long a confirmation stays redeemable: one duration for every tool, or
   * a table per sensitivity and reversibility. The expiry is computed when the
   * confirmation is issued and stored with it; changing this later does not
   * move confirmations already issued. Default 5 minutes.
   */
  readonly ttlMs?: number | ConfirmationTtlTable
  /** Default: in memory, for a single process. */
  readonly store?: ConfirmationStore
}

/**
 * Lifetimes, in milliseconds, per sensitivity and reversibility. An
 * irreversible action deserves a shorter window: past it, the context of the
 * decision is not the one in which it was taken. A level or a case left out
 * falls back to 5 minutes.
 *
 * ```ts
 * const HOUR = 3_600_000
 * ttlMs: {
 *   medium: { reversible: 24 * HOUR, irreversible: 12 * HOUR },
 *   high: { reversible: 12 * HOUR, irreversible: 4 * HOUR },
 *   critical: { reversible: 4 * HOUR, irreversible: HOUR },
 * }
 * ```
 */
export type ConfirmationTtlTable = Readonly<
  Partial<Record<Sensitivity, { readonly reversible?: number; readonly irreversible?: number }>>
>

export interface BridgeOptions<TContext> {
  readonly registry: ToolRegistry<TContext>
  readonly context: ContextFactory<TContext>
  readonly confirmation?: ConfirmationOptions
  /** Default: JSON lines on stderr. */
  readonly audit?: AuditSink | readonly AuditSink[]
  /**
   * What to do when a sink fails. `continue` (default) warns on stderr and
   * goes on. `block` refuses to start a call, or to issue a confirmation,
   * that the audit log could not record.
   */
  readonly auditFailure?: 'continue' | 'block'
  /** Clock, in epoch milliseconds. For tests. */
  readonly now?: () => number
}

export interface CallRequest {
  readonly name: string
  /** Omitted arguments are treated as `{}`, as MCP does. */
  readonly arguments?: unknown
  /**
   * A token from a previous `confirmation_required` outcome. Set by the host
   * once a human has confirmed — never taken from the model's output.
   */
  readonly confirmationToken?: string
}

export interface CallOptions {
  /** Cancels the call. The handler receives a signal that aborts with it. */
  readonly signal?: AbortSignal
  /** Recorded in the audit log. The bundled servers set it; default `direct`. */
  readonly transport?: AuditTransport
}

/** For the host, not for the model: the token is what lets the call run. */
export interface PendingConfirmation {
  readonly token: string
  /** ISO 8601. */
  readonly expiresAt: string
  readonly tool: string
  readonly summary: string
}

/** Every outcome carries the `callId` found in the audit log. */
export type CallOutcome =
  | { readonly status: 'ok'; readonly callId: string; readonly result: ToolResult }
  | { readonly status: 'tool_error'; readonly callId: string; readonly message: string }
  | {
      readonly status: 'invalid_arguments'
      readonly callId: string
      readonly issues: readonly ArgIssue[]
    }
  | {
      readonly status: 'confirmation_required'
      readonly callId: string
      readonly confirmation: PendingConfirmation
    }
  | {
      readonly status: 'rejected'
      readonly callId: string
      readonly reason: 'unknown_tool' | 'confirmation_invalid' | 'confirmation_expired'
    }

export interface Bridge<TContext> {
  readonly registry: ToolRegistry<TContext>
  /** The tools this principal may see, as the model will see them. First filter. */
  listTools(principal: Principal): readonly ExposedTool[]
  /** Second filter, then validation, then the confirmation guard, then execution. */
  callTool(principal: Principal, request: CallRequest, options?: CallOptions): Promise<CallOutcome>
  /**
   * Runs a call held back for confirmation, for the principal it was issued
   * to. For confirmations given later, outside the conversation.
   */
  executeConfirmed(principal: Principal, token: string, options?: CallOptions): Promise<CallOutcome>
  /**
   * Withdraws a pending confirmation: the human said no. Returns false if
   * there was nothing to withdraw for this principal. A token presented by
   * another principal is destroyed all the same.
   */
  revokeConfirmation(principal: Principal, token: string, options?: CallOptions): Promise<boolean>
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

/** What the model reads when it is not allowed to know more. */
const MESSAGES = {
  exception: 'The tool failed unexpectedly. The failure was recorded.',
  aborted: 'The call was cancelled.',
  auditUnavailable: 'The call was not executed: the audit log is unavailable.',
  timeout: (ms: number) => `The tool did not answer within ${String(ms)} ms.`,
} as const

export function createBridge<TContext>(options: BridgeOptions<TContext>): Bridge<TContext> {
  return new ToolBridge(checkOptions(options))
}

/**
 * Builds the audit scope of a call. The arguments are reduced here, as they
 * enter the audit: their digest, and the fields the tool declared — nothing
 * else of them is kept in the scope.
 */
function scope(
  callId: string,
  transport: AuditTransport,
  principal: Principal,
  name: string,
  tool: Pick<Tool<never>, 'audit'> | undefined,
  args: JsonValue | undefined,
): CallScope {
  const keepArgs = tool?.audit.args ?? []
  return {
    callId,
    transport,
    principal,
    tool: name,
    argsDigest: args === undefined ? undefined : digestArguments(args),
    keptArgs: args === undefined || !isJsonObject(args) ? undefined : keepDeclared(args, keepArgs),
    keepResult: tool?.audit.result ?? [],
  }
}

interface Settings<TContext> {
  readonly registry: ToolRegistry<TContext>
  readonly context: ContextFactory<TContext>
  readonly policy: ConfirmationPolicy
  readonly ttlFor: (tool: Pick<Tool<never>, 'sensitivity' | 'reversible'>) => number
  readonly store: ConfirmationStore
  readonly sinks: readonly AuditSink[]
  readonly blockOnAuditFailure: boolean
  readonly now: () => number
}

/**
 * Everything the audit needs to know about the call in progress — and
 * nothing more. The arguments themselves are NOT here: only their digest and
 * the fields the tool declared, reduced when the scope is built.
 */
interface CallScope {
  readonly callId: string
  readonly transport: AuditTransport
  readonly principal: Principal
  readonly tool: string
  readonly argsDigest: string | undefined
  readonly keptArgs: JsonObject | undefined
  readonly keepResult: readonly string[]
}

/** A redemption request: the call presented with the token, when there is one. */
interface Presented {
  readonly name: string
  readonly args: JsonValue | undefined
}

/** Longest error message kept in the audit log. */
const MAX_AUDITED_ERROR = 500

type Ready<TContext> = Extract<PreparedCall<TContext>, { ok: true }>

class ToolBridge<TContext> implements Bridge<TContext> {
  readonly registry: ToolRegistry<TContext>
  readonly #settings: Settings<TContext>

  constructor(settings: Settings<TContext>) {
    this.registry = settings.registry
    this.#settings = settings
  }

  listTools(principal: Principal): readonly ExposedTool[] {
    const caller = parsePrincipal(principal)
    return Object.freeze(visibleTools(this.registry.list(), caller).map(exposeTool))
  }

  async callTool(
    principal: Principal,
    request: CallRequest,
    options: CallOptions = {},
  ): Promise<CallOutcome> {
    const caller = parsePrincipal(principal)
    const copy = cloneJson(request.arguments ?? {})
    const args = copy.ok ? copy.value : undefined
    if (request.confirmationToken !== undefined) {
      return this.#redeem(caller, request.confirmationToken, options, { name: request.name, args })
    }

    const callId = randomUUID()
    const transport = options.transport ?? 'direct'
    const tool = this.registry.get(request.name)
    if (!tool) {
      return this.#reject(
        scope(callId, transport, caller, request.name, undefined, args),
        'unknown_tool',
      )
    }
    const inScope = scope(callId, transport, caller, tool.name, tool, args)
    // Second filter: the list a client was shown proves nothing.
    if (!canAccess(tool, caller)) return this.#reject(inScope, 'forbidden')
    if (args === undefined) return this.#rejectArguments(inScope, [NOT_JSON_ISSUE])

    let prepared: PreparedCall<TContext>
    try {
      prepared = prepareCall(tool, args)
    } catch (error) {
      return this.#fail(inScope, false, 0, 'exception', error)
    }
    if (!prepared.ok) return this.#rejectArguments(inScope, prepared.issues)

    if (requiresConfirmation(tool, this.#settings.policy)) {
      return this.#issue(inScope, tool, args, prepared.summary)
    }
    return this.#execute(inScope, tool, prepared, false, options.signal)
  }

  executeConfirmed(
    principal: Principal,
    token: string,
    options: CallOptions = {},
  ): Promise<CallOutcome> {
    return this.#redeem(parsePrincipal(principal), token, options, undefined)
  }

  async revokeConfirmation(
    principal: Principal,
    token: string,
    options: CallOptions = {},
  ): Promise<boolean> {
    const caller = parsePrincipal(principal)
    const transport = options.transport ?? 'direct'
    const taken = await this.#settings.store.take(hashToken(token), this.#settings.now())
    const record = 'record' in taken ? taken.record : undefined
    const inScope = this.#recordScope(record, transport, caller, undefined)
    if (taken.status === 'unknown' || taken.status === 'consumed') {
      await this.#reject(inScope, 'confirmation_invalid', taken.status)
      return false
    }
    if (record && record.principalId !== caller.id) {
      await this.#reject(inScope, 'confirmation_invalid', 'principal_mismatch')
      return false
    }
    await this.#record(inScope, { type: 'confirmation.declined' })
    return true
  }

  /**
   * Redeems a token: from `executeConfirmed` (`expected` absent) or from a
   * repeated `callTool` (`expected` is that request, which must match).
   * Everything is checked again, as if the call were new: the tool may have
   * been removed and the principal's roles may have changed since.
   */
  async #redeem(
    caller: Principal,
    token: string,
    options: CallOptions,
    presented: Presented | undefined,
  ): Promise<CallOutcome> {
    const transport = options.transport ?? 'direct'
    const now = this.#settings.now()
    // Taken, not read: from here on the token is spent, whatever happens next.
    // The store checks the expiry in the same atomic step.
    const taken = await this.#settings.store.take(hashToken(token), now)
    const record = 'record' in taken ? taken.record : undefined
    const inScope = this.#recordScope(record, transport, caller, presented)

    if (taken.status === 'unknown' || taken.status === 'consumed') {
      return this.#reject(inScope, 'confirmation_invalid', taken.status)
    }
    // A token presented by someone else is refused as invalid before anything
    // reveals whether it existed or expired.
    if (record && record.principalId !== caller.id) {
      return this.#reject(inScope, 'confirmation_invalid', 'principal_mismatch')
    }
    // Checked again here, from the expiry stored with the record: a store
    // that forgot to check cannot let an expired token through.
    if (taken.status === 'expired' || !record || now >= record.expiresAt) {
      return this.#reject(inScope, 'confirmation_expired', 'expired')
    }
    if (presented) {
      if (presented.name !== record.tool) {
        return this.#reject(inScope, 'confirmation_invalid', 'tool_mismatch')
      }
      if (
        presented.args === undefined ||
        digestArguments(presented.args) !== record.argumentsDigest
      ) {
        return this.#reject(inScope, 'confirmation_invalid', 'arguments_mismatch')
      }
    }

    const tool = this.registry.get(record.tool)
    if (!tool) return this.#reject(inScope, 'unknown_tool')
    if (!canAccess(tool, caller)) return this.#reject(inScope, 'forbidden')

    let prepared: PreparedCall<TContext>
    try {
      prepared = prepareCall(tool, record.arguments)
    } catch (error) {
      return this.#fail(inScope, true, 0, 'exception', error)
    }
    if (!prepared.ok) return this.#rejectArguments(inScope, prepared.issues)
    return this.#execute(inScope, tool, prepared, true, options.signal)
  }

  /** The audit scope of a redemption: the confirmed call when known, else what was presented. */
  #recordScope(
    record: ConfirmationRecord | undefined,
    transport: AuditTransport,
    caller: Principal,
    presented: Presented | undefined,
  ): CallScope {
    const name = record?.tool ?? presented?.name ?? ''
    const tool = this.registry.get(name)
    if (record) {
      return {
        ...scope(record.callId, transport, caller, name, tool, record.arguments),
        argsDigest: record.argumentsDigest,
      }
    }
    return scope(randomUUID(), transport, caller, name, tool, presented?.args)
  }

  async #issue(
    scope: CallScope,
    tool: Tool<TContext>,
    args: JsonValue,
    summary: string,
  ): Promise<CallOutcome> {
    const { store, ttlFor, now } = this.#settings
    const token = newToken()
    const createdAt = now()
    const record: ConfirmationRecord = Object.freeze({
      tokenHash: hashToken(token),
      callId: scope.callId,
      principalId: scope.principal.id,
      tool: tool.name,
      arguments: deepFreeze(args),
      argumentsDigest: digestArguments(args),
      summary,
      createdAt,
      // Computed once, now, from this tool's class; stored with the record.
      expiresAt: createdAt + ttlFor(tool),
    })
    try {
      await store.put(record)
    } catch (error) {
      return this.#fail(scope, false, 0, 'exception', error)
    }
    const expiresAt = new Date(record.expiresAt).toISOString()
    // The summary is written from the arguments: it goes to the host, not to the audit log.
    const recorded = await this.#record(scope, { type: 'confirmation.issued', expiresAt })
    if (!recorded && this.#settings.blockOnAuditFailure) {
      // A capability the audit log does not know about must not exist.
      await store.take(record.tokenHash, now())
      return { status: 'tool_error', callId: scope.callId, message: MESSAGES.auditUnavailable }
    }
    return {
      status: 'confirmation_required',
      callId: scope.callId,
      confirmation: Object.freeze({ token, expiresAt, tool: tool.name, summary }),
    }
  }

  async #execute(
    scope: CallScope,
    tool: Tool<TContext>,
    prepared: Ready<TContext>,
    confirmed: boolean,
    signal: AbortSignal | undefined,
  ): Promise<CallOutcome> {
    let context: TContext
    try {
      context = await this.#settings.context(scope.principal)
    } catch (error) {
      return this.#fail(scope, confirmed, 0, 'exception', error)
    }

    const recorded = await this.#record(scope, { type: 'call.started', confirmed })
    if (!recorded && this.#settings.blockOnAuditFailure) {
      return this.#fail(scope, confirmed, 0, 'audit_unavailable', undefined)
    }

    const startedAt = this.#settings.now()
    const elapsed = () => Math.max(0, this.#settings.now() - startedAt)
    let result: ToolResult | undefined
    try {
      const output = await runWithLimits(
        (abort) =>
          prepared.run({
            principal: scope.principal,
            context,
            signal: abort,
            callId: scope.callId,
          }),
        tool.timeoutMs,
        signal,
      )
      result = normalizeOutput(output)
    } catch (error) {
      if (error instanceof Timeout) return this.#fail(scope, confirmed, elapsed(), 'timeout', error)
      if (error instanceof Cancelled)
        return this.#fail(scope, confirmed, elapsed(), 'aborted', error)
      if (error instanceof ToolError) {
        return this.#fail(scope, confirmed, elapsed(), 'tool_error', error)
      }
      return this.#fail(scope, confirmed, elapsed(), 'exception', error)
    }
    if (!result) {
      const invalid = new Error('the handler returned neither a string nor a valid ToolResult')
      return this.#fail(scope, confirmed, elapsed(), 'exception', invalid)
    }

    await this.#record(scope, {
      type: 'call.succeeded',
      confirmed,
      durationMs: elapsed(),
      result: auditResult(result, scope.keepResult),
    })
    return { status: 'ok', callId: scope.callId, result }
  }

  async #reject(
    scope: CallScope,
    reason: Exclude<RejectionReason, 'invalid_arguments'>,
    detail?: ConfirmationFailure,
  ): Promise<CallOutcome> {
    await this.#record(
      scope,
      detail === undefined
        ? { type: 'call.rejected', reason }
        : { type: 'call.rejected', reason, detail },
    )
    // `forbidden` and `unknown_tool` look the same from outside.
    const visible = reason === 'forbidden' ? 'unknown_tool' : reason
    return { status: 'rejected', callId: scope.callId, reason: visible }
  }

  async #rejectArguments(scope: CallScope, issues: readonly ArgIssue[]): Promise<CallOutcome> {
    await this.#record(scope, { type: 'call.rejected', reason: 'invalid_arguments', issues })
    return { status: 'invalid_arguments', callId: scope.callId, issues }
  }

  async #fail(
    scope: CallScope,
    confirmed: boolean,
    durationMs: number,
    kind: FailureKind,
    error: unknown,
  ): Promise<CallOutcome> {
    const full =
      kind === 'audit_unavailable'
        ? MESSAGES.auditUnavailable
        : error instanceof Error
          ? error.message
          : String(error)
    // Cut here, as it enters the audit record, not when it is serialized.
    const detail = full.length > MAX_AUDITED_ERROR ? `${full.slice(0, MAX_AUDITED_ERROR)}…` : full
    await this.#record(scope, {
      type: 'call.failed',
      confirmed,
      durationMs,
      error: { kind, message: detail },
    })
    return { status: 'tool_error', callId: scope.callId, message: publicMessage(kind, error) }
  }

  /** Writes to every sink. Returns false if any of them failed. */
  async #record(scope: CallScope, body: AuditEventBody): Promise<boolean> {
    const event = {
      id: randomUUID(),
      at: new Date(this.#settings.now()).toISOString(),
      callId: scope.callId,
      transport: scope.transport,
      principal: { id: scope.principal.id, roles: scope.principal.roles },
      tool: scope.tool,
      ...(scope.argsDigest === undefined ? {} : { argsDigest: scope.argsDigest }),
      ...(scope.keptArgs === undefined ? {} : { args: scope.keptArgs }),
      ...body,
    }
    let ok = true
    for (const sink of this.#settings.sinks) {
      try {
        await sink.write(event)
      } catch (error) {
        ok = false
        process.emitWarning(
          `mcp-tool-bridge: an audit sink failed on ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return ok
  }
}

function publicMessage(kind: FailureKind, error: unknown): string {
  switch (kind) {
    case 'tool_error':
      return error instanceof Error ? error.message : MESSAGES.exception
    case 'timeout':
      return error instanceof Timeout ? MESSAGES.timeout(error.ms) : MESSAGES.exception
    case 'aborted':
      return MESSAGES.aborted
    case 'audit_unavailable':
      return MESSAGES.auditUnavailable
    case 'exception':
      return MESSAGES.exception
  }
}

class Timeout extends Error {
  readonly ms: number
  constructor(ms: number) {
    super(`no answer within ${String(ms)} ms`)
    this.ms = ms
  }
}

class Cancelled extends Error {
  constructor() {
    super('cancelled by the caller')
  }
}

/**
 * Runs the handler under a timeout and the caller's signal. When either
 * fires, the bridge stops waiting and the handler's signal aborts; a handler
 * that ignores its signal keeps running, but its result is discarded.
 */
async function runWithLimits<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  outer: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController()
  const cancel = () => {
    controller.abort(new Cancelled())
  }
  if (outer?.aborted) cancel()
  else outer?.addEventListener('abort', cancel, { once: true })
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new Timeout(timeoutMs))
        }, timeoutMs)

  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = () => {
      const reason: unknown = controller.signal.reason
      reject(reason instanceof Error ? reason : new Cancelled())
    }
    if (controller.signal.aborted) stop()
    else controller.signal.addEventListener('abort', stop, { once: true })
  })

  try {
    if (controller.signal.aborted) return await stopped
    return await Promise.race([run(controller.signal), stopped])
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', cancel)
  }
}

/**
 * Checks the options as untrusted input (they often come from configuration)
 * and fills in the defaults.
 */
function checkOptions<TContext>(options: BridgeOptions<TContext>): Settings<TContext> {
  const raw: unknown = options
  if (typeof raw !== 'object' || raw === null)
    throw new TypeError('createBridge: options are required')
  const { registry, context } = options
  if (!(readProperty(raw, 'registry') instanceof ToolRegistry)) {
    throw new TypeError('createBridge: `registry` must be a ToolRegistry')
  }
  if (typeof readProperty(raw, 'context') !== 'function') {
    throw new TypeError(
      'createBridge: `context` must be a function (use `() => undefined` if tools need none)',
    )
  }

  const confirmation: unknown = readProperty(raw, 'confirmation') ?? {}
  if (typeof confirmation !== 'object' || confirmation === null) {
    throw new TypeError('createBridge: `confirmation` must be an object')
  }
  const threshold = readProperty(confirmation, 'threshold') ?? DEFAULT_POLICY.threshold
  if (!isConfirmationThreshold(threshold)) {
    throw new TypeError(
      'createBridge: `confirmation.threshold` must be low, medium, high or critical',
    )
  }
  const lowers =
    readProperty(confirmation, 'irreversibleLowersThreshold') ??
    DEFAULT_POLICY.irreversibleLowersThreshold
  if (typeof lowers !== 'boolean') {
    throw new TypeError(
      'createBridge: `confirmation.irreversibleLowersThreshold` must be a boolean',
    )
  }
  const ttlFor = checkTtl(readProperty(confirmation, 'ttlMs'))

  const now = readProperty(raw, 'now')
  if (now !== undefined && typeof now !== 'function') {
    throw new TypeError('createBridge: `now` must be a function')
  }
  const clock = options.now ?? Date.now

  const store = options.confirmation?.store ?? new MemoryConfirmationStore({ now: clock })
  if (!hasMethods(store, ['put', 'take'])) {
    throw new TypeError('createBridge: `confirmation.store` must implement put() and take()')
  }

  const audit: unknown = readProperty(raw, 'audit')
  const sinks: readonly unknown[] =
    audit === undefined ? [stderrJsonSink()] : Array.isArray(audit) ? audit : [audit]
  const checkedSinks: AuditSink[] = []
  for (const sink of sinks) {
    if (!isSink(sink))
      throw new TypeError('createBridge: every audit sink must have a write() method')
    checkedSinks.push(sink)
  }

  const auditFailure = readProperty(raw, 'auditFailure') ?? 'continue'
  if (auditFailure !== 'continue' && auditFailure !== 'block') {
    throw new TypeError('createBridge: `auditFailure` must be "continue" or "block"')
  }

  return {
    registry,
    context,
    policy: Object.freeze({ threshold, irreversibleLowersThreshold: lowers }),
    ttlFor,
    store,
    sinks: Object.freeze(checkedSinks),
    blockOnAuditFailure: auditFailure === 'block',
    now: clock,
  }
}

/** One duration, or a table per sensitivity and reversibility; anything missing gets the default. */
function checkTtl(
  value: unknown,
): (tool: Pick<Tool<never>, 'sensitivity' | 'reversible'>) => number {
  const duration = (v: unknown, where: string): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
      throw new TypeError(
        `createBridge: \`confirmation.ttlMs${where}\` must be a positive integer of milliseconds`,
      )
    }
    return v
  }
  if (value === undefined) return () => DEFAULT_TTL_MS
  if (typeof value === 'number') {
    const ms = duration(value, '')
    return () => ms
  }
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      'createBridge: `confirmation.ttlMs` must be a number or a table per sensitivity',
    )
  }
  const table = new Map<string, number>()
  for (const level of Object.keys(value)) {
    if (!isSensitivity(level)) {
      throw new TypeError(
        `createBridge: \`confirmation.ttlMs\` has an unknown sensitivity ${JSON.stringify(level)}`,
      )
    }
    const row: unknown = readProperty(value, level)
    if (typeof row !== 'object' || row === null) {
      throw new TypeError(
        `createBridge: \`confirmation.ttlMs.${level}\` must be { reversible?, irreversible? }`,
      )
    }
    for (const kind of Object.keys(row)) {
      if (kind !== 'reversible' && kind !== 'irreversible') {
        throw new TypeError(
          `createBridge: \`confirmation.ttlMs.${level}.${kind}\` is not reversible or irreversible`,
        )
      }
      table.set(`${level}:${kind}`, duration(readProperty(row, kind), `.${level}.${kind}`))
    }
  }
  return (tool) =>
    table.get(`${tool.sensitivity}:${tool.reversible ? 'reversible' : 'irreversible'}`) ??
    DEFAULT_TTL_MS
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false
  return methods.every((method) => typeof readProperty(value, method) === 'function')
}

function isSink(value: unknown): value is AuditSink {
  return hasMethods(value, ['write'])
}
