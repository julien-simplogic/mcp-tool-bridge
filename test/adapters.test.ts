import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  adapt,
  defineTool,
  envelope,
  importDefinitions,
  json,
  jsonSchema,
  text,
  ToolDefinitionError,
  ToolError,
} from '../src/index.js'
import { baseDefinition, editor, nobody, reader, setup } from './helpers.js'

/** The shape of many existing integrations: failure reported in the return value. */
interface Legacy {
  readonly success: boolean
  readonly data?: { readonly id: string }
  readonly error?: string
}

const fromLegacy = envelope<Legacy>({
  ok: (result) => result.success,
  value: (result) => json({ id: result.data?.id ?? null }),
  message: (result) => result.error ?? 'The operation failed.',
})

describe('envelope', () => {
  it('turns a successful envelope into the tool output', () => {
    expect(fromLegacy({ success: true, data: { id: 'x1' } })).toEqual(json({ id: 'x1' }))
  })

  it('turns a failed envelope into a ToolError carrying the chosen message', () => {
    expect(() => fromLegacy({ success: false, error: 'Quota exceeded.' })).toThrow(ToolError)
    expect(() => fromLegacy({ success: false, error: 'Quota exceeded.' })).toThrow(
      'Quota exceeded.',
    )
    expect(() => fromLegacy({ success: false })).toThrow('The operation failed.')
  })

  it('works with other envelope shapes', () => {
    const fromAction = envelope<{ ok: boolean; detail: string }>({
      ok: (result) => result.ok,
      value: (result) => text(result.detail),
      message: (result) => result.detail,
    })
    expect(fromAction({ ok: true, detail: 'Archived.' })).toEqual(text('Archived.'))
    expect(() => fromAction({ ok: false, detail: 'Already archived.' })).toThrow(
      'Already archived.',
    )
  })

  it('lets the bridge report a failed envelope as an error the model may read', async () => {
    const legacyCreate = (name: string): Promise<Legacy> =>
      Promise.resolve(
        name === 'taken'
          ? { success: false, error: 'That name is taken.' }
          : { success: true, data: { id: 'c1' } },
      )
    const create = defineTool({
      ...baseDefinition('create_customer'),
      args: jsonSchema({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      }),
      sensitivity: 'low',
      handler: async ({ name }) => fromLegacy(await legacyCreate(name)),
    })
    const { bridge, audit } = setup([create])

    expect(
      await bridge.callTool(reader, { name: 'create_customer', arguments: { name: 'Ada' } }),
    ).toMatchObject({
      status: 'ok',
      result: { structuredContent: { id: 'c1' } },
    })
    expect(
      await bridge.callTool(reader, { name: 'create_customer', arguments: { name: 'taken' } }),
    ).toMatchObject({
      status: 'tool_error',
      message: 'That name is taken.',
    })
    expect(audit.events.at(-1)).toMatchObject({
      type: 'call.failed',
      error: { kind: 'tool_error', message: 'That name is taken.' },
    })
  })
})

describe('adapt', () => {
  /** Stands for an existing integration: its own input shape, its own envelope. */
  interface LegacyAction {
    readonly userId: string
    readonly data: string
  }
  const calls: LegacyAction[] = []
  const legacyExecute = (action: LegacyAction): Promise<Legacy> => {
    calls.push(action)
    const { invoiceId } = JSON.parse(action.data) as { invoiceId: string }
    return Promise.resolve(
      invoiceId === 'INV-0'
        ? { success: false, error: 'Unknown invoice.' }
        : { success: true, data: { id: invoiceId } },
    )
  }

  const invoiceArgs = jsonSchema({
    type: 'object',
    properties: { invoiceId: { type: 'string' } },
    required: ['invoiceId'],
    additionalProperties: false,
  })

  const resend = defineTool({
    ...baseDefinition('resend_invoice'),
    args: invoiceArgs,
    sensitivity: 'low',
    handler: adapt(legacyExecute, {
      input: (args, call) => {
        expectTypeOf(args).toEqualTypeOf<{ invoiceId: string }>()
        return { userId: call.principal.id, data: JSON.stringify({ service: 'billing', ...args }) }
      },
      output: fromLegacy,
    }),
  })

  it('maps validated arguments to the existing input, and its result back', async () => {
    calls.length = 0
    const { bridge } = setup([resend])
    expect(
      await bridge.callTool(reader, { name: 'resend_invoice', arguments: { invoiceId: 'INV-7' } }),
    ).toMatchObject({ status: 'ok', result: { structuredContent: { id: 'INV-7' } } })
    expect(calls).toEqual([{ userId: 'alice', data: '{"service":"billing","invoiceId":"INV-7"}' }])
  })

  it('never calls the existing function with invalid arguments', async () => {
    calls.length = 0
    const { bridge } = setup([resend])
    expect(
      await bridge.callTool(reader, { name: 'resend_invoice', arguments: { invoice: 'INV-7' } }),
    ).toMatchObject({ status: 'invalid_arguments' })
    expect(calls).toEqual([])
  })

  it('reports a failed envelope as an error the model may read', async () => {
    const { bridge } = setup([resend])
    expect(
      await bridge.callTool(reader, { name: 'resend_invoice', arguments: { invoiceId: 'INV-0' } }),
    ).toMatchObject({ status: 'tool_error', message: 'Unknown invoice.' })
  })

  it('keeps what the existing function throws away from the model', async () => {
    const crashing = defineTool({
      ...baseDefinition('crash'),
      handler: adapt(
        (): Promise<Legacy> => Promise.reject(new Error('ECONNREFUSED db.internal:5432')),
        { input: () => undefined, output: fromLegacy },
      ),
    })
    const { bridge } = setup([crashing])
    const outcome = await bridge.callTool(reader, { name: 'crash' })
    expect(outcome.status).toBe('tool_error')
    expect(JSON.stringify(outcome)).not.toContain('db.internal')
  })
})

describe('importDefinitions', () => {
  const schema = {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false,
  }
  const governance = {
    sensitivity: 'none',
    reversible: true,
    roles: ['reader'],
  } as const

  it.each<[string, unknown]>([
    ['Anthropic', { name: 'search', description: 'Searches.', input_schema: schema }],
    ['MCP', { name: 'search', description: 'Searches.', inputSchema: schema }],
    [
      'OpenAI chat completions',
      {
        type: 'function',
        function: { name: 'search', description: 'Searches.', parameters: schema },
      },
    ],
    [
      'OpenAI responses',
      { type: 'function', name: 'search', description: 'Searches.', parameters: schema },
    ],
  ])('reads the %s format', async (_label, definition) => {
    const dispatch = vi.fn((name: string, args: unknown) =>
      Promise.resolve(`${name}: ${JSON.stringify(args)}`),
    )
    const [tool] = importDefinitions([definition], dispatch, { search: governance })
    if (!tool) throw new Error('expected one tool')
    expect(tool).toMatchObject({ name: 'search', description: 'Searches.', sensitivity: 'none' })
    expect(tool.inputSchema).toEqual(schema)

    const { bridge } = setup([tool])
    expect(
      await bridge.callTool(reader, { name: 'search', arguments: { query: 'van' } }),
    ).toMatchObject({ status: 'ok', result: { content: [{ text: 'search: {"query":"van"}' }] } })
    expect(dispatch).toHaveBeenCalledWith('search', { query: 'van' }, expect.anything())
  })

  it('validates the imported schema before dispatching', async () => {
    const dispatch = vi.fn(() => Promise.resolve('ran'))
    const tools = importDefinitions(
      [{ name: 'search', description: 'Searches.', input_schema: schema }],
      dispatch,
      { search: governance },
    )
    const { bridge } = setup(tools)
    expect(
      await bridge.callTool(reader, { name: 'search', arguments: { query: '' } }),
    ).toMatchObject({ status: 'invalid_arguments', issues: [{ path: '/query' }] })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('gives a tool without parameters a schema that accepts nothing', async () => {
    const tools = importDefinitions(
      [{ name: 'ping', description: 'Pings.' }],
      () => Promise.resolve('pong'),
      { ping: governance },
    )
    const { bridge } = setup(tools)
    expect((await bridge.callTool(reader, { name: 'ping' })).status).toBe('ok')
    expect((await bridge.callTool(reader, { name: 'ping', arguments: { extra: 1 } })).status).toBe(
      'invalid_arguments',
    )
  })

  it('applies the declared governance: roles and the confirmation guard', async () => {
    const dispatch = vi.fn(() => Promise.resolve('sent'))
    const tools = importDefinitions(
      [{ name: 'send', description: 'Sends.', input_schema: schema }],
      dispatch,
      { send: { sensitivity: 'high', reversible: false, roles: ['editor'] } },
    )
    const { bridge } = setup(tools)
    expect(
      await bridge.callTool(reader, { name: 'send', arguments: { query: 'x' } }),
    ).toMatchObject({ status: 'rejected', reason: 'unknown_tool' })
    expect(
      await bridge.callTool(editor, { name: 'send', arguments: { query: 'x' } }),
    ).toMatchObject({ status: 'confirmation_required' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses to start while a tool has no governance, naming every one', () => {
    let caught: unknown
    try {
      importDefinitions(
        [
          { name: 'a', description: 'A.' },
          { name: 'b', description: 'B.' },
          { name: 'c', description: 'C.' },
        ],
        () => Promise.resolve('x'),
        { b: governance },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ToolDefinitionError)
    expect(caught).toMatchObject({ code: 'missing_governance' })
    expect(String(caught)).toContain('a, c')
  })

  it('starts none of the tools while one of them is unclassified', async () => {
    const dispatch = vi.fn(() => Promise.resolve('ran'))
    let tools: unknown[] = []
    try {
      tools = importDefinitions(
        [
          { name: 'search', description: 'Searches.', input_schema: schema },
          { name: 'wipe', description: 'Deletes everything.' },
        ],
        dispatch,
        { search: governance },
      )
    } catch {
      // Expected: nothing is returned, so nothing can be registered.
    }
    expect(tools).toEqual([])
    const { bridge } = setup([])
    expect(await bridge.callTool(nobody, { name: 'wipe' })).toMatchObject({
      reason: 'unknown_tool',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each<[string, unknown[], Record<string, unknown>, string]>([
    [
      'governance for a tool that does not exist',
      [{ name: 'a', description: 'A.' }],
      { a: governance, aa: governance },
      'unknown_governance',
    ],
    [
      'two definitions with one name',
      [
        { name: 'a', description: 'A.' },
        { name: 'a', description: 'A again.' },
      ],
      { a: governance },
      'duplicate_name',
    ],
    ['a definition without description', [{ name: 'a' }], { a: governance }, 'invalid_description'],
    ['a definition without name', [{ description: 'A.' }], {}, 'invalid_name'],
    ['a definition that is not an object', ['a'], {}, 'invalid_definition'],
    [
      'an invalid sensitivity',
      [{ name: 'a', description: 'A.' }],
      { a: { ...governance, sensitivity: 'extreme' } },
      'invalid_sensitivity',
    ],
    [
      'empty roles',
      [{ name: 'a', description: 'A.' }],
      { a: { ...governance, roles: [] } },
      'invalid_roles',
    ],
    [
      'a schema Ajv strict mode rejects',
      [{ name: 'a', description: 'A.', input_schema: { type: 'object', minProps: 1 } }],
      { a: governance },
      'invalid_schema',
    ],
    [
      'a schema whose root is not an object',
      [{ name: 'a', description: 'A.', input_schema: { type: 'string' } }],
      { a: governance },
      'invalid_schema',
    ],
  ])('refuses %s', (_label, definitions, rules, code) => {
    expect(() =>
      importDefinitions(definitions, () => Promise.resolve('x'), rules as Record<string, never>),
    ).toThrow(expect.objectContaining({ code }) as Error)
  })
})
