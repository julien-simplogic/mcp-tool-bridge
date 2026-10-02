import { describe, expect, it, vi } from 'vitest'
import {
  defineTool,
  jsonSchema,
  MemoryConfirmationStore,
  requiresConfirmation,
  type CallOutcome,
  type ConfirmationRecord,
  type ConfirmationStore,
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

  it('hands a record out once, then says it was consumed', async () => {
    const store = new MemoryConfirmationStore()
    await store.put(record('a', 100))
    expect(await store.take('a', 50)).toMatchObject({ status: 'taken', record: { tokenHash: 'a' } })
    expect(await store.take('a', 51)).toEqual({ status: 'consumed' })
    expect(await store.take('never-issued', 51)).toEqual({ status: 'unknown' })
  })

  it('checks the expiry in the same step as the take, and consumes the token anyway', async () => {
    const store = new MemoryConfirmationStore()
    await store.put(record('a', 100))
    expect(await store.take('a', 100)).toMatchObject({
      status: 'expired',
      record: { tokenHash: 'a' },
    })
    expect(await store.take('a', 101)).toEqual({ status: 'consumed' })
  })

  it('stays bounded: expired records go first, then the oldest', async () => {
    const store = new MemoryConfirmationStore({ maxEntries: 3, now: () => 50 })
    await store.put(record('old', 200))
    await store.put(record('expired', 10))
    await store.put(record('recent', 300))
    await store.put(record('new', 400))
    expect(store.size).toBe(3)
    // Evicted after expiry: still known as expired, once, then consumed.
    expect(await store.take('expired', 50)).toEqual({ status: 'expired' })
    expect(await store.take('expired', 50)).toEqual({ status: 'consumed' })
    expect(await store.take('old', 50)).toMatchObject({ status: 'taken' })

    await store.put(record('newer', 500))
    await store.put(record('newest', 600))
    expect(await store.take('recent', 50)).toEqual({ status: 'unknown' })
  })

  it('remembers consumed tokens within a bound: a maximum size, and a retention after expiry', async () => {
    let now = 0
    const store = new MemoryConfirmationStore({
      maxConsumed: 2,
      consumedRetentionMs: 1000,
      now: () => now,
    })
    for (const hash of ['a', 'b', 'c']) {
      await store.put(record(hash, 100))
      await store.take(hash, now)
    }
    expect(store.consumedSize).toBe(2)
    expect(await store.take('a', now)).toEqual({ status: 'unknown' }) // the oldest went first
    expect(await store.take('c', now)).toEqual({ status: 'consumed' })

    now = 1101 // past expiry + retention
    await store.put(record('d', 2000))
    expect(store.consumedSize).toBe(0)
    expect(await store.take('c', now)).toEqual({ status: 'unknown' })
  })

  it('rejects nonsensical bounds', () => {
    expect(() => new MemoryConfirmationStore({ maxEntries: 0 })).toThrow(TypeError)
    expect(() => new MemoryConfirmationStore({ maxConsumed: -1 })).toThrow(TypeError)
    expect(() => new MemoryConfirmationStore({ consumedRetentionMs: 1.5 })).toThrow(TypeError)
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

    it('refuses a repeated call carrying the token once the role is gone', async () => {
      const { tool, handler } = sendInvoiceTool()
      const { bridge } = setup([tool])
      const args = { invoiceId: 'INV-12' }
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: args }),
      )
      const demoted = { id: reader.id, roles: ['guest'] }
      expect(
        await bridge.callTool(demoted, {
          name: 'send_invoice',
          arguments: args,
          confirmationToken: token,
        }),
      ).toMatchObject({ status: 'rejected', reason: 'unknown_tool' })
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
      const { bridge, trail, audit } = setup([tool])
      const { token } = pending(
        await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
      )
      expect(await bridge.revokeConfirmation(reader, token)).toBe(true)
      expect(await bridge.revokeConfirmation(reader, token)).toBe(false)
      expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
        reason: 'confirmation_invalid',
      })
      expect(handler).not.toHaveBeenCalled()
      // Every later presentation of the spent token is recorded, with its reason.
      expect(trail()).toEqual([
        'confirmation.issued',
        'confirmation.declined',
        'call.rejected',
        'call.rejected',
      ])
      expect(audit.events.slice(2).map((e) => e.type === 'call.rejected' && e.detail)).toEqual([
        'consumed',
        'consumed',
      ])
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

describe('confirmation lifetimes, per class of tool', () => {
  const HOUR = 3_600_000
  const TABLE = {
    medium: { reversible: 24 * HOUR, irreversible: 12 * HOUR },
    high: { reversible: 12 * HOUR, irreversible: 4 * HOUR },
    critical: { reversible: 4 * HOUR, irreversible: HOUR },
  }
  const START = Date.UTC(2026, 9, 2, 12, 0, 0)
  const tool = (name: string, sensitivity: Sensitivity, reversible: boolean, confirm?: 'always') =>
    defineTool({
      ...baseDefinition(name),
      sensitivity,
      reversible,
      ...(confirm === undefined ? {} : { confirm }),
    })

  it.each<[Sensitivity, boolean, number]>([
    ['critical', false, HOUR],
    ['critical', true, 4 * HOUR],
    ['high', false, 4 * HOUR],
    ['high', true, 12 * HOUR],
    ['medium', false, 12 * HOUR],
  ])('%s, reversible=%s → %d ms', async (sensitivity, reversible, ttl) => {
    const { bridge } = setup([tool('act', sensitivity, reversible)], {
      confirmation: { ttlMs: TABLE },
    })
    const { expiresAt } = pending(await bridge.callTool(reader, { name: 'act' }))
    expect(Date.parse(expiresAt) - START).toBe(ttl)
  })

  it('falls back to 5 minutes for a class the table leaves out', async () => {
    const { bridge } = setup([tool('note', 'low', true, 'always')], {
      confirmation: { ttlMs: TABLE },
    })
    const { expiresAt } = pending(await bridge.callTool(reader, { name: 'note' }))
    expect(Date.parse(expiresAt) - START).toBe(5 * 60_000)
  })

  it('keeps the expiry stored at issue time, whatever the configuration says later', async () => {
    const store = new MemoryConfirmationStore()
    const wipe = tool('wipe', 'high', false)
    const issuer = setup([wipe], { confirmation: { ttlMs: TABLE, store } })
    const { token } = pending(await issuer.bridge.callTool(reader, { name: 'wipe' }))

    // Same store, a stricter configuration (1 h): the 4 h already granted still hold.
    const stricter = setup([wipe], { confirmation: { ttlMs: HOUR, store } })
    stricter.advance(2 * HOUR)
    expect(await stricter.bridge.executeConfirmed(reader, token)).toMatchObject({ status: 'ok' })
  })

  it('refuses an expired token even if the store forgets to check', async () => {
    const records = new Map<string, ConfirmationRecord>()
    const lax: ConfirmationStore = {
      put: (record) => {
        records.set(record.tokenHash, record)
        return Promise.resolve()
      },
      take: (hash) => {
        const record = records.get(hash)
        records.delete(hash)
        return Promise.resolve(record ? { status: 'taken', record } : { status: 'unknown' })
      },
    }
    const { tool: send, handler } = sendInvoiceTool()
    const { bridge, advance, audit } = setup([send], { confirmation: { store: lax } })
    const { token } = pending(
      await bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
    )
    advance(5 * 60_000)
    expect(await bridge.executeConfirmed(reader, token)).toMatchObject({
      reason: 'confirmation_expired',
    })
    expect(handler).not.toHaveBeenCalled()
    expect(audit.events.at(-1)).toMatchObject({ type: 'call.rejected', detail: 'expired' })
  })
})

describe('every refused token leaves its reason in the audit, and only there', () => {
  async function issued() {
    const { tool, handler } = sendInvoiceTool()
    const reminder = defineTool({ ...baseDefinition('send_reminder'), args: invoiceArgs })
    const h = setup([tool, reminder])
    const { token } = pending(
      await h.bridge.callTool(reader, { name: 'send_invoice', arguments: { invoiceId: 'INV-12' } }),
    )
    const lastDetail = () => {
      const last = h.audit.events.at(-1)
      return last?.type === 'call.rejected' ? last.detail : undefined
    }
    return { ...h, token, handler, lastDetail }
  }

  it('unknown', async () => {
    const h = await issued()
    expect(await h.bridge.executeConfirmed(reader, newToken())).toMatchObject({
      reason: 'confirmation_invalid',
    })
    expect(h.lastDetail()).toBe('unknown')
  })
  it('consumed', async () => {
    const h = await issued()
    await h.bridge.executeConfirmed(reader, h.token)
    expect(await h.bridge.executeConfirmed(reader, h.token)).toMatchObject({
      reason: 'confirmation_invalid',
    })
    expect(h.lastDetail()).toBe('consumed')
  })
  it('expired', async () => {
    const h = await issued()
    h.advance(5 * 60_000)
    expect(await h.bridge.executeConfirmed(reader, h.token)).toMatchObject({
      reason: 'confirmation_expired',
    })
    expect(h.lastDetail()).toBe('expired')
  })
  it('another principal', async () => {
    const h = await issued()
    expect(await h.bridge.executeConfirmed(editor, h.token)).toMatchObject({
      reason: 'confirmation_invalid',
    })
    expect(h.lastDetail()).toBe('principal_mismatch')
  })
  it('another tool', async () => {
    const h = await issued()
    const out = await h.bridge.callTool(reader, {
      name: 'send_reminder',
      arguments: { invoiceId: 'INV-12' },
      confirmationToken: h.token,
    })
    expect(out).toMatchObject({ reason: 'confirmation_invalid' })
    expect(h.lastDetail()).toBe('tool_mismatch')
  })
  it('other arguments', async () => {
    const h = await issued()
    const out = await h.bridge.callTool(reader, {
      name: 'send_invoice',
      arguments: { invoiceId: 'INV-13' },
      confirmationToken: h.token,
    })
    expect(out).toMatchObject({ reason: 'confirmation_invalid' })
    expect(h.lastDetail()).toBe('arguments_mismatch')
    expect(h.handler).not.toHaveBeenCalled()
  })
  it('an expired token in someone else’s hands reads as invalid, not as expired', async () => {
    const h = await issued()
    h.advance(5 * 60_000)
    expect(await h.bridge.executeConfirmed(editor, h.token)).toMatchObject({
      reason: 'confirmation_invalid',
    })
    expect(h.lastDetail()).toBe('principal_mismatch')
  })
})
