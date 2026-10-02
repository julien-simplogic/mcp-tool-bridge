import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineTool,
  isSecretKey,
  jsonSchema,
  json,
  redact,
  REDACTED,
  stderrJsonSink,
  text,
  ToolError,
  type AuditEvent,
} from '../src/index.js'
import { auditResult, MAX_AUDITED_TEXT } from '../src/audit/redact.js'
import { baseDefinition, editor, makeTool, reader, setup } from './helpers.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('redaction', () => {
  it.each([
    'password',
    'apiKey',
    'API_KEY',
    'x-api-key',
    'client_secret',
    'accessToken',
    'Authorization',
    'set-cookie',
  ])('masks %s', (key) => {
    expect(isSecretKey(key)).toBe(true)
  })

  it.each(['to', 'subject', 'invoiceId', 'amount'])('keeps %s', (key) => {
    expect(isSecretKey(key)).toBe(false)
  })

  it('masks secret keys at any depth, and in arrays', () => {
    expect(
      redact({ to: 'ada', auth: { password: 'hunter2', user: 'ada' }, keys: [{ apiKey: 'k1' }] }),
    ).toEqual({
      to: 'ada',
      auth: { password: REDACTED, user: 'ada' },
      keys: [{ apiKey: REDACTED }],
    })
  })

  it('masks the JSON Pointers a tool declares', () => {
    const value = { card: { number: '4242', exp: '12/30' }, items: ['a', 'b'], 'x/y': 1 }
    expect(redact(value, ['/card/number', '/items/1', '/x~1y'])).toEqual({
      card: { number: REDACTED, exp: '12/30' },
      items: ['a', REDACTED],
      'x/y': REDACTED,
    })
  })

  it('ignores pointers that point nowhere, and leaves its input untouched', () => {
    const value = { card: { exp: '12/30' }, items: ['a'] }
    const before = JSON.stringify(value)
    expect(redact(value, ['/card/number', '/items/5', '/items/-', '/missing/deep'])).toEqual(value)
    expect(JSON.stringify(value)).toBe(before)
  })
})

describe('auditResult', () => {
  it('keeps text, cut to a bound', () => {
    const audited = auditResult(text('x'.repeat(MAX_AUDITED_TEXT + 10)))
    expect(audited.truncated).toBe(true)
    expect(audited.text).toHaveLength(MAX_AUDITED_TEXT + 1)
  })

  it('describes binary content instead of copying it', () => {
    const audited = auditResult({
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    })
    expect(audited.text).toBe('[image image/png]')
  })

  it('masks structured content too', () => {
    const audited = auditResult(json({ id: 'u1', token: 'abc' }))
    expect(audited.structuredContent).toEqual({ id: 'u1', token: REDACTED })
  })
})

describe('the audit trail of a call', () => {
  const mailArgs = jsonSchema({
    type: 'object',
    properties: { to: { type: 'string' }, password: { type: 'string' }, body: { type: 'string' } },
    required: ['to'],
  })

  it('records who called what, with which arguments and which result', async () => {
    const mail = defineTool({
      ...baseDefinition('send_mail'),
      args: mailArgs,
      sensitivity: 'low',
      redact: ['/body'],
      handler: () => Promise.resolve(json({ messageId: 'm-1' })),
    })
    const { bridge, audit, advance } = setup([mail], {
      context: () => {
        advance(25)
        return undefined
      },
    })

    const outcome = await bridge.callTool(
      reader,
      { name: 'send_mail', arguments: { to: 'ada@example.com', password: 'p', body: 'private' } },
      { transport: 'stdio' },
    )
    expect(outcome.status).toBe('ok')

    const [started, succeeded] = audit.events
    const common = {
      callId: outcome.callId,
      transport: 'stdio',
      principal: { id: 'alice', roles: ['reader'] },
      tool: 'send_mail',
      args: { to: 'ada@example.com', password: REDACTED, body: REDACTED },
    }
    expect(started).toMatchObject({ type: 'call.started', confirmed: false, ...common })
    expect(succeeded).toMatchObject({
      type: 'call.succeeded',
      confirmed: false,
      result: {
        text: '{"messageId":"m-1"}',
        structuredContent: { messageId: 'm-1' },
        isError: false,
      },
      ...common,
    })
    expect(started?.id).not.toBe(succeeded?.id)
    expect(started?.at).toBe('2026-10-02T12:00:00.025Z')
  })

  it('defaults the transport to direct', async () => {
    const { bridge, audit } = setup([makeTool('ping')])
    await bridge.callTool(reader, { name: 'ping' })
    expect(audit.events[0]?.transport).toBe('direct')
  })

  it('tells the model a ToolError message, and nothing of other exceptions', async () => {
    const known = makeTool('find_invoice', {
      handler: () => Promise.reject(new ToolError('No invoice INV-12.')),
    })
    const crash = makeTool('crash', {
      handler: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.3:5432')),
    })
    const { bridge, audit } = setup([known, crash])

    expect(await bridge.callTool(reader, { name: 'find_invoice' })).toMatchObject({
      status: 'tool_error',
      message: 'No invoice INV-12.',
    })
    const outcome = await bridge.callTool(reader, { name: 'crash' })
    expect(outcome).toMatchObject({ status: 'tool_error' })
    expect(JSON.stringify(outcome)).not.toContain('10.0.0.3')

    const failures = audit.events.filter((event) => event.type === 'call.failed')
    expect(failures.map((event) => event.error)).toEqual([
      { kind: 'tool_error', message: 'No invoice INV-12.' },
      { kind: 'exception', message: 'connect ECONNREFUSED 10.0.0.3:5432' },
    ])
  })

  it('records rejections with their real reason', async () => {
    const admin = makeTool('admin_only', { roles: ['admin'], args: mailArgs })
    const { bridge, audit } = setup([admin])
    await bridge.callTool(reader, { name: 'missing' })
    await bridge.callTool(reader, { name: 'admin_only', arguments: { to: 'x' } })
    await bridge.callTool({ id: 'root', roles: ['admin'] }, { name: 'admin_only', arguments: {} })

    const reasons = audit.events.map((event) =>
      event.type === 'call.rejected' ? event.reason : event.type,
    )
    expect(reasons).toEqual(['unknown_tool', 'forbidden', 'invalid_arguments'])
    expect(audit.events[2]).toMatchObject({ issues: [{ path: '/to' }] })
  })

  describe('when a sink fails', () => {
    const failing = {
      write() {
        throw new Error('disk full')
      },
    }

    it('goes on by default, with a warning on stderr', async () => {
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const handler = vi.fn(() => Promise.resolve('pong'))
      const { bridge } = setup([makeTool('ping', { handler })], { audit: failing })
      expect((await bridge.callTool(reader, { name: 'ping' })).status).toBe('ok')
      expect(handler).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    })

    it('does not run the call in blocking mode', async () => {
      vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const handler = vi.fn(() => Promise.resolve('pong'))
      const { bridge } = setup([makeTool('ping', { handler })], {
        audit: failing,
        auditFailure: 'block',
      })
      expect(await bridge.callTool(reader, { name: 'ping' })).toMatchObject({
        status: 'tool_error',
        message: 'The call was not executed: the audit log is unavailable.',
      })
      expect(handler).not.toHaveBeenCalled()
    })

    it('still writes to the healthy sinks', async () => {
      vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const events: AuditEvent[] = []
      const { bridge } = setup([makeTool('ping')], {
        audit: [failing, { write: (event) => void events.push(event) }],
      })
      await bridge.callTool(editor, { name: 'ping' })
      expect(events.map((event) => event.type)).toEqual(['call.started', 'call.succeeded'])
    })
  })
})

describe('stderrJsonSink', () => {
  it('writes one JSON line per event to stderr, never to stdout', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write')
    const { bridge } = setup([makeTool('ping')], { audit: stderrJsonSink() })
    await bridge.callTool(reader, { name: 'ping' })

    expect(stdout).not.toHaveBeenCalled()
    const lines = stderr.mock.calls.map(([chunk]) => String(chunk))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true)
      expect(JSON.parse(line)).toHaveProperty('callId')
    }
  })
})
