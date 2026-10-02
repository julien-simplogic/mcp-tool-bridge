# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Work towards 1.0.0. Planned 1.1 features are listed in the README's Roadmap.

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
  `call.started`, `call.succeeded`, `call.failed`; masking of secret-looking
  keys and of per-tool pointers; `auditFailure: 'block' | 'continue'`;
  `stderrJsonSink()` and `memorySink()`.
- MCP server on the SDK's low-level `Server`: `createMcpServer()` and
  `serveStdio()`. Per-principal `tools/list`, `tools/list_changed`
  notifications, unknown and forbidden tools as the same `-32602` error,
  validation and handler failures as `isError` results. Confirmations through
  MCP elicitation when the client supports it, otherwise a pending result with
  the token in `_meta` (`CONFIRMATION_META_KEY`), redeemed by repeating the
  call with the token in the request's `_meta`.
- `envelope()`: plugs implementations that report failure in their return
  value (`{ success, data, error }`, `{ ok, detail }`…) into handlers.
- `examples/minimal`: a stdio server with a read, a reversible write and an
  irreversible send.
- Targeted mutation testing of the safety guards: `npm run check:mutations`,
  run in CI.
- ESM and CommonJS builds.
