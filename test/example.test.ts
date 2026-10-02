import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRMATION_META_KEY } from '../src/index.js'

// Runs examples/minimal/server.ts as a real stdio server in a child process,
// the way an MCP client launches it. Nothing goes over the network.

const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

async function launch(roles: string): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'examples/minimal/server.ts'],
    env: {
      PATH: process.env.PATH ?? '',
      EXAMPLE_PRINCIPAL_ID: 'alice',
      EXAMPLE_PRINCIPAL_ROLES: roles,
    },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const client = new Client({ name: 'example-test', version: '1.0.0' })
  await client.connect(transport)
  clients.push(client)
  return { client, stderr: () => stderr }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(
    await client.callTool({
      name,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta }),
    }),
  )
}

describe('examples/minimal', () => {
  it('serves the three tools to an editor, and only the read to a reader', async () => {
    const editor = await launch('reader,editor')
    expect((await editor.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_notes',
      'add_note',
      'send_email',
    ])
    const reader = await launch('reader')
    expect((await reader.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_notes',
    ])
  }, 30_000)

  it('reads and writes directly, and holds the email until it is confirmed', async () => {
    const { client, stderr } = await launch('reader,editor')

    expect(await call(client, 'add_note', { text: 'Book the van.' })).toMatchObject({
      content: [{ text: 'Note n3 added.' }],
    })
    const found = await call(client, 'search_notes', { query: 'van' })
    expect(found.structuredContent).toEqual({
      notes: [{ id: 'n3', text: 'Book the van.', author: 'alice' }],
    })

    const email = { to: 'ada@example.com', subject: 'Van booked', body: 'See you Friday.' }
    const pending = await call(client, 'send_email', email)
    expect(pending.structuredContent).toMatchObject({ status: 'confirmation_required' })
    expect(JSON.stringify({ ...pending, _meta: undefined })).not.toContain('mtb_')
    expect(stderr()).not.toContain('[example] email to')

    const { token } = pending._meta?.[CONFIRMATION_META_KEY] as { token: string }
    const sent = await call(client, 'send_email', email, { [CONFIRMATION_META_KEY]: { token } })
    expect(sent.isError).toBeFalsy()
    // Exactly one email went out: the pending call sent nothing.
    await vi.waitFor(
      () => {
        expect(stderr().split('[example] email to ada@example.com').length - 1).toBe(1)
      },
      { timeout: 5_000, interval: 20 },
    )
    expect(sent.structuredContent).toMatchObject({
      messageId: expect.stringMatching(/^m-/) as unknown,
    })

    // The audit log went to stderr, one JSON object per line. It keeps who the
    // email went to (declared by the tool) and nothing of its subject or body.
    // stderr and stdout are separate pipes: the response can arrive before the
    // last audit line, so wait for the lines instead of reading them at once.
    const events = () =>
      stderr()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map(
          (line) =>
            JSON.parse(line) as { type: string; tool: string; args?: Record<string, unknown> },
        )
    await vi.waitFor(
      () => {
        expect(
          events()
            .filter((event) => event.tool === 'send_email')
            .map((event) => event.type),
        ).toEqual(['confirmation.issued', 'call.started', 'call.succeeded'])
      },
      { timeout: 5_000, interval: 20 },
    )
    for (const event of events().filter((e) => e.tool === 'send_email')) {
      expect(event.args).toEqual({ '/to': 'ada@example.com' })
    }
    const auditLines = stderr()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .join('\n')
    expect(auditLines).not.toMatch(/Van booked|See you Friday/)
  }, 30_000)

  it('turns a failed legacy envelope into an error the model can read', async () => {
    const { client } = await launch('editor')
    const email = { to: 'ghost@example.invalid', subject: 'Hello', body: '…' }
    const pending = await call(client, 'send_email', email)
    const { token } = pending._meta?.[CONFIRMATION_META_KEY] as { token: string }
    const failed = await call(client, 'send_email', email, { [CONFIRMATION_META_KEY]: { token } })
    expect(failed).toMatchObject({
      isError: true,
      content: [{ text: 'Mailbox ghost@example.invalid does not exist.' }],
    })
  }, 30_000)
})
