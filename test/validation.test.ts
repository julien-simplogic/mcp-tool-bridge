import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as z from 'zod'
import {
  defineTool,
  jsonSchema,
  ToolDefinitionError,
  type ArgsSchema,
  type ParseResult,
} from '../src/index.js'
import { MAX_ISSUES } from '../src/schema/types.js'
import { zodSchema } from '../src/schema/zod.js'
import { prepareCall, type CallContext } from '../src/tool.js'
import { baseDefinition, callContext } from './helpers.js'

const mail = jsonSchema({
  type: 'object',
  properties: {
    to: { type: 'string', format: 'email' },
    subject: { type: 'string', minLength: 1 },
    copies: { type: 'integer', minimum: 0, default: 0 },
    attachments: { type: 'array', items: { type: 'string' } },
  },
  required: ['to', 'subject'],
  additionalProperties: false,
})

const booking = zodSchema(
  z.object({
    email: z.email(),
    guests: z.int().min(1).max(12).default(2),
    name: z.string().transform((value) => value.trim()),
    slots: z.array(z.iso.datetime()).min(1),
  }),
)

function issuesOf<T>(result: ParseResult<T>): readonly { path: string; message: string }[] {
  if (result.ok) throw new Error('expected the arguments to be rejected')
  return result.issues
}

function invalidSchema(build: () => unknown): void {
  expect(build).toThrow(ToolDefinitionError)
  expect(build).toThrow(expect.objectContaining({ code: 'invalid_schema' }))
}

describe('jsonSchema()', () => {
  it('infers the argument type from the schema literal', () => {
    expectTypeOf(mail).toEqualTypeOf<
      ArgsSchema<{ to: string; subject: string; copies?: number; attachments?: string[] }>
    >()
  })

  it('accepts valid arguments and returns a copy', () => {
    const input = { to: 'ada@example.com', subject: 'Hello', attachments: ['a.pdf'] }
    const result = mail.parse(input)
    expect(result).toEqual({ ok: true, value: input })

    input.attachments.push('b.pdf')
    expect(result.ok && result.value.attachments).toEqual(['a.pdf'])
  })

  it('reports a missing property at its own path', () => {
    expect(issuesOf(mail.parse({ to: 'ada@example.com' }))).toEqual([
      { path: '/subject', message: "must have required property 'subject'" },
    ])
  })

  it('reports an unexpected property at its own path', () => {
    const issues = issuesOf(mail.parse({ to: 'ada@example.com', subject: 'x', bcc: 'all@corp' }))
    expect(issues).toEqual([{ path: '/bcc', message: 'must NOT have additional properties' }])
  })

  it('reports nested and array positions as JSON Pointers', () => {
    const issues = issuesOf(
      mail.parse({ to: 'not-an-address', subject: '', attachments: ['ok', 42] }),
    )
    expect(issues.map((issue) => issue.path)).toEqual(['/to', '/subject', '/attachments/1'])
    expect(issues[0]?.message).toContain('format')
  })

  it('reports every issue at once, up to a cap', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field${String(i)}`, { type: 'string' } as const]),
    )
    const wide = jsonSchema({ type: 'object', properties, required: Object.keys(properties) })
    expect(issuesOf(wide.parse({}))).toHaveLength(MAX_ISSUES)
  })

  it('escapes "/" and "~" in property names', () => {
    const odd = jsonSchema({
      type: 'object',
      properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } },
      required: ['a/b', 'c~d'],
    })
    expect(issuesOf(odd.parse({})).map((issue) => issue.path)).toEqual(['/a~1b', '/c~0d'])
  })

  it('does not coerce types', () => {
    const issues = issuesOf(mail.parse({ to: 'ada@example.com', subject: 'x', copies: '3' }))
    expect(issues).toEqual([{ path: '/copies', message: 'must be integer' }])
  })

  it('does not apply defaults, and keeps defaulted properties optional in the type', () => {
    const result = mail.parse({ to: 'ada@example.com', subject: 'x' })
    expect(result.ok && 'copies' in result.value).toBe(false)
    if (result.ok) expectTypeOf(result.value.copies).toEqualTypeOf<number | undefined>()
  })

  it('rejects arguments that are JSON but not an object', () => {
    for (const input of [[], 'hello', 42, null]) {
      expect(issuesOf(mail.parse(input))).toEqual([{ path: '', message: 'must be object' }])
    }
  })

  it.each<[string, () => unknown]>([
    ['undefined', () => undefined],
    ['a function', () => () => 'x'],
    ['a date', () => ({ to: new Date() })],
    ['NaN', () => ({ copies: Number.NaN })],
    ['Infinity', () => ({ copies: Number.POSITIVE_INFINITY })],
    ['a class instance', () => new URL('https://example.com')],
    ['a map', () => new Map([['to', 'ada@example.com']])],
    [
      'a cycle',
      () => {
        const node: Record<string, unknown> = { to: 'ada@example.com', subject: 'x' }
        node.self = node
        return node
      },
    ],
  ])('rejects %s as not JSON', (_label, input) => {
    expect(issuesOf(mail.parse(input()))).toEqual([
      { path: '', message: 'must be plain JSON data' },
    ])
  })

  it('accepts the same object twice in a tree: shared is not cyclic', () => {
    const shared = jsonSchema({
      type: 'object',
      properties: { a: { type: 'array' }, b: { type: 'array' } },
    })
    const list = ['x']
    expect(shared.parse({ a: list, b: list }).ok).toBe(true)
  })

  it('drops properties whose value is undefined, as JSON.stringify does', () => {
    expect(mail.parse({ to: 'ada@example.com', subject: 'x', copies: undefined })).toEqual({
      ok: true,
      value: { to: 'ada@example.com', subject: 'x' },
    })
  })

  it.each<[string, () => unknown]>([
    ['a non-object root', () => jsonSchema({ type: 'string' } as never)],
    ['a nullable root', () => jsonSchema({ type: ['object', 'null'] } as never)],
    ['a root without type', () => jsonSchema({ properties: {} } as never)],
    ['an unknown keyword', () => jsonSchema({ type: 'object', minProps: 1 } as never)],
    [
      'an unknown format',
      () => jsonSchema({ type: 'object', properties: { d: { type: 'string', format: 'colour' } } }),
    ],
    [
      'a required property that is not declared',
      () => jsonSchema({ type: 'object', properties: {}, required: ['to'] }),
    ],
    [
      'a schema that is not JSON',
      () => jsonSchema({ type: 'object', default: new Date() } as never),
    ],
  ])('fails at definition time on %s', (_label, build) => {
    invalidSchema(build)
  })
})

describe('zodSchema()', () => {
  it('infers the argument type from the output side of the schema', () => {
    expectTypeOf(booking).toEqualTypeOf<
      ArgsSchema<{ email: string; guests: number; name: string; slots: string[] }>
    >()
  })

  it('describes the input side to the model, without the $schema keyword', () => {
    expect(booking.jsonSchema).not.toHaveProperty('$schema')
    expect(booking.jsonSchema.type).toBe('object')
    expect(booking.jsonSchema.required).toEqual(['email', 'name', 'slots'])
  })

  it('returns the parsed output: transforms and defaults applied', () => {
    const result = booking.parse({
      email: 'ada@example.com',
      name: '  Ada  ',
      slots: ['2026-10-02T10:00:00Z'],
    })
    expect(result).toEqual({
      ok: true,
      value: { email: 'ada@example.com', guests: 2, name: 'Ada', slots: ['2026-10-02T10:00:00Z'] },
    })
  })

  it('reports issues as JSON Pointers', () => {
    const issues = issuesOf(
      booking.parse({ email: 'nope', guests: 40, name: 'Ada', slots: ['tomorrow'] }),
    )
    expect(issues.map((issue) => issue.path)).toEqual(['/email', '/guests', '/slots/0'])
  })

  it('enforces refinements that JSON Schema cannot express', () => {
    const range = zodSchema(
      z.object({ from: z.int(), to: z.int() }).refine((value) => value.from <= value.to, {
        message: 'from must not exceed to',
        path: ['to'],
      }),
    )
    expect(issuesOf(range.parse({ from: 5, to: 1 }))).toEqual([
      { path: '/to', message: 'from must not exceed to' },
    ])
  })

  it('rejects input that is not JSON before Zod sees it', () => {
    expect(issuesOf(booking.parse({ email: 'ada@example.com', when: new Date() }))).toEqual([
      { path: '', message: 'must be plain JSON data' },
    ])
  })

  it('fails at definition time on types JSON cannot carry', () => {
    invalidSchema(() => zodSchema(z.object({ when: z.date() })))
    invalidSchema(() => zodSchema(z.object({ amount: z.bigint() })))
  })
})

describe('prepared calls', () => {
  const handler = vi.fn((args: { to: string; subject: string }, call: CallContext<unknown>) =>
    Promise.resolve(`sent to ${args.to} for ${call.principal.id}`),
  )
  const sendMail = defineTool({
    ...baseDefinition('send_mail'),
    args: mail,
    sensitivity: 'high',
    reversible: false,
    summarize: (args) => `Send "${args.subject}" to ${args.to}`,
    handler,
  })

  it('never reaches the handler with invalid arguments', () => {
    const prepared = prepareCall(sendMail, { to: 'ada@example.com' })
    expect(prepared.ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('binds validated arguments to the handler and summarises the call', async () => {
    const prepared = prepareCall(sendMail, { to: 'ada@example.com', subject: 'Invoice 12' })
    if (!prepared.ok) throw new Error('expected valid arguments')
    expect(prepared.summary).toBe('Send "Invoice 12" to ada@example.com')
    expect(handler).not.toHaveBeenCalled()

    await expect(prepared.run(callContext(undefined))).resolves.toBe(
      'sent to ada@example.com for alice',
    )
    expect(handler).toHaveBeenCalledOnce()
  })

  it('falls back to the title, then the name, as the summary', () => {
    const titled = defineTool({ ...baseDefinition('ping'), title: 'Ping the server' })
    const bare = defineTool(baseDefinition('ping'))
    expect(prepareCall(titled, {})).toMatchObject({ ok: true, summary: 'Ping the server' })
    expect(prepareCall(bare, {})).toMatchObject({ ok: true, summary: 'ping' })
  })

  it('types the handler arguments from the schema and the context from its annotation', () => {
    interface Ctx {
      readonly tenant: string
    }
    const tool = defineTool({
      ...baseDefinition('book'),
      args: booking,
      handler: (args, call: CallContext<Ctx>) => {
        expectTypeOf(args.guests).toEqualTypeOf<number>()
        expectTypeOf(call.context.tenant).toEqualTypeOf<string>()
        return Promise.resolve('ok')
      },
    })
    expect(tool.name).toBe('book')
  })
})

describe('jsonSchema() written inline in defineTool', () => {
  it('infers the handler arguments without hitting the compiler limits', () => {
    // The README example, verbatim. A regression here is a compile error
    // (TS2589), reported by `npm run typecheck`.
    const sendInvoice = defineTool({
      name: 'send_invoice',
      description: 'Emails an existing invoice to the customer it belongs to.',
      args: jsonSchema({
        type: 'object',
        properties: {
          invoiceId: { type: 'string', pattern: '^INV-[0-9]+$' },
          copies: { type: 'integer', default: 1 },
        },
        required: ['invoiceId'],
        additionalProperties: false,
      }),
      sensitivity: 'high',
      reversible: false,
      roles: ['billing'],
      summarize: ({ invoiceId }) => `Email invoice ${invoiceId} to its customer`,
      handler: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ invoiceId: string; copies?: number }>()
        return Promise.resolve(`Invoice ${args.invoiceId} sent.`)
      },
    })
    expect(sendInvoice.name).toBe('send_invoice')
  })

  it('still refuses, at compile time, a keyword with the wrong type', () => {
    expect(() =>
      // @ts-expect-error minLength takes a number
      jsonSchema({ type: 'object', properties: { s: { type: 'string', minLength: 'three' } } }),
    ).toThrow(ToolDefinitionError)
  })
})
