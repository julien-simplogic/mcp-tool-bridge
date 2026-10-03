# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-10-03

### Fixed

- `ConfirmationTtlTable`, the type of the per-class lifetime table accepted by
  `confirmation.ttlMs`, is now exported from the package entry point. It was
  declared but only reachable through `Parameters<typeof createBridge>`. The
  lifetime tests now type their table from the public entry point, so a
  missing export fails the typecheck.

## [1.1.0] - 2026-10-02

### Added

- `adapt()`: wraps an existing function as a handler; `input` maps the
  validated arguments to what it expects, `output` maps its result back.
- `importDefinitions()`: turns Anthropic, MCP or OpenAI tool definitions and
  one dispatcher into tools. Governance (sensitivity, reversibility, roles) is
  required for every tool; a missing or unknown entry fails at startup, and
  then no tool starts.
- Confirmation lifetimes per sensitivity and reversibility
  (`confirmation.ttlMs` accepts a table). The expiry is computed at issue time
  and stored with the confirmation.
- Audit retention: a tool declares, with JSON Pointers, which argument and
  result fields the audit log may keep (`audit: { args, result }`, `*`
  allowed).
- Audit events carry `argsDigest`, and rejections of confirmation tokens carry
  their reason (`detail`): `unknown`, `consumed`, `expired`,
  `principal_mismatch`, `tool_mismatch`, `arguments_mismatch`.

### Changed

- The audit log keeps no argument or result content by default: metadata
  only. Arguments are reduced when the call's audit scope is built, never at
  serialization. Confirmation summaries are no longer recorded.
- `ConfirmationStore.take(tokenHash, now)` checks the expiry in the same
  atomic step and returns why: `taken`, `expired`, `consumed`, `unknown`. The
  memory store remembers consumed tokens, bounded in number
  (`maxConsumed`) and in time (`consumedRetentionMs`).
- A refused confirmation reads the same to the model whatever the reason.
- The `redact` field of tool declarations is replaced by `audit`.
- The published package ships `dist`, `README.md` and `LICENSE` only, without
  sourcemaps; `check:dist` fails on any absolute path of the build machine.

## [1.0.0] - 2026-10-02

### Added

- `defineTool()`: declarative tool definitions, checked in full at startup. The
  governance fields (`sensitivity`, `reversible`, `roles`) have no default.
- `ToolRegistry`: all-or-nothing registration, duplicate detection, change
  notifications. Only accepts tools created by `defineTool()`.
- Role-based access: `canAccess()`, `visibleTools()`, `parsePrincipal()`.
- Argument schemas: `jsonSchema()` (Ajv, draft 2020-12, strict) with type
  inference, and `zodSchema()` (Zod 4) under `mcp-tool-bridge/zod`.
- `exposeTool()`: what the model sees of a tool, with MCP behaviour hints.
- Result helpers: `text()`, `json()`.
- `createBridge()`: `listTools()`, `callTool()`, `executeConfirmed()`,
  `revokeConfirmation()`. Access checked again at call time; refusals for lack
  of a role answer `unknown_tool`. Timeouts and cancellation through
  `AbortSignal`. Every outcome is a value carrying the audit `callId`.
- Confirmation guard: `requiresConfirmation()` (threshold, irreversible tools
  one level earlier, `confirm: 'always'`), single-use tokens bound to the
  principal, the tool and the exact arguments, stored hashed, with a TTL;
  `ConfirmationStore` interface and `MemoryConfirmationStore`.
- Audit log: `call.rejected`, `confirmation.issued`, `confirmation.declined`,
  `call.started`, `call.succeeded`, `call.failed`; `auditFailure: 'block' |
'continue'`; `stderrJsonSink()` and `memorySink()`.
- MCP server on the SDK's low-level `Server`: `createMcpServer()` and
  `serveStdio()`, with confirmations through MCP elicitation or a token in
  `_meta`.
- `envelope()`, `examples/minimal`, targeted mutation testing
  (`npm run check:mutations`), ESM and CommonJS builds.
