import type { Tool } from '../tool.js'
import { isSensitivity, sensitivityRank, type Sensitivity } from '../types.js'

/** `none` is not a threshold: a tool with no side effect has nothing to confirm. */
export type ConfirmationThreshold = Exclude<Sensitivity, 'none'>

export interface ConfirmationPolicy {
  /** Tools at or above this level are confirmed. Default `high`. */
  readonly threshold: ConfirmationThreshold
  /** Confirm irreversible tools one level below the threshold. Default true. */
  readonly irreversibleLowersThreshold: boolean
}

export const DEFAULT_POLICY: ConfirmationPolicy = Object.freeze({
  threshold: 'high',
  irreversibleLowersThreshold: true,
})

export function isConfirmationThreshold(value: unknown): value is ConfirmationThreshold {
  return isSensitivity(value) && value !== 'none'
}

/**
 * Whether a call to this tool must be confirmed before it runs. Decided from
 * the declaration alone, never from the arguments or from anything the model
 * says: the same tool is always confirmed, or never.
 */
export function requiresConfirmation(
  tool: Pick<Tool<never>, 'sensitivity' | 'reversible' | 'confirm'>,
  policy: ConfirmationPolicy = DEFAULT_POLICY,
): boolean {
  if (tool.confirm === 'always') return true
  if (tool.sensitivity === 'none') return false
  const lowered = policy.irreversibleLowersThreshold && !tool.reversible ? 1 : 0
  return sensitivityRank(tool.sensitivity) >= sensitivityRank(policy.threshold) - lowered
}
