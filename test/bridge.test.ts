import { describe, expect, it, vi } from 'vitest'
import {
  createBridge,
  defineTool,
  json,
  jsonSchema,
  memorySink,
  ToolRegistry,
  type BridgeOptions,
  type CallContext,
} from '../src/index.js'
import { baseDefinition, makeTool, reader, setup } from './helpers.js'

describe('createBridge', () => {
  const registry = new ToolRegistry()
  const valid: BridgeOptions<unknown> = { registry, context: () => undefined, audit: memorySink() }

  it.each<[string, unknown]>([
    ['no options', undefined],
    ['a registry that is not a ToolRegistry', { ...valid, registry: { get: () => undefined } }],
    ['no context factory', { ...valid, context: undefined }],
    ['a threshold of none', { ...valid, confirmation: { threshold: 'none' } }],
    ['an unknown threshold', { ...valid, confirmation: { threshold: 'severe' } }],
    ['a zero TTL', { ...valid, confirmation: { ttlMs: 0 } }],
    [
      'a store without take()',
      { ...valid, confirmation: { store: { put: () => Promise.resolve() } } },
    ],
    ['a sink without write()', { ...valid, audit: [{}] }],
    ['an unknown audit failure mode', { ...valid, auditFailure: 'ignore' }],
    ['a clock that is not a function', { ...valid, now: 42 }],
  ])('rejects %s', (_label, options) => {
    expect(() => createBridge(options as BridgeOptions<unknown>)).toThrow(TypeError)
  })

  it('accepts the minimal configuration', () => {
    expect(() => createBridge(valid)).not.toThrow()
  })
})

describe('executing a call', () => {
  it('treats omitted arguments as an empty object, as MCP does', async () => {
    const { bridge } = setup([makeTool('ping')])
    expect(await bridge.callTool(reader, { name: 'ping' })).toMatchObject({
      status: 'ok',
      result: { content: [{ type: 'text', text: 'pong' }] },
    })
  })

  it('rejects arguments that are not JSON before anything else runs', async () => {
    const handler = vi.fn(() => Promise.resolve('pong'))
    const { bridge } = setup([makeTool('ping', { handler })])
    expect(
      await bridge.callTool(reader, { name: 'ping', arguments: { at: new Date() } }),
    ).toMatchObject({
      status: 'invalid_arguments',
      issues: [{ path: '', message: 'must be plain JSON data' }],
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('gives the handler the parsed arguments, the principal, the context and a call id', async () => {
    interface Ctx {
      readonly tenant: string
    }
    const seen: CallContext<Ctx>[] = []
    const tool = defineTool({
      ...baseDefinition('whoami'),
      args: jsonSchema({ type: 'object', properties: { verbose: { type: 'boolean' } } }),
      handler: (args, call: CallContext<Ctx>) => {
        seen.push(call)
        return Promise.resolve(
          `${call.principal.id}@${call.context.tenant} ${String(args.verbose)}`,
        )
      },
    })
    const context = vi.fn((principal: { id: string }) => ({ tenant: `t-${principal.id}` }))
    const { bridge } = setup<Ctx>([tool], { context })

    const outcome = await bridge.callTool(reader, { name: 'whoami', arguments: { verbose: true } })
    expect(outcome).toMatchObject({
      status: 'ok',
      result: { content: [{ text: 'alice@t-alice true' }] },
    })
    expect(context).toHaveBeenCalledOnce()
    expect(seen[0]?.callId).toBe(outcome.callId)
    expect(seen[0]?.signal.aborted).toBe(false)
  })

  it('does not build a context for calls that never run', async () => {
    const context = vi.fn(() => undefined)
    const { bridge } = setup([makeTool('ping', { roles: ['admin'] })], { context })
    await bridge.callTool(reader, { name: 'ping' })
    await bridge.callTool(reader, { name: 'missing' })
    expect(context).not.toHaveBeenCalled()
  })

  it('reports a failing context factory as a failure, without running the handler', async () => {
    const handler = vi.fn(() => Promise.resolve('pong'))
    const { bridge, trail } = setup([makeTool('ping', { handler })], {
      context: () => Promise.reject(new Error('database down')),
    })
    expect((await bridge.callTool(reader, { name: 'ping' })).status).toBe('tool_error')
    expect(handler).not.toHaveBeenCalled()
    expect(trail()).toEqual(['call.failed'])
  })

  it('passes structured results through', async () => {
    const { bridge } = setup([
      makeTool('stats', { handler: () => Promise.resolve(json({ open: 3, closed: 9 })) }),
    ])
    expect(await bridge.callTool(reader, { name: 'stats' })).toMatchObject({
      status: 'ok',
      result: { structuredContent: { open: 3, closed: 9 } },
    })
  })

  it('refuses a malformed result instead of forwarding it', async () => {
    const tool = makeTool('broken', {
      handler: () => Promise.resolve({ content: 'not an array' } as never),
    })
    const { bridge, audit } = setup([tool])
    expect((await bridge.callTool(reader, { name: 'broken' })).status).toBe('tool_error')
    expect(audit.events.at(-1)).toMatchObject({ type: 'call.failed', error: { kind: 'exception' } })
  })

  it('stops waiting after the timeout and aborts the handler signal', async () => {
    let signal: AbortSignal | undefined
    const slow = makeTool('slow', {
      timeoutMs: 20,
      handler: (_args, call) => {
        signal = call.signal
        return new Promise(() => undefined)
      },
    })
    const { bridge, audit } = setup([slow])
    expect(await bridge.callTool(reader, { name: 'slow' })).toMatchObject({
      status: 'tool_error',
      message: 'The tool did not answer within 20 ms.',
    })
    expect(signal?.aborted).toBe(true)
    expect(audit.events.at(-1)).toMatchObject({ error: { kind: 'timeout' } })
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    const waiting = makeTool('waiting', {
      handler: () => {
        controller.abort()
        return new Promise(() => undefined)
      },
    })
    const { bridge, audit } = setup([waiting])
    expect(
      await bridge.callTool(reader, { name: 'waiting' }, { signal: controller.signal }),
    ).toMatchObject({ status: 'tool_error', message: 'The call was cancelled.' })
    expect(audit.events.at(-1)).toMatchObject({ error: { kind: 'aborted' } })
  })

  it('does not start a call whose signal is already aborted', async () => {
    const handler = vi.fn(() => Promise.resolve('pong'))
    const { bridge } = setup([makeTool('ping', { handler })])
    const outcome = await bridge.callTool(reader, { name: 'ping' }, { signal: AbortSignal.abort() })
    expect(outcome.status).toBe('tool_error')
    expect(handler).not.toHaveBeenCalled()
  })

  it('validates the principal it is given', async () => {
    const { bridge } = setup([makeTool('ping')])
    await expect(bridge.callTool({ id: '', roles: [] }, { name: 'ping' })).rejects.toThrow(
      TypeError,
    )
    expect(() => bridge.listTools({ id: 'x' } as never)).toThrow(TypeError)
  })
})
