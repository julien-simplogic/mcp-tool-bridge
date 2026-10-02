/**
 * A minimal MCP server with three tools, one per kind of risk:
 *
 * - search_notes: a read, with no side effect. Runs directly.
 * - add_note:     a reversible write. Runs directly.
 * - send_email:   an irreversible send. Held back until a human confirms.
 *
 * Nothing leaves the machine: notes live in memory and "sending" an email
 * only writes a line to stderr. Run it with:
 *
 *   npx tsx examples/minimal/server.ts
 *
 * The principal comes from EXAMPLE_PRINCIPAL_ID and EXAMPLE_PRINCIPAL_ROLES
 * (see .env.example). With the role `reader` alone, the two write tools are
 * neither listed nor callable.
 */
import {
  createBridge,
  defineTool,
  envelope,
  json,
  jsonSchema,
  parsePrincipal,
  serveStdio,
  text,
  ToolError,
  ToolRegistry,
} from 'mcp-tool-bridge'

interface Note {
  readonly id: string
  readonly text: string
  readonly author: string
}

const notes = new Map<string, Note>([
  ['n1', { id: 'n1', text: 'Invoice INV-12 is due on Friday.', author: 'alice' }],
  ['n2', { id: 'n2', text: 'Call Ada about the delivery slot.', author: 'bob' }],
])

/**
 * Stands for existing code that reports failures in its return value, as
 * many internal APIs do. `envelope` plugs it in as is.
 */
interface LegacyResult {
  readonly success: boolean
  readonly data?: { readonly messageId: string }
  readonly error?: string
}

function legacySendEmail(to: string, subject: string, body: string): Promise<LegacyResult> {
  if (to.endsWith('@example.invalid')) {
    return Promise.resolve({ success: false, error: `Mailbox ${to} does not exist.` })
  }
  // Simulated: stdout belongs to the protocol, so the "email" goes to stderr.
  process.stderr.write(`[example] email to ${to}: ${subject}\n${body}\n`)
  return Promise.resolve({ success: true, data: { messageId: `m-${String(Date.now())}` } })
}

const fromLegacy = envelope<LegacyResult>({
  ok: (result) => result.success,
  value: (result) => json({ messageId: result.data?.messageId ?? null }),
  message: (result) => result.error ?? 'The email could not be sent.',
})

const searchNotes = defineTool({
  name: 'search_notes',
  title: 'Search notes',
  description: 'Finds notes whose text contains the query, case-insensitively.',
  args: jsonSchema({
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, description: 'Text to look for.' } },
    required: ['query'],
    additionalProperties: false,
  }),
  sensitivity: 'none',
  reversible: true,
  roles: ['reader'],
  handler: ({ query }) => {
    const needle = query.toLowerCase()
    const found = [...notes.values()].filter((note) => note.text.toLowerCase().includes(needle))
    return Promise.resolve(json({ notes: found.map((note) => ({ ...note })) }))
  },
})

const addNote = defineTool({
  name: 'add_note',
  title: 'Add a note',
  description: 'Adds a note. Notes can be deleted later, so this is reversible.',
  args: jsonSchema({
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 500 } },
    required: ['text'],
    additionalProperties: false,
  }),
  sensitivity: 'low',
  reversible: true,
  roles: ['editor'],
  handler: ({ text: noteText }, call) => {
    const id = `n${String(notes.size + 1)}`
    notes.set(id, { id, text: noteText, author: call.principal.id })
    return Promise.resolve(text(`Note ${id} added.`))
  },
})

const sendEmail = defineTool({
  name: 'send_email',
  title: 'Send an email',
  description: 'Sends an email. It cannot be unsent: the user is asked to confirm first.',
  args: jsonSchema({
    type: 'object',
    properties: {
      to: { type: 'string', format: 'email' },
      subject: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', maxLength: 5000 },
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  }),
  sensitivity: 'high',
  reversible: false,
  roles: ['editor'],
  // The audit keeps who the email went to, never its subject or body.
  audit: { args: ['/to'] },
  timeoutMs: 10_000,
  summarize: ({ to, subject }) => `Send the email "${subject}" to ${to}`,
  handler: async ({ to, subject, body }) => {
    if (to === 'noreply@example.com') throw new ToolError('That address does not accept email.')
    return fromLegacy(await legacySendEmail(to, subject, body))
  },
})

const registry = new ToolRegistry().register(searchNotes, addNote, sendEmail)

const bridge = createBridge({
  registry,
  context: () => undefined,
  // Default policy: high-sensitivity tools, and irreversible medium ones, are confirmed.
  // Default audit: one JSON line per event on stderr.
})

const principal = parsePrincipal({
  id: process.env.EXAMPLE_PRINCIPAL_ID ?? 'alice',
  roles: (process.env.EXAMPLE_PRINCIPAL_ROLES ?? 'reader,editor')
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role !== ''),
})

const handle = await serveStdio(bridge, {
  info: {
    name: 'mcp-tool-bridge-example',
    version: '1.0.0',
    instructions: 'Notes and email for a small team. Sending an email needs the user to confirm.',
  },
  principal,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0))
  })
}
