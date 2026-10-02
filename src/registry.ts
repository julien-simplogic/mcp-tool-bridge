import { ToolDefinitionError } from './errors.js'
import { isTool, type Tool } from './tool.js'

/**
 * The catalog of tools a bridge may expose. It only accepts descriptors
 * built by `defineTool`, so every entry has passed the declaration checks.
 */
export class ToolRegistry<TContext = unknown> {
  readonly #tools = new Map<string, Tool<TContext>>()
  readonly #listeners = new Set<() => void>()

  /**
   * Adds tools, all or none: if one of them is invalid or its name is taken
   * (by an existing tool or by another tool in the same call), the registry
   * is left unchanged.
   */
  register(...tools: readonly Tool<TContext>[]): this {
    const incoming = new Set<string>()
    for (const tool of tools) {
      if (!isTool(tool)) {
        throw new ToolDefinitionError(
          'not_a_tool',
          'only tools created by defineTool() can be registered',
        )
      }
      if (this.#tools.has(tool.name) || incoming.has(tool.name)) {
        throw new ToolDefinitionError(
          'duplicate_name',
          `a tool named "${tool.name}" already exists`,
          {
            tool: tool.name,
          },
        )
      }
      incoming.add(tool.name)
    }
    if (tools.length === 0) return this
    for (const tool of tools) this.#tools.set(tool.name, tool)
    this.#notify()
    return this
  }

  /** Removes a tool. Returns false if there was none by that name. */
  unregister(name: string): boolean {
    const removed = this.#tools.delete(name)
    if (removed) this.#notify()
    return removed
  }

  get(name: string): Tool<TContext> | undefined {
    return this.#tools.get(name)
  }

  has(name: string): boolean {
    return this.#tools.has(name)
  }

  /** Every tool, in registration order, regardless of who is asking. */
  list(): readonly Tool<TContext>[] {
    return Object.freeze([...this.#tools.values()])
  }

  get size(): number {
    return this.#tools.size
  }

  /**
   * Called after every change. The MCP server uses it to send
   * `notifications/tools/list_changed`. Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        // A failing listener must neither undo the change nor silence the
        // other listeners. Warnings go to stderr, never to stdout, which is
        // the protocol channel under stdio.
        process.emitWarning(
          `mcp-tool-bridge: a registry onChange listener threw: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}
