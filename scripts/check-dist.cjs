// Same check as check-dist.mjs, for CommonJS consumers.
const assert = require('node:assert/strict')
const { defineTool, jsonSchema, ToolDefinitionError, ToolRegistry } = require('mcp-tool-bridge')
const { zodSchema } = require('mcp-tool-bridge/zod')
const z = require('zod')

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
console.log('CJS build OK')
