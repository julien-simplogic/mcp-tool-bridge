// Loads the built package the way an ESM consumer would, through its
// package name and `exports` map, and checks that both entry points share
// one copy of the error classes and of the defineTool brand.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createBridge,
  createMcpServer,
  defineTool,
  envelope,
  jsonSchema,
  serveStdio,
  ToolDefinitionError,
  ToolRegistry,
} from 'mcp-tool-bridge'
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
// Nothing in what npm publishes may reveal the machine that built it.
const HOME_PATH = /(\/Users\/|\/home\/|\/private\/var\/|[A-Z]:\\Users\\)/
const dist = join(import.meta.dirname, '..', 'dist')
for (const file of readdirSync(dist)) {
  const content = readFileSync(join(dist, file), 'utf8')
  assert.ok(!HOME_PATH.test(content), `dist/${file} contains an absolute path of the build machine`)
}

console.log('ESM build OK, no absolute path in dist/')
