/* eslint-disable @typescript-eslint/no-deprecated --
 * The SDK flags its low-level `Server` as deprecated "for the high-level API"
 * and reserved for advanced use cases. This is one: `McpServer` registers
 * tools globally and validates arguments itself, while the bridge needs a tool
 * list per principal and its own validation, confirmation and audit.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Bridge } from '../bridge.js'
import { createMcpServer, type McpServerOptions } from './mcpServer.js'

export type StdioServerOptions = Omit<McpServerOptions, 'transport'>

export interface StdioHandle {
  readonly server: Server
  close(): Promise<void>
}

/**
 * Serves the bridge over stdin/stdout, for one principal fixed at launch.
 * stdout carries the protocol and nothing else: the audit log and warnings
 * go to stderr.
 */
export async function serveStdio<TContext>(
  bridge: Bridge<TContext>,
  options: StdioServerOptions,
): Promise<StdioHandle> {
  const server = createMcpServer(bridge, { ...options, transport: 'stdio' })
  await server.connect(new StdioServerTransport())
  return {
    server,
    close: () => server.close(),
  }
}
