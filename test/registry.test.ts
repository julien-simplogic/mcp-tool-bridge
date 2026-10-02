import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  defineTool,
  isTool,
  jsonSchema,
  ToolDefinitionError,
  ToolRegistry,
  type Tool,
  type ToolDefinitionErrorCode,
} from '../src/index.js'
import type { CallContext } from '../src/tool.js'
import { baseDefinition, defineUnchecked, makeTool } from './helpers.js'

function expectDefinitionError(define: () => unknown, code: ToolDefinitionErrorCode): void {
  let caught: unknown
  try {
    define()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ToolDefinitionError)
  expect((caught as ToolDefinitionError).code).toBe(code)
}

describe('defineTool', () => {
  it('returns a frozen descriptor with normalised fields', () => {
    const tool = defineTool({
      ...baseDefinition('send_invoice'),
      title: 'Send an invoice',
      sensitivity: 'high',
      reversible: false,
      roles: ['billing', 'admin', 'billing'],
      audit: { args: ['/invoiceId'] },
      timeoutMs: 5000,
    })

    expect(tool).toMatchObject({
      name: 'send_invoice',
      title: 'Send an invoice',
      sensitivity: 'high',
      reversible: false,
      roles: ['billing', 'admin'],
      confirm: 'auto',
      audit: { args: ['/invoiceId'], result: [] },
      timeoutMs: 5000,
    })
    expect(Object.isFrozen(tool)).toBe(true)
    expect(Object.isFrozen(tool.roles)).toBe(true)
    expect(Object.isFrozen(tool.audit)).toBe(true)
    expect(Object.isFrozen(tool.audit.args)).toBe(true)
    expect(Object.isFrozen(tool.inputSchema)).toBe(true)
  })

  it('does not expose the handler on the descriptor', () => {
    const tool = makeTool('ping')
    expect(Object.keys(tool)).not.toContain('handler')
    expect(Object.keys(tool)).not.toContain('args')
  })

  it('snapshots the schema: editing the source object afterwards changes nothing', () => {
    const source = {
      type: 'object',
      properties: { to: { type: 'string' } },
    } as const
    const args = jsonSchema(source)
    const tool = defineTool({ ...baseDefinition('mail'), args })
    expect(tool.inputSchema).toEqual(source)
    expect(tool.inputSchema).not.toBe(source)
  })

  it.each<[string, unknown, ToolDefinitionErrorCode]>([
    ['a null definition', null, 'invalid_definition'],
    ['an empty name', { ...baseDefinition(), name: '' }, 'invalid_name'],
    ['a name with a space', { ...baseDefinition(), name: 'send invoice' }, 'invalid_name'],
    ['a name with a slash', { ...baseDefinition(), name: 'mail/send' }, 'invalid_name'],
    ['a name over 128 characters', { ...baseDefinition(), name: 'a'.repeat(129) }, 'invalid_name'],
    ['an empty title', { ...baseDefinition(), title: ' ' }, 'invalid_title'],
    ['no description', { ...baseDefinition(), description: undefined }, 'invalid_description'],
    ['a blank description', { ...baseDefinition(), description: '  ' }, 'invalid_description'],
    ['no args schema', { ...baseDefinition(), args: undefined }, 'invalid_schema'],
    [
      'a raw JSON Schema as args',
      { ...baseDefinition(), args: { type: 'object' } },
      'invalid_schema',
    ],
    [
      'an unknown sensitivity',
      { ...baseDefinition(), sensitivity: 'extreme' },
      'invalid_sensitivity',
    ],
    ['no sensitivity', { ...baseDefinition(), sensitivity: undefined }, 'invalid_sensitivity'],
    ['no reversibility', { ...baseDefinition(), reversible: undefined }, 'invalid_reversible'],
    ['a string reversibility', { ...baseDefinition(), reversible: 'yes' }, 'invalid_reversible'],
    ['no roles', { ...baseDefinition(), roles: undefined }, 'invalid_roles'],
    ['an empty role list', { ...baseDefinition(), roles: [] }, 'invalid_roles'],
    ['an empty role', { ...baseDefinition(), roles: [''] }, 'invalid_roles'],
    ['a padded role', { ...baseDefinition(), roles: [' admin'] }, 'invalid_roles'],
    ['a non-string role', { ...baseDefinition(), roles: [42] }, 'invalid_roles'],
    ['an opt-out confirm mode', { ...baseDefinition(), confirm: 'never' }, 'invalid_confirm'],
    ['a non-function summarize', { ...baseDefinition(), summarize: 'Send' }, 'invalid_summarize'],
    [
      'an audit pointer that is not a pointer',
      { ...baseDefinition(), audit: { args: ['messageId'] } },
      'invalid_audit',
    ],
    [
      'audit pointers that are not an array',
      { ...baseDefinition(), audit: { result: '/id' } },
      'invalid_audit',
    ],
    ['an unknown audit field', { ...baseDefinition(), audit: { body: ['/x'] } }, 'invalid_audit'],
    [
      'the whole document as an audit pointer',
      { ...baseDefinition(), audit: { args: ['/'] } },
      'invalid_audit',
    ],
    ['an audit that is not an object', { ...baseDefinition(), audit: true }, 'invalid_audit'],
    ['a zero timeout', { ...baseDefinition(), timeoutMs: 0 }, 'invalid_timeout'],
    ['a fractional timeout', { ...baseDefinition(), timeoutMs: 1.5 }, 'invalid_timeout'],
    [
      'a timeout above the timer limit',
      { ...baseDefinition(), timeoutMs: 2 ** 31 },
      'invalid_timeout',
    ],
    ['no handler', { ...baseDefinition(), handler: undefined }, 'invalid_handler'],
  ])('rejects %s', (_label, definition, code) => {
    expectDefinitionError(() => defineUnchecked(definition), code)
  })

  it('names the tool in the error', () => {
    let caught: unknown
    try {
      defineUnchecked({ ...baseDefinition('wipe_disk'), roles: [] })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ tool: 'wipe_disk' })
    expect(String(caught)).toContain('wipe_disk')
  })
})

describe('isTool', () => {
  it('recognises only descriptors built by defineTool', () => {
    const tool = makeTool('ping')
    expect(isTool(tool)).toBe(true)
    expect(isTool({ ...tool })).toBe(false)
    expect(isTool(null)).toBe(false)
    expect(isTool('ping')).toBe(false)
  })
})

describe('ToolRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers tools and lists them in registration order', () => {
    const registry = new ToolRegistry()
      .register(makeTool('b'), makeTool('a'))
      .register(makeTool('c'))
    expect(registry.list().map((tool) => tool.name)).toEqual(['b', 'a', 'c'])
    expect(registry.size).toBe(3)
    expect(registry.has('a')).toBe(true)
    expect(registry.get('a')?.name).toBe('a')
    expect(registry.get('missing')).toBeUndefined()
  })

  it('rejects a name already taken, and keeps the original', () => {
    const original = makeTool('ping')
    const registry = new ToolRegistry().register(original)
    expectDefinitionError(() => registry.register(makeTool('ping')), 'duplicate_name')
    expect(registry.get('ping')).toBe(original)
    expect(registry.size).toBe(1)
  })

  it('registers a batch all or nothing', () => {
    const registry = new ToolRegistry()
    expectDefinitionError(
      () => registry.register(makeTool('a'), makeTool('b'), makeTool('a')),
      'duplicate_name',
    )
    expect(registry.size).toBe(0)

    expectDefinitionError(
      () => registry.register(makeTool('a'), { ...makeTool('b') }),
      'not_a_tool',
    )
    expect(registry.size).toBe(0)
  })

  it('refuses look-alike objects that skipped defineTool', () => {
    // A copy type-checks as a Tool; only the runtime brand tells it apart.
    const forged: Tool = { ...makeTool('ping'), roles: ['anyone'] }
    expectDefinitionError(() => new ToolRegistry().register(forged), 'not_a_tool')
  })

  it('unregisters by name', () => {
    const registry = new ToolRegistry().register(makeTool('ping'))
    expect(registry.unregister('ping')).toBe(true)
    expect(registry.unregister('ping')).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('returns snapshots that later changes do not affect', () => {
    const registry = new ToolRegistry().register(makeTool('a'))
    const before = registry.list()
    registry.register(makeTool('b'))
    expect(before.map((tool) => tool.name)).toEqual(['a'])
    expect(Object.isFrozen(before)).toBe(true)
  })

  it('notifies once per effective change', () => {
    const registry = new ToolRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.onChange(listener)

    registry.register(makeTool('a'), makeTool('b'))
    registry.register()
    registry.unregister('missing')
    expect(listener).toHaveBeenCalledTimes(1)

    registry.unregister('a')
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    registry.unregister('b')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not notify when a registration is rejected', () => {
    const registry = new ToolRegistry().register(makeTool('a'))
    const listener = vi.fn()
    registry.onChange(listener)
    expect(() => registry.register(makeTool('a'))).toThrow(ToolDefinitionError)
    expect(listener).not.toHaveBeenCalled()
  })

  it('survives a failing listener, warns on stderr and still notifies the others', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const registry = new ToolRegistry()
    const after = vi.fn()
    registry.onChange(() => {
      throw new Error('boom')
    })
    registry.onChange(after)

    registry.register(makeTool('a'))
    expect(registry.has('a')).toBe(true)
    expect(after).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })

  it('keeps tools that need another context out of the registry, at compile time', () => {
    interface AppContext {
      readonly db: { readonly query: (sql: string) => Promise<number> }
    }
    const needsDb = defineTool({
      ...baseDefinition('count_rows'),
      handler: async (_args, call: CallContext<AppContext>) =>
        String(await call.context.db.query('x')),
    })
    expectTypeOf(needsDb).toEqualTypeOf<Tool<AppContext>>()

    // A tool that needs no context fits any registry…
    new ToolRegistry<AppContext>().register(makeTool('ping'), needsDb)
    // …but one that needs a database does not fit a registry that has none.
    // @ts-expect-error Tool<AppContext> is not a Tool<{ other: true }>
    expect(() => new ToolRegistry<{ other: true }>().register(needsDb)).not.toThrow()
  })
})
