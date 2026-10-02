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
- ESM and CommonJS builds.
