# mcp-tool-bridge

A generic [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a
catalog of **declared** tools to a model, filters them by role, validates every argument
and holds sensitive calls behind a confirmation the model cannot give itself.

You declare what a tool is (its arguments, how much harm it can do, whether it can be
undone, who may use it); the bridge enforces it on every call, whatever the model says.

> **Status: v1.0, not yet published.** Tool declarations, the registry, role-based
> access, argument validation, the bridge, the confirmation guard, the audit log, the
> stdio server and the `envelope` adapter are in place, with a runnable example in
> [`examples/minimal`](./examples/minimal). The HTTP transport comes in v1.1.

## Requirements

Node.js 20 or later. The package ships as both ES modules and CommonJS. Zod is optional:
install `zod@^4` only if you use `mcp-tool-bridge/zod`.

## A first look

```ts
import { defineTool, jsonSchema, ToolRegistry, text } from 'mcp-tool-bridge'

const sendInvoice = defineTool({
  name: 'send_invoice',
  description: 'Emails an existing invoice to the customer it belongs to.',
  args: jsonSchema({
    type: 'object',
    properties: { invoiceId: { type: 'string', pattern: '^INV-[0-9]+$' } },
    required: ['invoiceId'],
    additionalProperties: false,
  }),
  sensitivity: 'high', // none | low | medium | high | critical
  reversible: false, // an email cannot be unsent
  roles: ['billing'],
  summarize: ({ invoiceId }) => `Email invoice ${invoiceId} to its customer`,
  handler: async ({ invoiceId }) => {
    // `invoiceId` is a string here: the type comes from the schema above.
    return text(`Invoice ${invoiceId} sent.`)
  },
})

const registry = new ToolRegistry().register(sendInvoice)
```

With Zod:

```ts
import * as z from 'zod'
import { zodSchema } from 'mcp-tool-bridge/zod'

const args = zodSchema(z.object({ invoiceId: z.string().regex(/^INV-[0-9]+$/) }))
```

The bridge is the only way to run a tool. It works without any transport, which is how
a host calls it directly and how the tests exercise it:

```ts
import { createBridge } from 'mcp-tool-bridge'

const bridge = createBridge({
  registry,
  context: (principal) => ({ db, tenantId: principal.id }), // what handlers get as call.context
})

const alice = { id: 'alice', roles: ['billing'] }
bridge.listTools(alice) // what the model may see

const outcome = await bridge.callTool(alice, {
  name: 'send_invoice',
  arguments: { invoiceId: 'INV-12' },
})
// send_invoice is high-sensitivity and irreversible: nothing ran.
// outcome.status === 'confirmation_required'
// outcome.confirmation = { token, expiresAt, tool, summary: 'Email invoice INV-12 to its customer' }

// Later, once a human has said yes in the host's own interface:
await bridge.executeConfirmed(alice, outcome.confirmation.token) // { status: 'ok', … }
// …or no:
await bridge.revokeConfirmation(alice, outcome.confirmation.token)
```

Every outcome is a value, never an exception: `ok`, `tool_error`, `invalid_arguments`,
`confirmation_required` or `rejected`, each with the `callId` found in the audit log.

## Serving over MCP

`serveStdio` serves the bridge over stdin/stdout, for one principal fixed when the
process starts:

```ts
import { parsePrincipal, serveStdio } from 'mcp-tool-bridge'

await serveStdio(bridge, {
  info: { name: 'billing-tools', version: '1.0.0' },
  principal: parsePrincipal({ id: 'alice', roles: ['billing'] }),
})
```

For another transport, `createMcpServer(bridge, options)` returns the SDK's `Server`,
ready to connect.

On the wire:

- `tools/list` returns the principal's tools only. The server announces
  `tools.listChanged` and notifies the client whenever the registry changes.
- An unknown tool, or a tool the principal may not use, is a JSON-RPC error
  (`-32602 Unknown tool: …`), the same for both. Invalid arguments and handler failures
  are results with `isError: true`, which the model can read and act on.
- A call that needs confirmation is resolved in one of two ways:
  - **The client supports elicitation:** the server asks the user through the client
    and runs the call on a yes. A no, or a dismissed question, withdraws it.
  - **It does not, or elicitation is turned off** (`elicitConfirmations: false`): the
    result says that confirmation is pending, and the token travels in the result's
    `_meta` under `mcp-tool-bridge/confirmation`. To redeem it, the host repeats the same
    call with `{ token }` under the same key in the request's `_meta`, after a human said
    yes. The model has no way to do this: it writes arguments, not `_meta`, and a token
    placed in the arguments is ignored.

Install it in an MCP client such as Claude Code with
`claude mcp add billing -- npx tsx path/to/server.ts`.

## Design decisions

### At a glance

**Tools are frozen descriptors that only the bridge can run.** `defineTool` returns an
immutable description that holds no reference to the handler. The handler is kept
privately and only the bridge can reach it, so every execution goes through the same
checks: role, arguments, confirmation, audit. No code in the host can call a handler
by mistake, and no one can widen a tool's roles after its declaration has been checked.

**`roles` is required and cannot be empty.** A tool without roles would be open to
everyone or to no one. Either way, that is a decision someone must make, and make
visibly. Failing at startup turns a forgotten line into an error the developer sees
immediately. Otherwise it would surface in production as a tool silently open to all,
or silently dead.

**The same function decides access for the list and for the call.** The access rule
lives in one place, `canAccess`. The list hides what a principal cannot use. The call
checks again, because a client can send any tool name and roles can change in between.
Two implementations would end up disagreeing. Either the model is shown tools it cannot
call, or, worse, it can call tools it is never shown.

### Why a declarative registry

A tool is two things: code that does something, and facts about that code. How sensitive
is it? Can it be undone? Who may use it? What arguments does it accept? In most agent
code these facts live in the head of whoever wrote the handler. At best they are
scattered: an `if` in the handler, a sentence in the system prompt, a comment.

Here they are fields of the declaration, and the governance fields (`sensitivity`,
`reversible`, `roles`) have **no default**. A tool nobody classified does not start. It
does not silently become "low sensitivity, everyone". Because the facts are data, the
bridge can apply one policy to every tool. It can also hand the facts to a reviewer, or
to an audit, as a table rather than as code to read.

The registry only accepts descriptors created by `defineTool`, which checks the whole
declaration at startup. A descriptor carries no handle on the handler: the only way to
run a tool is through the bridge and its checks. A copy made with `{ ...tool }`
type-checks, but registering it is refused.

### Why filter twice

The access rule is one function, `canAccess(tool, principal)`: the principal must hold
at least one of the tool's roles. Names are compared exactly. There is no wildcard and
no hierarchy, so anyone can read who has access to what from the declarations alone.

The bridge applies this rule twice: when it lists tools for a principal, and again when
it executes a call. Two reasons:

- **The list is a convenience, not a barrier.** Hiding a tool keeps it out of the
  model's context. It saves tokens and avoids tempting the model with a tool it cannot
  use. But nothing forces a client to call only the tools it was shown. A model can
  hallucinate a name, a prompt injection can supply one, a client can be buggy or
  hostile. The check that matters is the one made when the call is executed.
- **Time passes between the two.** Roles can be revoked and tools unregistered while a
  session is open. The decision is taken again, at the moment the effect would happen.

A call refused for lack of a role gets the same answer as a call to a tool that does not
exist (`unknown_tool`), so probing names reveals nothing. The audit log still records
the real reason.

### Why validate on the server

The argument schema is declared once and serves two purposes: the JSON Schema shown to
the model, and the check enforced before the handler runs. Both adapters (`jsonSchema`
and `zodSchema`) derive the two from the same declaration, so they cannot drift apart.
The handler's argument type is inferred from the same source.

Validation is strict on purpose:

- **No coercion.** `"3"` is not a number. A model that gets a type wrong should be told
  so, not second-guessed.
- **Defaults are not applied.** In a JSON Schema, `default` tells the model what happens
  if it leaves a field out. The handler decides what that means. The inferred type keeps
  defaulted properties optional, so the handler cannot assume they are present.
- **Only plain JSON gets in.** Arguments are deep-copied, and anything that is not JSON
  (dates, functions, class instances, cycles, `NaN`) is rejected. The handler, the audit
  log and the confirmation guard each see a value that nobody else can mutate.
- **Bad schemas fail at startup.** JSON Schemas are compiled with Ajv in strict mode.
  Unknown keywords, unknown formats and `required` properties that are never declared
  are errors. A Zod type with no JSON equivalent (`z.date()`, `z.bigint()`) is refused
  too, because the model could never send it.

Rejected arguments come back to the model as a tool result, with one JSON Pointer and
one message per problem (`/to: must match format "email"`). The model can then correct
itself, and the handler never sees the bad input.

### Why the confirmation lives on the server, not in the prompt

"Ask the user before sending anything" in a system prompt is a request made to the
model, and the model is the very component the guard protects against. It can lose the
instruction in a long context. A prompt injection can override it. It can judge that
this case does not count. And nothing in the code enforces it.

The guard is code on the execution path. A tool whose declaration says
`sensitivity: 'high'` (or `'medium'` and irreversible) returns `confirmation_required`
instead of running, and the handler cannot be reached without a valid token. The
decision comes from the declaration, not from the model's reading of the situation: the
same tool is always confirmed, or never.

The token is built so that approving one thing cannot authorise another:

- **Bound to the call.** A token belongs to one principal, one tool and the exact
  arguments. Key order does not matter, values do. Approving "email invoice INV-12"
  cannot email INV-13, and a token presented by anyone else is refused.
- **Single-use.** Redeeming takes the record out of the store in one atomic step. Two
  concurrent redemptions cannot both run.
- **Short-lived.** Five minutes by default.
- **Never stored.** The store keeps a SHA-256 hash. Whoever can read the store cannot
  redeem anything.
- **Checked again.** At redemption the role is checked again and the arguments are
  revalidated against the tool registered at that moment. The arguments that run are
  the ones that were confirmed, frozen when the confirmation was issued.
- **Not for the model.** The token is meant for the host. The MCP server carries it in
  the result's `_meta`, which MCP clients are not expected to pass to the model,
  while the model only reads that confirmation is pending. The host redeems it after a
  human decision: by repeating the call with the token, by calling `executeConfirmed()`
  later, or through MCP elicitation when the client supports it. There is deliberately
  no `confirm_action` tool. A model under prompt injection would simply call it, and the
  guard would be reduced to a delay.

### What the guard does not cover

The guard stops the model from running a sensitive call on its own. It does not make
the system safe by itself. Each limit below comes with what you should put in place
around it.

- **A compromised host or client.** Whoever controls the MCP client can attach a token
  it was given and replay a decision: the guard protects against the model, not against
  the host.
  _Put in place:_ run the client in a component you control, authenticate it (the
  `authenticate` hook of the HTTP transport, in v1.1), and keep the tokens it receives
  in memory, out of logs and transcripts.
- **A host that shows the token to the model.** If a host copies `_meta`, or the whole
  outcome, into the conversation, the model can confirm its own calls, and the guard is
  gone.
  _Put in place:_ strip `_meta` and confirmation outcomes before anything reaches the
  model's context, and add a test that fails if `mtb_` (the token prefix) ever appears
  in a transcript.
- **Misclassified tools.** Below the threshold, tools run directly. A tool declared
  `low` that actually deletes data is not caught.
  _Put in place:_ review declarations like permissions: print `registry.list()` as a
  table (name, sensitivity, reversible, roles) in code review, and require a second
  reviewer for any new or reclassified tool.
- **What the handler really does.** The guard confirms a call, not the behaviour of the
  code behind it.
  _Put in place:_ give each handler credentials scoped to the one effect its declaration
  describes, so that it cannot do more even by mistake.
- **Information leaving through reads.** `sensitivity: 'none'` tools run freely. A
  model can read data and repeat it elsewhere. Confirmation governs actions, not
  information flow.
  _Put in place:_ restrict reads of personal or confidential data by role, return only
  the fields the task needs, and watch the audit log for unusual read volumes.
- **The quality of the human decision.** The guard makes sure someone confirmed. It
  cannot make sure they read what they confirmed.
  _Put in place:_ write `summarize` for the person who confirms (what happens, to whom,
  with what consequence) and show it next to the arguments, never as a bare "Confirm?".
- **A world that changed.** Roles and arguments are checked again at redemption, but
  the invoice may have been paid in the meantime.
  _Put in place:_ have handlers check their preconditions when they run (invoice still
  unpaid, slot still free) and throw a `ToolError` otherwise, and shorten `ttlMs` where
  the context moves fast.
- **Timeouts.** A handler that ignores its abort signal keeps running after the bridge
  has given up. Its result is discarded, but its effects are not undone.
  _Put in place:_ pass `call.signal` to every I/O the handler starts (`fetch` and most
  database drivers accept one) and make side effects idempotent, so that a cancelled
  call either stops or can be retried safely.
- **Several processes.** The default store lives in one process. A token issued by one
  instance cannot be redeemed on another.
  _Put in place:_ before running a second instance, implement `ConfirmationStore` over
  shared storage with an atomic `take` (Redis `GETDEL`, SQL `DELETE … RETURNING`).

### Why the audit log records before running

Each call that runs leaves two events under one `callId`: `call.started`, then
`call.succeeded` or `call.failed`. A confirmed call is preceded by `confirmation.issued`
and possibly `confirmation.declined`, under the same id. Rejections are recorded with
their real reason (`forbidden`, `invalid_arguments`, an invalid or expired confirmation),
even when the model is told `unknown_tool`.

`call.started` is written before the handler runs, so the log knows about the call even
if the process dies during it. With `auditFailure: 'block'`, a call or a confirmation
that could not be recorded does not happen. The default, `continue`, warns on stderr and
proceeds. Events that follow an effect (`call.succeeded`, `call.failed`) can only be
reported: the effect has already happened.

Arguments and results are logged masked. Keys that look like secrets (`password`,
`token`, `apiKey`, `authorization`, `secret`, `cookie`…) are masked anywhere, along
with each tool's own `redact` pointers. Result text is truncated. Messages of unexpected
exceptions go to the log only; the model gets a generic failure. The default sink writes
JSON lines to stderr, because under stdio, stdout is the protocol channel.

## Declaring tools: reference

| Field         | Required | Meaning                                                                                                                                           |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | Unique in a registry. MCP allows `A-Z a-z 0-9 _ - .`, 1–128 characters. Some LLM APIs are stricter (no dots, 64 characters): prefer `snake_case`. |
| `description` | yes      | What the model reads to decide whether and how to call the tool.                                                                                  |
| `args`        | yes      | `jsonSchema({...})` or `zodSchema(z.object({...}))`. The root must be an object.                                                                  |
| `sensitivity` | yes      | `none` (no side effect at all), `low`, `medium`, `high`, `critical`.                                                                              |
| `reversible`  | yes      | Can the effect be undone?                                                                                                                         |
| `roles`       | yes      | Non-empty. A principal needs one of them.                                                                                                         |
| `confirm`     | no       | `auto` (default: the bridge's policy decides) or `always`. There is no opt-out.                                                                   |
| `summarize`   | no       | One sentence describing a specific call, shown to whoever confirms it.                                                                            |
| `redact`      | no       | JSON Pointers masked in the audit log.                                                                                                            |
| `timeoutMs`   | no       | Per-call time limit.                                                                                                                              |
| `title`       | no       | Human-readable name.                                                                                                                              |

Behaviour hints sent to MCP clients are derived from the declaration. `readOnlyHint`
is true for `sensitivity: "none"`. `destructiveHint` is true for irreversible tools that
have an effect. Roles and sensitivity levels are never sent to the client.

Handlers throw `ToolError` for failures the model may read ("no invoice INV-12"). Any
other exception reaches the model as a generic failure; its details go to the audit log.

## Roadmap

**v1.0**: declarations and registry, role-based access, validation (JSON Schema and
Zod), the confirmation guard with single-use tokens and MCP elicitation, the audit log,
the `envelope` adapter, the stdio transport, a three-tool example.

**v1.1**:

- `adapt()`: wrap an existing function as a handler, mapping its input and output,
  without rewriting it.
- `importDefinitions()`: turn a batch of Anthropic/OpenAI-style definitions
  (`{ name, description, input_schema }`) and one dispatcher into tools. Governance must
  be declared for every name; a missing entry fails at startup.
- HTTP transport: Streamable HTTP, with a per-request `authenticate` hook,
  Origin/Host checks and sessions bound to the principal who opened them. The deprecated
  HTTP+SSE transport will be available behind `legacySse: true`.

Out of scope for now: an OAuth authorization server, MCP resources and prompts, retries
and rate limiting.

## Development

```sh
npm ci
npm run lint && npm run format:check && npm run typecheck
npm test
npm run build && npm run check:dist
npm run check:mutations
```

The tests make no network calls.

The safety guards are checked by **targeted mutation testing**: `npm run
check:mutations` removes each guard in turn and fails if the test suite still passes.
Five guards are covered:

- the role is checked again at call time;
- a confirmation token is single-use;
- a token only runs the exact arguments it was issued for;
- the role is checked again when a confirmation is redeemed;
- the token never appears in what the model reads.

CI runs this on every push. See [CONTRIBUTING](./CONTRIBUTING.md#mutation-checks) for
the mutants and the tests that catch them.

## License

[MIT](./LICENSE)
