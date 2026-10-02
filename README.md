# mcp-tool-bridge

A generic [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a
catalog of **declared** tools to a model, filters them by role, validates every argument
and holds sensitive calls behind a confirmation the model cannot give itself.

You declare what a tool is (its arguments, how much harm it can do, whether it can be
undone, who may use it); the bridge enforces it on every call, whatever the model says.

> **Status: v1 in progress.** Implemented: tool declarations, the registry, role-based
> access and argument validation. Next: the confirmation guard, the audit log, the stdio
> server, the `envelope` adapter and a runnable example. Nothing is published yet.

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

_Written together with the guard itself, in the next step. This section will also list
what the guard does **not** protect against._

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

**v1.0** (in progress): declarations and registry, role-based access, validation
(JSON Schema and Zod), the confirmation guard with single-use tokens, the audit log, the
`envelope` adapter, the stdio transport, a three-tool example.

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
```

The tests make no network calls.

## License

[MIT](./LICENSE)
