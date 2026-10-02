// Loads the built package the way an ESM consumer would, through its
// package name and `exports` map, and checks that both entry points share
// one copy of the error classes and of the defineTool brand.
import assert from 'node:assert/strict'
import { defineTool, jsonSchema, ToolDefinitionError, ToolRegistry } from 'mcp-tool-bridge'
import { zodSchema } from 'mcp-tool-bridge/zod'
import * as z from 'zod'

const tool = defineTool({
  name: 'ping',
  description: 'Answers pong.',
  args: zodSchema(z.object({ text: z.string() })),
  sensitivity: 'none',
  reversible: true,
  roles: ['reader'],
  handler: () => Promise.resolve('pong'),
})
new ToolRegistry().register(tool)
jsonSchema({ type: 'object', properties: { to: { type: 'string', format: 'email' } } })

assert.throws(() => zodSchema(z.object({ when: z.date() })), ToolDefinitionError)
console.log('ESM build OK')
