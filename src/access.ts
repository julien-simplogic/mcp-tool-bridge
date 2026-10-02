import type { Tool } from './tool.js'
import type { Principal } from './types.js'

/**
 * The single access rule, used both when listing tools and when executing
 * one: the principal must hold at least one of the tool's roles. Role names
 * are compared exactly; there is no wildcard and no hierarchy.
 */
export function canAccess(tool: Pick<Tool<never>, 'roles'>, principal: Principal): boolean {
  return tool.roles.some((role) => principal.roles.includes(role))
}

/** The tools this principal may see, in registry order. */
export function visibleTools<TContext>(
  tools: Iterable<Tool<TContext>>,
  principal: Principal,
): Tool<TContext>[] {
  const visible: Tool<TContext>[] = []
  for (const tool of tools) if (canAccess(tool, principal)) visible.push(tool)
  return visible
}

/**
 * Checks a principal coming from outside the type system (configuration,
 * environment, an authentication hook) and returns a frozen copy, so that
 * mutating the original between two checks changes nothing.
 */
export function parsePrincipal(value: unknown): Principal {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('a principal must be an object with an id and roles')
  }
  const id: unknown = Reflect.get(value, 'id')
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('a principal needs a non-empty string id')
  }
  const roles: unknown = Reflect.get(value, 'roles')
  if (!Array.isArray(roles)) throw new TypeError(`principal "${id}": roles must be an array`)
  const copy: string[] = []
  for (const role of roles as readonly unknown[]) {
    if (typeof role !== 'string' || role === '') {
      throw new TypeError(`principal "${id}": every role must be a non-empty string`)
    }
    copy.push(role)
  }
  return Object.freeze({ id, roles: Object.freeze(copy) })
}
