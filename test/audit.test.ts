import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineTool,
  isSecretKey,
  jsonSchema,
  json,
  REDACTED,
  stderrJsonSink,
  text,
  ToolError,
  type AuditEvent,
} from '../src/index.js'
import { auditResult, keepDeclared, MAX_KEPT_ITEMS, MAX_KEPT_STRING } from '../src/audit/redact.js'
import { digestArguments } from '../src/confirmation/token.js'
import { baseDefinition, editor, makeTool, reader, setup } from './helpers.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('secret-looking keys', () => {
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
})

describe('keepDeclared: only what a tool declared, nothing else', () => {
  const mail = {
    messageId: 'm-1',
    from: 'ada@example.com',
    body: 'private',
    attachments: [
      { name: 'a.pdf', token: 't1' },
      { name: 'b.pdf', token: 't2' },
    ],
    'x/y': 1,
  }

  it('keeps nothing when nothing is declared', () => {
    expect(keepDeclared(mail, [])).toBeUndefined()
  })

  it('keeps the declared fields, keyed by their pointer, and nothing else', () => {
    const kept = keepDeclared(mail, ['/messageId'])
    expect(kept).toEqual({ '/messageId': 'm-1' })
    expect(JSON.stringify(kept)).not.toContain('private')
  })

  it('collects every match of a * segment', () => {
    expect(keepDeclared(mail, ['/attachments/*/name'])).toEqual({
      '/attachments/*/name': ['a.pdf', 'b.pdf'],
    })
  })

  it('masks secret-looking keys inside a kept value, and a pointer that names one', () => {
    expect(keepDeclared(mail, ['/attachments/0'])).toEqual({
      '/attachments/0': { name: 'a.pdf', token: REDACTED },
    })
    expect(keepDeclared({ apiKey: 'k1' }, ['/apiKey'])).toEqual({ '/apiKey': REDACTED })
  })

  it('bounds what it keeps: long strings cut, matches capped', () => {
    const long = keepDeclared({ note: 'x'.repeat(MAX_KEPT_STRING + 50) }, ['/note'])
    expect(long?.['/note']).toHaveLength(MAX_KEPT_STRING + 1)
    const many = keepDeclared({ ids: Array.from({ length: 300 }, (_, i) => i) }, ['/ids/*'])
    expect(many?.['/ids/*']).toHaveLength(MAX_KEPT_ITEMS)
  })

  it('skips pointers that point nowhere, reads escaped keys, and leaves its input untouched', () => {
    const before = JSON.stringify(mail)
    expect(keepDeclared(mail, ['/missing', '/attachments/9', '/x~1y'])).toEqual({ '/x~1y': 1 })
    expect(JSON.stringify(mail)).toBe(before)
  })
})

describe('auditResult: no result content unless declared', () => {
  it('keeps only the error flag by default: no text, no structured content', () => {
    expect(auditResult(json({ id: 'u1', body: 'private' }), [])).toEqual({ isError: false })
    expect(auditResult(text('a long private answer'), [])).toEqual({ isError: false })
    expect(auditResult({ content: [{ type: 'text', text: 'boom' }], isError: true }, [])).toEqual({
      isError: true,
    })
  })

  it('keeps declared fields of the structured result', () => {
    expect(
      auditResult(
        json({
          messages: [
            { id: 'm1', body: 'x' },
            { id: 'm2', body: 'y' },
          ],
        }),
        ['/messages/*/id'],
      ),
    ).toEqual({
      isError: false,
      kept: { '/messages/*/id': ['m1', 'm2'] },
    })
  })

  it('never copies binary content', () => {
    const audited = auditResult(
      { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      ['/data'],
    )
    expect(JSON.stringify(audited)).not.toContain('AAAA')
  })
})

describe('the audit trail of a call', () => {
  const mailArgs = jsonSchema({
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      password: { type: 'string' },
    },
    required: ['to'],
  })
  const sent = {
    to: 'ada@example.com',
    subject: 'Invoice 12',
    body: 'private body',
    password: 'hunter2',
  }

  it('keeps metadata only by default: who, which tool, an argument digest, the verdict, the duration', async () => {
    const mail = defineTool({
      ...baseDefinition('send_mail'),
      args: mailArgs,
      sensitivity: 'low',
      handler: () => Promise.resolve(json({ messageId: 'm-1', echo: 'private body' })),
    })
    const { bridge, audit, advance } = setup([mail], {
      context: () => {
        advance(25)
        return undefined
      },
    })

    const outcome = await bridge.callTool(
      reader,
      { name: 'send_mail', arguments: sent },
      { transport: 'stdio' },
    )
    expect(outcome.status).toBe('ok')

    const [started, succeeded] = audit.events
    const common = {
      callId: outcome.callId,
      transport: 'stdio',
      principal: { id: 'alice', roles: ['reader'] },
      tool: 'send_mail',
      argsDigest: digestArguments(sent),
    }
    expect(started).toMatchObject({ type: 'call.started', confirmed: false, ...common })
    expect(succeeded).toMatchObject({
      type: 'call.succeeded',
      confirmed: false,
      result: { isError: false },
      ...common,
    })
    expect(started?.at).toBe('2026-10-02T12:00:00.025Z')
    for (const event of audit.events) {
      expect(event).not.toHaveProperty('args')
      // The event OBJECTS, not just their serialization: the value never entered them.
      expect(JSON.stringify(event)).not.toMatch(/private body|hunter2|Invoice 12|ada@example\.com/)
    }
  })

  it('keeps exactly what a tool declares, on both sides', async () => {
    const mail = defineTool({
      ...baseDefinition('send_mail'),
      args: mailArgs,
      sensitivity: 'low',
      audit: { args: ['/to'], result: ['/messageId'] },
      handler: () => Promise.resolve(json({ messageId: 'm-1', echo: 'private body' })),
    })
    const { bridge, audit } = setup([mail])
    await bridge.callTool(reader, { name: 'send_mail', arguments: sent })
    const succeeded = audit.events.find((event) => event.type === 'call.succeeded')
    expect(succeeded).toMatchObject({
      args: { '/to': 'ada@example.com' },
      result: { isError: false, kept: { '/messageId': 'm-1' } },
    })
    expect(JSON.stringify(audit.events)).not.toMatch(/private body|hunter2|Invoice 12/)
  })

  it('keeps no summary in the audit: it is written from the arguments', async () => {
    const mail = defineTool({
      ...baseDefinition('send_mail'),
      args: mailArgs,
      sensitivity: 'high',
      summarize: ({ to, subject }) => `Send "${String(subject)}" to ${to}`,
    })
    const { bridge, audit } = setup([mail])
    const outcome = await bridge.callTool(reader, { name: 'send_mail', arguments: sent })
    expect(outcome).toMatchObject({
      confirmation: { summary: 'Send "Invoice 12" to ada@example.com' },
    })
    expect(audit.events[0]).toMatchObject({ type: 'confirmation.issued' })
    expect(JSON.stringify(audit.events)).not.toMatch(/Invoice 12|ada@example\.com/)
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

  it('cuts long error messages as they enter the audit record', async () => {
    const crash = makeTool('crash', { handler: () => Promise.reject(new Error('x'.repeat(2000))) })
    const { bridge, audit } = setup([crash])
    await bridge.callTool(reader, { name: 'crash' })
    const failed = audit.events.find((event) => event.type === 'call.failed')
    expect(failed?.type === 'call.failed' && failed.error.message.length).toBe(501)
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
