import { describe, expect, it } from 'vitest'
import { defineTool, envelope, json, jsonSchema, text, ToolError } from '../src/index.js'
import { baseDefinition, reader, setup } from './helpers.js'

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
