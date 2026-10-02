import { describe, expect, it, vi } from 'vitest'
import {
  defineTool,
  jsonSchema,
  MemoryConfirmationStore,
  requiresConfirmation,
  type CallOutcome,
  type ConfirmationRecord,
  type ConfirmMode,
  type PendingConfirmation,
  type Sensitivity,
} from '../src/index.js'
import { canonicalJson, digestArguments, hashToken, newToken } from '../src/confirmation/token.js'
import { baseDefinition, editor, reader, setup } from './helpers.js'

const invoiceArgs = jsonSchema({
  type: 'object',
  properties: { invoiceId: { type: 'string' }, copyTo: { type: 'string' } },
  required: ['invoiceId'],
  additionalProperties: false,
})

function sendInvoiceTool(handler = vi.fn(() => Promise.resolve('sent'))) {
  const tool = defineTool({
    ...baseDefinition('send_invoice'),
    args: invoiceArgs,
    sensitivity: 'high',
    reversible: false,
    roles: ['reader'],
    summarize: ({ invoiceId }) => `Email invoice ${invoiceId}`,
    handler,
  })
  return { tool, handler }
}

function pending(outcome: CallOutcome): PendingConfirmation {
  if (outcome.status !== 'confirmation_required') {
    throw new Error(`expected a confirmation request, got ${outcome.status}`)
  }
  return outcome.confirmation
}

describe('requiresConfirmation', () => {
  const policy = { threshold: 'high', irreversibleLowersThreshold: true } as const

  it.each<[Sensitivity, boolean, ConfirmMode, boolean]>([
    ['none', true, 'auto', false],
    ['none', false, 'auto', false],
    ['low', true, 'auto', false],
    ['low', false, 'auto', false],
    ['medium', true, 'auto', false],
    ['medium', false, 'auto', true], // irreversible: one level earlier
    ['high', true, 'auto', true],
    ['critical', true, 'auto', true],
    ['none', true, 'always', true],
    ['low', true, 'always', true],
  ])('%s, reversible=%s, confirm=%s → %s', (sensitivity, reversible, confirm, expected) => {
    expect(requiresConfirmation({ sensitivity, reversible, confirm }, policy)).toBe(expected)
  })

  it('follows the configured threshold', () => {
    const tool = { sensitivity: 'medium', reversible: true, confirm: 'auto' } as const
    expect(
      requiresConfirmation(tool, { threshold: 'medium', irreversibleLowersThreshold: true }),
    ).toBe(true)
    expect(
      requiresConfirmation(tool, { threshold: 'critical', irreversibleLowersThreshold: true }),
    ).toBe(false)
  })

  it('can stop irreversibility from lowering the threshold', () => {
    const tool = { sensitivity: 'medium', reversible: false, confirm: 'auto' } as const
    expect(
      requiresConfirmation(tool, { threshold: 'high', irreversibleLowersThreshold: false }),
    ).toBe(false)
  })
})

describe('tokens', () => {
  it('are long, random and recognisable', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => newToken()))
    expect(tokens.size).toBe(100)
    for (const token of tokens) expect(token).toMatch(/^mtb_[A-Za-z0-9_-]{43}$/)
  })

  it('are stored as a hash that does not reveal them', () => {
    const token = newToken()
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).not.toContain(token.slice(4, 12))
  })

  it('bind to the arguments regardless of key order', () => {
    expect(canonicalJson({ b: [1, { d: 2, c: 3 }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":3,"d":2}]}',
    )
    expect(digestArguments({ a: 1, b: 2 })).toBe(digestArguments({ b: 2, a: 1 }))
    expect(digestArguments({ a: 1 })).not.toBe(digestArguments({ a: 2 }))
    expect(digestArguments({ a: '1' })).not.toBe(digestArguments({ a: 1 }))
  })
})

describe('MemoryConfirmationStore', () => {
  const record = (hash: string, expiresAt: number): ConfirmationRecord => ({
    tokenHash: hash,
    callId: `call-${hash}`,
    principalId: 'alice',
    tool: 'send_invoice',
    arguments: {},
    argumentsDigest: digestArguments({}),
    summary: 'x',
    createdAt: 0,
    expiresAt,
  })

  it('hands a record out once', async () => {
    const store = new MemoryConfirmationStore()
    await store.put(record('a', 100))
    expect(await store.take('a')).toMatchObject({ tokenHash: 'a' })
    expect(await store.take('a')).toBeUndefined()
  })

  it('stays bounded: expired records go first, then the oldest', async () => {
    const store = new MemoryConfirmationStore({ maxEntries: 3, now: () => 50 })
    await store.put(record('old', 200))
    await store.put(record('expired', 10))
    await store.put(record('recent', 300))
    await store.put(record('new', 400))
    expect(store.size).toBe(3)
    expect(await store.take('expired')).toBeUndefined()
    expect(await store.take('old')).toBeDefined()

    await store.put(record('newer', 500))
    await store.put(record('newest', 600))
    expect(await store.take('recent')).toBeUndefined()
  })

  it('rejects a nonsensical size', () => {
    expect(() => new MemoryConfirmationStore({ maxEntries: 0 })).toThrow(TypeError)
  })
})

describe('the confirmation guard', () => {
  it('runs tools below the threshold directly', async () => {
    const handler = vi.fn(() => Promise.resolve('moved'))
    const move = defineTool({
      ...baseDefinition('move'),
      sensitivity: 'medium',
      reversible: true,
      handler,
    })
    const { bridge } = setup([move])
    const outcome = await bridge.callTool(reader, { name: 'move', arguments: {} })
    expect(outcome.status).toBe('ok')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('holds a sensitive call back instead of running it', async () => {
    const { tool, handler } = sendInvoiceTool()
    const { bridge, trail } = setup([tool])
    const outcome = await bridge.callTool(reader, {
      name: 'send_invoice',
      arguments: { invoiceId: 'INV-12' },
    })

    expect(outcome).toMatchObject({
      status: 'confirmation_required',
      confirmation: {
        tool: 'send_invoice',
        summary: 'Email invoice INV-12',
        expiresAt: '2026-10-02T12:05:00.000Z',
      },
    })
    expect(handler).not.toHaveBeenCalled()
    expect(trail()).toEqual(['confirmation.issued'])
  })

  it('validates arguments before asking anyone to confirm them', async () => {
    const { tool } = sendInvoiceTool()
    const { bridge } = setup([tool])
    const outcome = await bridge.callTool(reader, { name: 'send_invoice', arguments: {} })
    expect(outcome.status).toBe('invalid_arguments')
  })

  it('runs the call once confirmed, exactly once', async () => {
    const { tool, handler } = sendInvoiceTool()
    const { bridge, trail, audit } = setup([tool])
    const issued = await bridge.callTool(reader, {
      name: 'send_invoice',
      arguments: { invoiceId: 'INV-12' },
    })
    const { token } = pending(issued)

    const first = await bridge.executeConfirmed(reader, token)
    expect(first).toMatchObject({ status: 'ok', callId: issued.callId })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]).toBeDefined()

    const second = await bridge.executeConfirmed(reader, token)
    expect(second).toMatchObject({ status: 'rejected', reason: 'confirmation_invalid' })
    expect(handler).toHaveBeenCalledOnce()

    expect(trail()).toEqual([
      'confirmation.issued',
      'call.started',
      'call.succeeded',
      'call.rejected',
    ])
    const started = audit.events[1]
    expect(started).toMatchObject({ callId: issued.callId, confirmed: true })
  })

  it('lets only one of two concurrent redemptions through', async () => {
    const { tool, handler } = sendInvoiceTool()
    const { bridge } = setup([tool])
    const { token } = pending(
      await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
    )
    const outcomes = await Promise.all([
      bridge.executeConfirmed(reader, token),
      bridge.executeConfirmed(reader, token),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['ok', 'rejected'])
    expect(handler).toHaveBeenCalledOnce()
  })

  it('runs the arguments that were confirmed, not a later copy', async () => {
    const { tool, handler } = sendInvoiceTool()
    const { bridge } = setup([tool])
    const args = { invoiceId: 'INV-12' }
    const { token } = pending(
      await bridge.callTool(reader, { name: 'send_invoice', arguments: args }),
    )
    args.invoiceId = 'INV-99'

    await bridge.executeConfirmed(reader, token)
    expect(handler).toHaveBeenCalledWith({ invoiceId: 'INV-12' }, expect.anything())
  })

  it('expires', async () => {
    const { tool, handler } = sendInvoiceTool()
    const { bridge, advance } = setup([tool], { confirmation: { ttlMs: 60_000 } })
    const { token } = pending(
      await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
    )
    advance(60_000)
    expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
      status: 'rejected',
      reason: 'confirmation_expired',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('belongs to the principal it was issued to, and burns in anyone else’s hands', async () => {
    const { tool, handler } = sendInvoiceTool()
    const { bridge } = setup([tool])
    const { token } = pending(
      await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
    )
    expect(await bridge.executeConfirmed(editor, token)).toMatchObject({
      status: 'rejected',
      reason: 'confirmation_invalid',
    })
    expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
      reason: 'confirmation_invalid',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects unknown and malformed tokens', async () => {
    const { tool } = sendInvoiceTool()
    const { bridge } = setup([tool])
    for (const token of ['', 'mtb_nope', newToken()]) {
      expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
        status: 'rejected',
        reason: 'confirmation_invalid',
      })
    }
  })

  describe('redeemed by repeating the call with the token', () => {
    it('runs when the repeated call is the confirmed one, key order aside', async () => {
      const { tool, handler } = sendInvoiceTool()
      const { bridge } = setup([tool])
      const args = { invoiceId: 'INV-12', copyTo: 'ops@example.com' }
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: args }),
      )

      const outcome = await bridge.callTool(reader, {
        name: 'send_invoice',
        arguments: { copyTo: 'ops@example.com', invoiceId: 'INV-12' },
        confirmationToken: token,
      })
      expect(outcome.status).toBe('ok')
      expect(handler).toHaveBeenCalledOnce()
    })

    it.each<[string, { readonly name: string; readonly arguments: unknown }]>([
      ['other arguments', { name: 'send_invoice', arguments: { invoiceId: 'INV-13' } }],
      ['another tool', { name: 'send_reminder', arguments: { invoiceId: 'INV-12' } }],
      [
        'arguments that are not JSON',
        { name: 'send_invoice', arguments: { invoiceId: new Date() } },
      ],
    ])('refuses %s, and the token is spent', async (_label, request) => {
      const { tool, handler } = sendInvoiceTool()
      const reminder = defineTool({ ...baseDefinition('send_reminder'), args: invoiceArgs })
      const { bridge } = setup([tool, reminder])
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )

      expect(await bridge.callTool(reader, { ...request, confirmationToken: token })).toMatchObject(
        {
          status: 'rejected',
          reason: 'confirmation_invalid',
        },
      )
      expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
        reason: 'confirmation_invalid',
      })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('checks everything again at redemption', () => {
    it('refuses if the principal lost the role in between', async () => {
      const { tool, handler } = sendInvoiceTool()
      const { bridge, audit } = setup([tool])
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )
      const demoted = { id: reader.id, roles: ['guest'] }
      expect(await bridge.executeConfirmed(demoted, token)).toMatchObject({
        status: 'rejected',
        reason: 'unknown_tool',
      })
      expect(audit.events.at(-1)).toMatchObject({ type: 'call.rejected', reason: 'forbidden' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('refuses if the tool was removed in between', async () => {
      const { tool, handler } = sendInvoiceTool()
      const { bridge, registry } = setup([tool])
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )
      registry.unregister('send_invoice')
      expect(await bridge.executeConfirmed(reader, token)).toMatchObject({ reason: 'unknown_tool' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('revalidates against the schema registered now', async () => {
      const { tool } = sendInvoiceTool()
      const { bridge, registry } = setup([tool])
      const { token } = pending(
        await bridge.callTool(reader, {
          name: 'send_invoice',
          arguments: { invoiceId: 'INV-12', copyTo: 'ops@example.com' },
        }),
      )
      registry.unregister('send_invoice')
      registry.register(
        defineTool({
          ...baseDefinition('send_invoice'),
          sensitivity: 'high',
          args: jsonSchema({
            type: 'object',
            properties: { invoiceId: { type: 'string' } },
            additionalProperties: false,
          }),
        }),
      )
      expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
        status: 'invalid_arguments',
      })
    })
  })

  describe('revocation', () => {
    it('withdraws a pending confirmation', async () => {
      const { tool, handler } = sendInvoiceTool()
      const { bridge, trail } = setup([tool])
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )
      expect(await bridge.revokeConfirmation(reader, token)).toBe(true)
      expect(await bridge.revokeConfirmation(reader, token)).toBe(false)
      expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
        reason: 'confirmation_invalid',
      })
      expect(handler).not.toHaveBeenCalled()
      expect(trail()).toEqual(['confirmation.issued', 'confirmation.declined', 'call.rejected'])
    })

    it('does not let someone else withdraw it, and spends it all the same', async () => {
      const { tool } = sendInvoiceTool()
      const { bridge } = setup([tool])
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )
      expect(await bridge.revokeConfirmation(editor, token)).toBe(false)
      expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
        reason: 'confirmation_invalid',
      })
    })
  })

  describe('keeps the token out of the record', () => {
    it('stores only its hash', async () => {
      const { tool } = sendInvoiceTool()
      const store = new MemoryConfirmationStore()
      const put = vi.spyOn(store, 'put')
      const { bridge } = setup([tool], { confirmation: { store } })
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )
      const stored = put.mock.calls[0]?.[0]
      expect(stored?.tokenHash).toBe(hashToken(token))
      expect(JSON.stringify(stored)).not.toContain(token)
    })

    it('never writes it to the audit log', async () => {
      const { tool } = sendInvoiceTool()
      const { bridge, audit } = setup([tool])
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )
      await bridge.callTool(reader, {
        name: 'send_invoice',
        arguments: { invoiceId: 'INV-12' },
        confirmationToken: token,
      })
      expect(JSON.stringify(audit.events)).not.toContain(token)
    })
  })

  it('issues no confirmation the audit log could not record, when auditing blocks', async () => {
    const { tool } = sendInvoiceTool()
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const store = new MemoryConfirmationStore()
    const { bridge } = setup([tool], {
      confirmation: { store },
      audit: {
        write() {
          throw new Error('disk full')
        },
      },
      auditFailure: 'block',
    })
    const outcome = await bridge.callTool(reader, {
      name: 'send_invoice',
      arguments: { invoiceId: 'INV-12' },
    })
    expect(outcome.status === 'tool_error' && outcome.message).toBe(
      'The call was not executed: the audit log is unavailable.',
    )
    expect(store.size).toBe(0)
    vi.restoreAllMocks()
  })
})
