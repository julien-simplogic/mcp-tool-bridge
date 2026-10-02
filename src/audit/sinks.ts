import type { AuditEvent, AuditSink } from './events.js'

/**
 * One JSON object per line on stderr. The default sink: under stdio, stdout
 * carries the protocol and must never receive anything else.
 */
export function stderrJsonSink(): AuditSink {
  return {
    write(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`)
    },
  }
}

export interface MemorySink extends AuditSink {
  readonly events: readonly AuditEvent[]
  clear(): void
}

/** Keeps events in memory. For tests, or to inspect what a host recorded. */
export function memorySink(): MemorySink {
  const events: AuditEvent[] = []
  return {
    events,
    write(event) {
      events.push(event)
    },
    clear() {
      events.length = 0
    },
  }
}
