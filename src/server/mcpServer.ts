/* eslint-disable @typescript-eslint/no-deprecated --
 * The SDK flags its low-level `Server` as deprecated "for the high-level API"
 * and reserved for advanced use cases. This is one: `McpServer` registers
 * tools globally and validates arguments itself, while the bridge needs a tool
 * list per principal and its own validation, confirmation and audit.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ElicitResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js'
import { parsePrincipal } from '../access.js'
import type { AuditTransport } from '../audit/events.js'
import type { Bridge, CallOptions, CallOutcome, PendingConfirmation } from '../bridge.js'
import { readProperty } from '../json.js'
import type { ArgIssue } from '../schema/types.js'
import type { ExposedTool } from '../tool.js'
import type { Principal, ToolResult } from '../types.js'

/**
 * The `_meta` key carrying a pending confirmation: in a `confirmation_required`
 * result, the server puts `{ token, expiresAt, callId }` there; to redeem it,
 * the host repeats the same call with `{ token }` under the same key in the
 * request's `_meta`. `_meta` is for the host: it is not meant to reach the model.
 */
export const CONFIRMATION_META_KEY = 'mcp-tool-bridge/confirmation'

export interface ServerInfo {
  readonly name: string
  readonly version: string
  readonly title?: string
  /** Sent to the client at initialization; often shown to the model. */
  readonly instructions?: string
}

export interface McpServerOptions {
  readonly info: ServerInfo
  /**
   * Who this server acts for, for its whole lifetime: under stdio, the
   * identity is fixed when the process starts.
   */
  readonly principal: Principal
  /**
   * When a call needs confirmation and the client supports MCP elicitation,
   * ask the user directly and run the call on a yes. Default true. Without
   * elicitation, the result carries the token in `_meta` for the host.
   */
  readonly elicitConfirmations?: boolean
  /** Recorded in the audit log. `serveStdio` sets `stdio`; default `direct`. */
  readonly transport?: AuditTransport
}

/**
 * An MCP server, built on the SDK's low-level `Server`, that serves one
 * principal from a bridge. Connect it to any transport; `serveStdio` does it
 * for stdio.
 */
export function createMcpServer<TContext>(
  bridge: Bridge<TContext>,
  options: McpServerOptions,
): Server {
  const principal = parsePrincipal(options.principal)
  const transport = options.transport ?? 'direct'
  const elicit = options.elicitConfirmations ?? true
  const { name, version, title, instructions } = options.info

  const server = new Server(title === undefined ? { name, version } : { name, version, title }, {
    capabilities: { tools: { listChanged: true } },
    ...(instructions === undefined ? {} : { instructions }),
  })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: bridge.listTools(principal).map(toMcpTool),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name: tool, arguments: args, _meta } = request.params
    const token = confirmationTokenOf(_meta)
    const callOptions: CallOptions = { signal: extra.signal, transport }
    const outcome = await bridge.callTool(
      principal,
      token === undefined
        ? { name: tool, arguments: args }
        : { name: tool, arguments: args, confirmationToken: token },
      callOptions,
    )
    if (outcome.status === 'confirmation_required' && elicit && canElicit(server)) {
      return confirmWithUser(server, bridge, principal, outcome, callOptions)
    }
    return toCallToolResult(outcome, tool)
  })

  const unsubscribe = bridge.registry.onChange(() => {
    // Before a client is connected there is nobody to tell.
    server.sendToolListChanged().catch(() => undefined)
  })
  const previousOnClose = server.onclose
  server.onclose = () => {
    unsubscribe()
    previousOnClose?.()
  }

  return server
}

/**
 * Asks the user through the client, then runs or withdraws the call. If the
 * client fails to answer (error, timeout), the confirmation stays pending and
 * the host can still redeem the token.
 */
async function confirmWithUser<TContext>(
  server: Server,
  bridge: Bridge<TContext>,
  principal: Principal,
  outcome: Extract<CallOutcome, { status: 'confirmation_required' }>,
  options: CallOptions,
): Promise<CallToolResult> {
  const { confirmation } = outcome
  let answer: ElicitResult
  try {
    answer = await server.elicitInput(
      {
        message: `Allow this action? ${confirmation.summary}`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Allow',
              description: confirmation.summary,
              default: false,
            },
          },
          required: ['confirm'],
        },
      },
      {
        // A person may take a while: wait as long as the confirmation lives.
        timeout: Math.max(1, Date.parse(confirmation.expiresAt) - Date.now()),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )
  } catch {
    return pendingResult(outcome.callId, confirmation)
  }

  if (answer.action === 'accept' && answer.content?.confirm === true) {
    const executed = await bridge.executeConfirmed(principal, confirmation.token, options)
    return toCallToolResult(executed, confirmation.tool)
  }
  // Declined, dismissed or answered "no": nothing runs, and the token dies.
  await bridge.revokeConfirmation(principal, confirmation.token, options)
  return {
    content: [
      {
        type: 'text',
        text: `The user declined: ${confirmation.summary}. Nothing was done. Do not try again unless they ask.`,
      },
    ],
    structuredContent: { status: 'declined', tool: confirmation.tool },
  }
}

function canElicit(server: Server): boolean {
  const elicitation = server.getClientCapabilities()?.elicitation
  if (elicitation === undefined) return false
  // `{}` means form mode, for clients written against earlier revisions.
  return elicitation.form !== undefined || elicitation.url === undefined
}

/** The token from a request's `_meta`, if the host attached one. */
function confirmationTokenOf(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const entry = readProperty(meta, CONFIRMATION_META_KEY)
  if (typeof entry !== 'object' || entry === null) return undefined
  const token = readProperty(entry, 'token')
  return typeof token === 'string' ? token : undefined
}

function toCallToolResult(outcome: CallOutcome, tool: string): CallToolResult {
  switch (outcome.status) {
    case 'ok':
      return fromToolResult(outcome.result)
    case 'tool_error':
      return errorResult(outcome.message)
    case 'invalid_arguments':
      return errorResult(describeIssues(tool, outcome.issues))
    case 'confirmation_required':
      return pendingResult(outcome.callId, outcome.confirmation)
    case 'rejected':
      switch (outcome.reason) {
        case 'unknown_tool':
          // A protocol error, as MCP specifies for unknown tools. A tool the
          // principal may not use gets exactly the same answer.
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${tool}`)
        case 'confirmation_expired':
          return errorResult('This confirmation has expired. Nothing was done.')
        case 'confirmation_invalid':
          return errorResult(
            'This confirmation cannot be used: it was already used or withdrawn, or it was issued for another call. Nothing was done.',
          )
      }
  }
}

/**
 * What the model reads when a call waits for a human: what is pending and
 * until when, never the token. The token is in `_meta`, for the host.
 */
function pendingResult(callId: string, confirmation: PendingConfirmation): CallToolResult {
  const { token, expiresAt, tool, summary } = confirmation
  return {
    content: [
      {
        type: 'text',
        text: `Confirmation required: ${summary}. Nothing has been done yet. The user must confirm this action in the application before ${expiresAt}; calling the tool again does not confirm it.`,
      },
    ],
    structuredContent: { status: 'confirmation_required', tool, summary, expiresAt },
    _meta: { [CONFIRMATION_META_KEY]: { token, expiresAt, callId } },
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function describeIssues(tool: string, issues: readonly ArgIssue[]): string {
  const lines = issues.map(
    (issue) => `- ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`,
  )
  return [`Invalid arguments for ${tool}:`, ...lines].join('\n')
}

function fromToolResult(result: ToolResult): CallToolResult {
  return {
    content: result.content.map((block) => ({ ...block })),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: { ...result.structuredContent } }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  }
}

function toMcpTool(tool: ExposedTool): McpTool {
  const { readOnlyHint, destructiveHint } = tool.annotations
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      ...(tool.title === undefined ? {} : { title: tool.title }),
      readOnlyHint,
      destructiveHint,
    },
  }
}
