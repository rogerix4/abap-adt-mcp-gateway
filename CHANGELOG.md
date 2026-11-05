# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-05

### Added

- **`GetAbapAST`, `GetAbapSemanticAnalysis`, `GetAbapSystemSymbols` are real tools now.**
  They parse the ABAP source with `@abaplint/core` and report the statement tree, the object
  model (classes, interfaces, forms, methods, parameters with directions, attributes,
  constants) and the symbols resolved against the connected system. The upstream server
  implements the same three tools with hand-written regular expressions.
- **`RenderSmartForm`** renders a form to PDF: the generated function module is called with
  `GETOTF` (no dialog, no print, no spool) and the OTF is converted with `CONVERT_OTF`; the
  OTF text and the PDF are written under the output directory.
- **SmartForm tools** (`GetSmartFormLayout`, `GetSmartFormContent`, `CreateSmartForm`,
  `DeleteSmartForm`) run through the new bridge modules in `abap/`; the layout and the node
  outline are derived from the Form Builder XML.
- **`CreateTransportLow`** sends `tm:target="LOCAL"`, matching the upstream client.
- `docs/OPERATIONS.md`, `docs/README.md` and `AGENTS.md`; the README now follows a public
  project structure with a "Why this gateway" section and an acknowledgment of the contract's
  origin.

### Changed

- **`UpdateUnitTest` and `DeleteUnitTest` are no longer advertised.** ADT answers HTTP 405 for
  `PUT` and `DELETE` on `/abapunit/runs/{id}`; both tools stay callable by name and reply with
  that reason instead of a guessed success.
- **All English.** The ABAP bridge sources, the TypeScript sources and the documentation are
  English throughout; Chinese text survives only where it matches SAP's own answers from a
  Chinese-locale system (`已锁定`, `未找到合适资源`, short-dump chapter titles).
- `scan-private.mjs` works without git: it honours `.gitignore` while walking the tree, so a
  downloaded ZIP can still run `npm run verify`.

### Fixed

- `SSFCOMPOSER/010` on SmartForm rendering: the RFC user needs a default output device
  (`USR01-SPLD`), because `GETOTF` takes the device from the user master and rejects an
  explicit one (`SSFCOMPOSER/016`).
- FORM-based interfaces (`BAPI_USER_CHANGE`, `CONVERT_OTF`) reject empty-key tables; the
  affected tables use `WITH DEFAULT KEY`.

## [0.1.0] - 2026-11-04

First release: a single-process, multi-system ABAP ADT MCP gateway serving a fixed
contract of 335 tools.

### Added

- **Frozen tool contract** — 335 tools in `tools/catalog.json`. Names, descriptions
  and parameter schemas are checked in both directions by `verify-catalog.mjs` and
  the contract tests. Every tool is registered at startup; one without a handler
  answers `NOT_IMPLEMENTED` instead of a plausible success.
- **`system` argument on every tool** — added to each tool schema at serve time and
  enumerated from the configured systems. Several systems without `system` is an
  error rather than a silent fallback.
- **One session per system** — `GatewayRuntime` owns an `AdtSession` per system and
  reuses it, so a lock handle stays valid across `Lock*Low` → `Update*Low`.
- **Tier boundary per call** — writes are refused for any system whose tier is not
  `dev`, decided from the request semantics (method ≠ GET, write RFC action) rather
  than from the tool name. A missing or misspelled tier is treated as production.
- **Lock journal** — object URL → lock handle on disk under
  `%LOCALAPPDATA%/abap-adt-mcp-gateway/locks-<hash>.json`. A stale handle is
  released before the next lock on the same object; unlock and delete clear it.
- **Serialized writes per system** — two writes against one stateful session would
  interleave LOCK and UNLOCK, so they are queued. Reads stay parallel.
- **Activation by content** — `activated: true` means the active version equals the
  source that was just written, not that an HTTP call returned 200.
- **ADT error classification** — stable codes (`auth`, `locked`, `invalid-lock`,
  `not-found`, `content-negotiation`, `check-failed`, `transport-required`,
  `upstream`, `network`), each with a `nextAction`, plus one automatic replay after
  a dead session or a lost CSRF token.
- **RFC bridge** — screens, CUA, text pools, job usage and transaction usage run over
  four remote-enabled function modules whose sources are in `abap/`.
  `tools/scripts/import-abap-bridges.mjs` installs them.
- **Layered JSONC configuration** — defaults → user → workspace → environment →
  command line, validated per layer so an error names the layer and the field path.
- **Credential references only** — `keychain:`, `env:`, `file:`. Plain text is
  rejected at startup and resolved secrets stay in memory.
- **Generated artefacts checked for drift** — `adt-mcp.schema.json`
  (`gen-schema.mjs`) and `docs/TOOLS.md` (`gen-tools-doc.mjs`).
- **Offline scripts** — `probe-routes.mjs`, `probe-bridge.mjs`,
  `import-abap-bridges.mjs`, `analyze-catalog.mjs`, `scan-private.mjs`,
  `check-deprecated.mjs`, and `profile.mjs` so the server and the scripts resolve
  credentials the same way.
- **Tests** — 124 across 12 files, all offline (scripted HTTP layer or
  `InMemoryTransport`).
