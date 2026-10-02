import { describe, expect, it } from 'vitest'
import { canAccess, exposeTool, parsePrincipal, ToolRegistry, visibleTools } from '../src/index.js'
import { editor, makeTool, nobody, reader } from './helpers.js'

describe('canAccess', () => {
  const billing = makeTool('send_invoice', { roles: ['billing', 'admin'] })

  it('grants access when the principal holds one of the tool roles', () => {
    expect(canAccess(billing, { id: 'carol', roles: ['support', 'admin'] })).toBe(true)
    expect(canAccess(billing, { id: 'dave', roles: ['billing'] })).toBe(true)
  })

  it('denies access without a shared role', () => {
    expect(canAccess(billing, editor)).toBe(false)
    expect(canAccess(billing, nobody)).toBe(false)
  })

  it('compares role names exactly: no case folding, no wildcard, no prefix', () => {
    expect(canAccess(billing, { id: 'x', roles: ['Admin'] })).toBe(false)
    expect(canAccess(billing, { id: 'x', roles: ['*'] })).toBe(false)
    expect(canAccess(billing, { id: 'x', roles: ['admin:read'] })).toBe(false)
  })
})

describe('visibleTools', () => {
  const registry = new ToolRegistry().register(
    makeTool('search', { roles: ['reader'] }),
    makeTool('edit', { roles: ['editor'] }),
    makeTool('read_mail', { roles: ['reader', 'editor'] }),
  )

  it('keeps only the tools the principal may use, in registry order', () => {
    expect(visibleTools(registry.list(), reader).map((tool) => tool.name)).toEqual([
      'search',
      'read_mail',
    ])
    expect(visibleTools(registry.list(), editor).map((tool) => tool.name)).toEqual([
      'search',
      'edit',
      'read_mail',
    ])
  })

  it('shows nothing to a principal without roles', () => {
    expect(visibleTools(registry.list(), nobody)).toEqual([])
  })
})

describe('exposeTool', () => {
  it('shows the model what it needs, and nothing of the access policy', () => {
    const exposed = exposeTool(
      makeTool('delete_file', {
        title: 'Delete a file',
        sensitivity: 'high',
        reversible: false,
        roles: ['admin'],
        redact: ['/path'],
      }),
    )
    expect(exposed).toEqual({
      name: 'delete_file',
      title: 'Delete a file',
      description: 'Answers pong.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Delete a file', readOnlyHint: false, destructiveHint: true },
    })
    for (const key of ['roles', 'sensitivity', 'reversible', 'redact', 'confirm']) {
      expect(exposed).not.toHaveProperty(key)
    }
  })

  it('maps sensitivity "none" to a read-only hint', () => {
    const exposed = exposeTool(makeTool('search', { sensitivity: 'none', reversible: false }))
    expect(exposed.annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect('title' in exposed).toBe(false)
  })

  it('flags irreversible side effects as destructive, reversible ones as not', () => {
    const reversible = exposeTool(makeTool('move', { sensitivity: 'low', reversible: true }))
    const irreversible = exposeTool(makeTool('send', { sensitivity: 'low', reversible: false }))
    expect(reversible.annotations.destructiveHint).toBe(false)
    expect(irreversible.annotations.destructiveHint).toBe(true)
  })
})

describe('parsePrincipal', () => {
  it('returns a frozen copy the caller can no longer change', () => {
    const roles = ['reader']
    const source = { id: 'alice', roles, team: 'ops' }
    const principal = parsePrincipal(source)

    roles.push('admin')
    source.id = 'mallory'

    expect(principal).toEqual({ id: 'alice', roles: ['reader'] })
    expect(Object.isFrozen(principal)).toBe(true)
    expect(Object.isFrozen(principal.roles)).toBe(true)
  })

  it('accepts a principal without roles, who will see nothing', () => {
    expect(parsePrincipal({ id: 'eve', roles: [] }).roles).toEqual([])
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'alice'],
    ['a missing id', { roles: [] }],
    ['an empty id', { id: ' ', roles: [] }],
    ['a numeric id', { id: 7, roles: [] }],
    ['missing roles', { id: 'alice' }],
    ['roles as a string', { id: 'alice', roles: 'admin' }],
    ['an empty role', { id: 'alice', roles: [''] }],
    ['a non-string role', { id: 'alice', roles: [true] }],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePrincipal(value)).toThrow(TypeError)
  })
})
