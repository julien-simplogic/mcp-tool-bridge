import { createHash, randomBytes } from 'node:crypto'
import { isJsonArray, isJsonObject } from '../json.js'
import type { JsonValue } from '../types.js'

/** Recognisable by secret scanners and in logs; carries no information. */
const TOKEN_PREFIX = 'mtb_'

/** 32 random bytes: a token cannot be guessed, only handed over. */
export function newToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

/**
 * Stores keep this hash, never the token: whoever reads the store cannot
 * redeem what is in it.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Fingerprint of a call's arguments, independent of key order. A token is
 * bound to it: approving one call cannot be used to run a different one.
 */
export function digestArguments(args: JsonValue): string {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
}

/** JSON with object keys sorted, recursively, so that equal values serialize equally. */
export function canonicalJson(value: JsonValue): string {
  if (isJsonArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
