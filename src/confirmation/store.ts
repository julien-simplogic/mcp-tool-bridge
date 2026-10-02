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
  readonly expiresAt: number
}

/**
 * Where pending confirmations wait. `take` must read *and* delete in one
 * atomic step: that is what makes a token single-use when two redemptions
 * race. A shared implementation (Redis `GETDEL`, `DELETE … RETURNING`) is
 * needed as soon as more than one process serves the same clients.
 */
export interface ConfirmationStore {
  put(record: ConfirmationRecord): Promise<void>
  take(tokenHash: string): Promise<ConfirmationRecord | undefined>
}

export interface MemoryConfirmationStoreOptions {
  /** Upper bound on pending confirmations. Default 10 000. */
  readonly maxEntries?: number
  readonly now?: () => number
}

/**
 * In-process store, for a single process. Expired records are kept until
 * space is needed, so that a late redemption is reported as expired rather
 * than unknown. When full, expired records go first, then the oldest pending
 * ones: a model that floods sensitive calls cannot make memory grow without
 * bound.
 */
export class MemoryConfirmationStore implements ConfirmationStore {
  readonly #records = new Map<string, ConfirmationRecord>()
  readonly #maxEntries: number
  readonly #now: () => number

  constructor(options: MemoryConfirmationStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 10_000
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive integer')
    }
    this.#maxEntries = maxEntries
    this.#now = options.now ?? Date.now
  }

  get size(): number {
    return this.#records.size
  }

  put(record: ConfirmationRecord): Promise<void> {
    if (this.#records.size >= this.#maxEntries) this.#evict()
    this.#records.set(record.tokenHash, record)
    return Promise.resolve()
  }

  take(tokenHash: string): Promise<ConfirmationRecord | undefined> {
    // Read and delete happen in the same synchronous step: no other call can
    // interleave between them.
    const record = this.#records.get(tokenHash)
    this.#records.delete(tokenHash)
    return Promise.resolve(record)
  }

  #evict(): void {
    const now = this.#now()
    for (const [hash, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(hash)
    }
    // Maps iterate in insertion order: the first key is the oldest record.
    for (const hash of this.#records.keys()) {
      if (this.#records.size < this.#maxEntries) break
      this.#records.delete(hash)
    }
  }
}
