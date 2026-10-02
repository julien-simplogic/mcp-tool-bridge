import type { JsonValue } from '../types.js'

/** A call held back until someone confirms it. */
export interface ConfirmationRecord {
  /** SHA-256 of the token. The token itself is never stored. */
  readonly tokenHash: string
  /** The call this confirmation belongs to; its audit events share this id. */
  readonly callId: string
  readonly principalId: string
  readonly tool: string
  /** The arguments as received, already validated once. They are what will run. */
  readonly arguments: JsonValue
  readonly argumentsDigest: string
  readonly summary: string
  /** Epoch milliseconds. */
  readonly createdAt: number
  /**
   * Computed once, when the confirmation is issued, and stored with it. Never
   * recomputed from a configuration that may have changed since.
   */
  readonly expiresAt: number
}

/**
 * What a redemption attempt found. Presenting a token consumes it, whatever
 * the outcome: a second presentation finds it `consumed`. `expired` carries
 * the record while it is still stored; once a store has evicted it, only the
 * fact that it expired is remembered.
 */
export type TakeResult =
  | { readonly status: 'taken'; readonly record: ConfirmationRecord }
  | { readonly status: 'expired'; readonly record?: ConfirmationRecord }
  | { readonly status: 'consumed' }
  | { readonly status: 'unknown' }

/**
 * Where pending confirmations wait.
 *
 * `take` must, in ONE atomic step, read the record, check its expiry against
 * `now`, and mark it consumed: that is what makes a token single-use when two
 * redemptions race, and what keeps an expired token from passing. Expiry is
 * decided there, never by a cleanup job; cleanup only frees space.
 *
 * In SQL: `UPDATE confirmations SET consumed_at = now() WHERE token_hash = $1
 * AND consumed_at IS NULL RETURNING *, expires_at <= now() AS expired`, then,
 * when no row comes back, one read to tell `consumed` from `unknown`.
 */
export interface ConfirmationStore {
  put(record: ConfirmationRecord): Promise<void>
  take(tokenHash: string, now: number): Promise<TakeResult>
}

export interface MemoryConfirmationStoreOptions {
  /** Upper bound on pending confirmations. Default 10 000. */
  readonly maxEntries?: number
  /** Upper bound on remembered consumed tokens. Default 10 000. */
  readonly maxConsumed?: number
  /**
   * How long a consumed or expired token is remembered after its own expiry,
   * so that a replay is reported as such rather than as unknown. Default 24 h.
   */
  readonly consumedRetentionMs?: number
  readonly now?: () => number
}

interface Tombstone {
  /** `expired`: evicted after expiry without ever being presented. */
  readonly outcome: 'consumed' | 'expired'
  /** Epoch milliseconds after which the tombstone may be forgotten. */
  readonly until: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * In-process store, for a single process.
 *
 * Both maps are bounded, so a process that runs for months does not grow:
 * pending records by `maxEntries`, consumed tokens by `maxConsumed` and by
 * their retention. When a map is full, expired entries go first, then the
 * oldest. A model that floods sensitive calls cannot make memory grow.
 */
export class MemoryConfirmationStore implements ConfirmationStore {
  readonly #records = new Map<string, ConfirmationRecord>()
  readonly #consumed = new Map<string, Tombstone>()
  readonly #maxEntries: number
  readonly #maxConsumed: number
  readonly #retentionMs: number
  readonly #now: () => number

  constructor(options: MemoryConfirmationStoreOptions = {}) {
    this.#maxEntries = positiveInteger(options.maxEntries ?? 10_000, 'maxEntries')
    this.#maxConsumed = positiveInteger(options.maxConsumed ?? 10_000, 'maxConsumed')
    this.#retentionMs = positiveInteger(
      options.consumedRetentionMs ?? DAY_MS,
      'consumedRetentionMs',
    )
    this.#now = options.now ?? Date.now
  }

  /** Pending confirmations. */
  get size(): number {
    return this.#records.size
  }

  /** Remembered consumed or expired tokens. */
  get consumedSize(): number {
    return this.#consumed.size
  }

  put(record: ConfirmationRecord): Promise<void> {
    const now = this.#now()
    this.#forgetExpiredTombstones(now)
    if (this.#records.size >= this.#maxEntries) this.#evictRecords(now)
    this.#records.set(record.tokenHash, record)
    return Promise.resolve()
  }

  take(tokenHash: string, now: number): Promise<TakeResult> {
    // Everything below is synchronous: no other call can interleave between
    // the read, the expiry check and the consumption.
    const record = this.#records.get(tokenHash)
    if (record) {
      this.#records.delete(tokenHash)
      this.#remember(tokenHash, 'consumed', record.expiresAt, now)
      return Promise.resolve(
        record.expiresAt <= now ? { status: 'expired', record } : { status: 'taken', record },
      )
    }
    const tombstone = this.#consumed.get(tokenHash)
    if (!tombstone || tombstone.until <= now) return Promise.resolve({ status: 'unknown' })
    if (tombstone.outcome === 'expired') {
      // First presentation of a token evicted after expiry: from now on, consumed.
      this.#consumed.set(tokenHash, { ...tombstone, outcome: 'consumed' })
      return Promise.resolve({ status: 'expired' })
    }
    return Promise.resolve({ status: 'consumed' })
  }

  #remember(
    tokenHash: string,
    outcome: Tombstone['outcome'],
    expiresAt: number,
    now: number,
  ): void {
    this.#forgetExpiredTombstones(now)
    if (this.#consumed.size >= this.#maxConsumed) {
      // Maps iterate in insertion order: the first key is the oldest.
      const oldest = this.#consumed.keys().next()
      if (!oldest.done) this.#consumed.delete(oldest.value)
    }
    this.#consumed.set(tokenHash, { outcome, until: Math.max(expiresAt, now) + this.#retentionMs })
  }

  #forgetExpiredTombstones(now: number): void {
    for (const [hash, tombstone] of this.#consumed) {
      if (tombstone.until <= now) this.#consumed.delete(hash)
    }
  }

  #evictRecords(now: number): void {
    for (const [hash, record] of this.#records) {
      if (record.expiresAt <= now) {
        this.#records.delete(hash)
        this.#remember(hash, 'expired', record.expiresAt, now)
      }
    }
    for (const hash of this.#records.keys()) {
      if (this.#records.size < this.#maxEntries) break
      this.#records.delete(hash)
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer`)
  return value
}
