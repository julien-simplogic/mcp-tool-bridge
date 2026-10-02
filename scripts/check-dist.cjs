// Same check as check-dist.mjs, for CommonJS consumers.
const assert = require('node:assert/strict')
const {
  createBridge,
  createMcpServer,
  defineTool,
  envelope,
  jsonSchema,
  serveStdio,
  ToolDefinitionError,
  ToolRegistry,
} = require('mcp-tool-bridge')
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
const registry = new ToolRegistry().register(tool)
const bridge = createBridge({ registry, context: () => undefined, audit: [] })
const server = createMcpServer(bridge, {
  info: { name: 'check', version: '0.0.0' },
  principal: { id: 'x', roles: ['reader'] },
})
assert.equal(typeof server.connect, 'function')
assert.equal(typeof serveStdio, 'function')
assert.equal(typeof envelope, 'function')
jsonSchema({ type: 'object', properties: { to: { type: 'string', format: 'email' } } })

assert.throws(() => zodSchema(z.object({ when: z.date() })), ToolDefinitionError)
console.log('CJS build OK')
