import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ClientCapabilities,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIRMATION_META_KEY,
  createMcpServer,
  defineTool,
  json,
  jsonSchema,
  ToolError,
  type Bridge,
  type Principal,
} from '../src/index.js'
import { baseDefinition, editor, makeTool, reader, setup } from './helpers.js'

const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

interface ConnectOptions {
  readonly capabilities?: ClientCapabilities
  readonly onElicit?: () => Promise<ElicitResult>
  readonly elicitConfirmations?: boolean
}

/** A real SDK client talking to the server through linked in-memory transports. */
async function connect(
  bridge: Bridge<unknown>,
  principal: Principal,
  options: ConnectOptions = {},
): Promise<Client> {
  const server = createMcpServer(bridge, {
    info: { name: 'test-server', version: '1.0.0', instructions: 'Test tools.' },
    principal,
    ...(options.elicitConfirmations === undefined
      ? {}
      : { elicitConfirmations: options.elicitConfirmations }),
  })
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: options.capabilities ?? {} },
  )
  const onElicit = options.onElicit
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, () => onElicit())
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  clients.push(client)
  return client
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  meta?: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await client.callTool({
    name,
    arguments: args,
    ...(meta === undefined ? {} : { _meta: meta }),
  })
  return CallToolResultSchema.parse(result)
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

const mailArgs = jsonSchema({
  type: 'object',
  properties: { to: { type: 'string', format: 'email' }, subject: { type: 'string' } },
  required: ['to', 'subject'],
  additionalProperties: false,
})

function sendMail(handler = vi.fn(() => Promise.resolve('Sent.'))) {
  const tool = defineTool({
    ...baseDefinition('send_mail'),
    title: 'Send an email',
    args: mailArgs,
    sensitivity: 'high',
    reversible: false,
    roles: ['editor'],
    summarize: ({ to, subject }) => `Send "${subject}" to ${to}`,
    handler,
  })
  return { tool, handler }
}

const mail = { to: 'ada@example.com', subject: 'Invoice 12' }

describe('initialization', () => {
  it('advertises tools with change notifications, and the server instructions', async () => {
    const { bridge } = setup([makeTool('ping')])
    const client = await connect(bridge, reader)
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true })
    expect(client.getServerVersion()).toMatchObject({ name: 'test-server', version: '1.0.0' })
    expect(client.getInstructions()).toBe('Test tools.')
  })
})

describe('tools/list', () => {
  it('lists the tools of this principal only, with hints and without the policy', async () => {
    const { tool } = sendMail()
    const { bridge } = setup([makeTool('search', { roles: ['reader'] }), tool])

    const asReader = await (await connect(bridge, reader)).listTools()
    expect(asReader.tools.map((t) => t.name)).toEqual(['search'])

    const asEditor = await (await connect(bridge, editor)).listTools()
    expect(asEditor.tools.map((t) => t.name)).toEqual(['search', 'send_mail'])
    expect(asEditor.tools[1]).toMatchObject({
      name: 'send_mail',
      title: 'Send an email',
      inputSchema: { type: 'object', required: ['to', 'subject'] },
      annotations: { readOnlyHint: false, destructiveHint: true },
    })
    expect(JSON.stringify(asEditor)).not.toMatch(/"roles"|"sensitivity"|"editor"/)
  })

  it('tells the client when the catalog changes', async () => {
    const { bridge, registry } = setup([makeTool('ping')])
    const client = await connect(bridge, reader)
    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        resolve()
      })
    })
    registry.register(makeTool('pong'))
    await changed
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ping', 'pong'])
  })
})

describe('tools/call', () => {
  it('returns text and structured results', async () => {
    const { bridge } = setup([
      makeTool('ping'),
      makeTool('stats', { handler: () => Promise.resolve(json({ open: 3 })) }),
    ])
    const client = await connect(bridge, reader)
    expect(await call(client, 'ping')).toMatchObject({ content: [{ type: 'text', text: 'pong' }] })
    expect(await call(client, 'stats')).toMatchObject({ structuredContent: { open: 3 } })
  })

  it('answers an unknown tool and a forbidden tool with the same protocol error', async () => {
    const { tool } = sendMail()
    const { bridge, audit } = setup([tool])
    const client = await connect(bridge, reader)

    const errorOf = async (name: string) => {
      try {
        await call(client, name, mail)
      } catch (error) {
        return error
      }
      throw new Error('expected a protocol error')
    }
    const forbidden = await errorOf('send_mail')
    const missing = await errorOf('does_not_exist')

    expect(forbidden).toBeInstanceOf(McpError)
    expect(forbidden).toMatchObject({ code: ErrorCode.InvalidParams })
    expect(String(forbidden).replace('send_mail', 'X')).toBe(
      String(missing).replace('does_not_exist', 'X'),
    )
    expect(audit.events.map((event) => event.type === 'call.rejected' && event.reason)).toEqual([
      'forbidden',
      'unknown_tool',
    ])
  })

  it('returns invalid arguments as a tool error the model can correct', async () => {
    const { tool, handler } = sendMail()
    const { bridge } = setup([tool])
    const result = await call(await connect(bridge, editor), 'send_mail', { to: 'nope' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      [
        'Invalid arguments for send_mail:',
        "- /subject: must have required property 'subject'",
        '- /to: must match format "email"',
      ].join('\n'),
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('shows a ToolError message, and hides other failures', async () => {
    const { bridge } = setup([
      makeTool('find', { handler: () => Promise.reject(new ToolError('No such invoice.')) }),
      makeTool('crash', { handler: () => Promise.reject(new Error('password=hunter2')) }),
    ])
    const client = await connect(bridge, reader)
    expect(await call(client, 'find')).toMatchObject({
      isError: true,
      content: [{ text: 'No such invoice.' }],
    })
    const crash = await call(client, 'crash')
    expect(crash.isError).toBe(true)
    expect(textOf(crash)).not.toContain('hunter2')
  })
})

describe('confirmation without elicitation', () => {
  it('runs nothing and keeps the token out of what the model reads', async () => {
    const { tool, handler } = sendMail()
    const { bridge } = setup([tool])
    const result = await call(await connect(bridge, editor), 'send_mail', mail)

    expect(handler).not.toHaveBeenCalled()
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('Confirmation required: Send "Invoice 12" to ada@example.com')
    expect(result.structuredContent).toEqual({
      status: 'confirmation_required',
      tool: 'send_mail',
      summary: 'Send "Invoice 12" to ada@example.com',
      expiresAt: '2026-10-02T12:05:00.000Z',
    })
    // Everything except _meta may reach the model: no token there.
    expect(JSON.stringify({ ...result, _meta: undefined })).not.toContain('mtb_')
    expect(result._meta?.[CONFIRMATION_META_KEY]).toMatchObject({
      token: expect.stringMatching(/^mtb_/) as unknown,
      expiresAt: '2026-10-02T12:05:00.000Z',
    })
  })

  it('runs the call when the host repeats it with the token in _meta', async () => {
    const { tool, handler } = sendMail()
    const { bridge, trail } = setup([tool])
    const client = await connect(bridge, editor)
    const pending = await call(client, 'send_mail', mail)
    const entry = pending._meta?.[CONFIRMATION_META_KEY] as { token: string }

    const done = await call(client, 'send_mail', mail, {
      [CONFIRMATION_META_KEY]: { token: entry.token },
    })
    expect(done).toMatchObject({ content: [{ text: 'Sent.' }] })
    expect(handler).toHaveBeenCalledOnce()
    expect(trail()).toEqual(['confirmation.issued', 'call.started', 'call.succeeded'])

    const again = await call(client, 'send_mail', mail, {
      [CONFIRMATION_META_KEY]: { token: entry.token },
    })
    expect(again.isError).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('ignores a token the model slipped into the arguments', async () => {
    // An open schema, so that the extra argument is not what stops the call.
    const handler = vi.fn(() => Promise.resolve('Sent.'))
    const open = defineTool({
      ...baseDefinition('send_mail'),
      args: jsonSchema({ type: 'object', properties: { to: { type: 'string' } } }),
      sensitivity: 'high',
      roles: ['editor'],
      handler,
    })
    const { bridge } = setup([open])
    const client = await connect(bridge, editor)
    const pending = await call(client, 'send_mail', { to: 'ada@example.com' })
    const { token } = pending._meta?.[CONFIRMATION_META_KEY] as { token: string }

    const smuggled = await call(client, 'send_mail', {
      to: 'ada@example.com',
      _meta: { [CONFIRMATION_META_KEY]: { token } },
      confirmationToken: token,
    })
    expect(smuggled.structuredContent).toMatchObject({ status: 'confirmation_required' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('leaves the token to the host when elicitation is turned off', async () => {
    const { tool, handler } = sendMail()
    const { bridge } = setup([tool])
    const onElicit = vi.fn(() =>
      Promise.resolve<ElicitResult>({ action: 'accept', content: { confirm: true } }),
    )
    const client = await connect(bridge, editor, {
      capabilities: { elicitation: { form: {} } },
      onElicit,
      elicitConfirmations: false,
    })
    const result = await call(client, 'send_mail', mail)
    expect(result.structuredContent).toMatchObject({ status: 'confirmation_required' })
    expect(onElicit).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('confirmation through elicitation', () => {
  const capabilities: ClientCapabilities = { elicitation: { form: {} } }

  it('asks the user and runs the call on a yes', async () => {
    const { tool, handler } = sendMail()
    const { bridge, audit } = setup([tool])
    const onElicit = vi.fn(() =>
      Promise.resolve<ElicitResult>({ action: 'accept', content: { confirm: true } }),
    )
    const result = await call(
      await connect(bridge, editor, { capabilities, onElicit }),
      'send_mail',
      mail,
    )

    expect(onElicit).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ content: [{ text: 'Sent.' }] })
    expect(handler).toHaveBeenCalledOnce()
    expect(audit.events.map((event) => event.type)).toEqual([
      'confirmation.issued',
      'call.started',
      'call.succeeded',
    ])
    expect(audit.events[1]).toMatchObject({ confirmed: true })
  })

  it.each<[string, ElicitResult]>([
    ['declines', { action: 'decline' }],
    ['dismisses the question', { action: 'cancel' }],
    ['answers no', { action: 'accept', content: { confirm: false } }],
  ])('runs nothing when the user %s', async (_label, answer) => {
    const { tool, handler } = sendMail()
    const { bridge, trail } = setup([tool])
    const client = await connect(bridge, editor, {
      capabilities,
      onElicit: () => Promise.resolve(answer),
    })
    const result = await call(client, 'send_mail', mail)

    expect(handler).not.toHaveBeenCalled()
    expect(textOf(result)).toContain('The user declined')
    expect(result.structuredContent).toEqual({ status: 'declined', tool: 'send_mail' })
    expect(trail()).toEqual(['confirmation.issued', 'confirmation.declined'])
  })

  it('falls back to the token when the client cannot answer', async () => {
    const { tool, handler } = sendMail()
    const { bridge } = setup([tool])
    const client = await connect(bridge, editor, {
      capabilities,
      onElicit: () => Promise.reject(new Error('no UI available')),
    })
    const result = await call(client, 'send_mail', mail)
    expect(result.structuredContent).toMatchObject({ status: 'confirmation_required' })
    expect(result._meta?.[CONFIRMATION_META_KEY]).toBeDefined()
    expect(JSON.stringify({ ...result, _meta: undefined })).not.toContain('mtb_')
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not ask a client that did not declare elicitation', async () => {
    const { tool } = sendMail()
    const { bridge } = setup([tool])
    const result = await call(await connect(bridge, editor), 'send_mail', mail)
    expect(result.structuredContent).toMatchObject({ status: 'confirmation_required' })
  })
})
