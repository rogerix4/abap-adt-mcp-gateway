# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-05

### Changed

- **`toolPolicy` takes one exposure level.** `layers: [...]` and `gateway: true|false` are
  replaced by `expose: "<level>"` — `none`, `gateway` (default), `readonly`, `write`, `low`,
  `high`, `full`, `core` — with `allow` and `deny` applied on top of the chosen level: `allow`
  keeps only matches, `deny` removes matches afterwards. The advertised size of each level is
  0, 3, 115, 86, 134, 201, 335 and 127 respectively, and every level is a complete description
  of what a client sees.
- **Default level is `gateway`.** Three tools reach the whole 335-tool contract by name, which
  fits clients that cap the tool budget. `"expose": "full"` advertises the contract itself.
- **The `Gateway*` facade is part of the level, not a separate switch.** `gateway` is `full`
  advertised as three tools; `core` advertises the facade in addition to its curated set
  because that level narrows the list; the remaining levels advertise no facade. Hidden tools
  remain callable by name and through `GatewayCallTool`; neither path bypasses the tier check.
- **Each tool has exactly one kind**, with `*Low` as a kind of its own: 115 `readonly`, 86
  `write`, 134 `low`. The levels are compositions of these kinds, so their sizes sum to 335.
  This also corrects the counts the previous preset script reported (124 / 77): it classified
  tools by verb prefix while the registry classifies by effect, which misplaced nine tools
  (`Handler*`, `WriteTextElementsBulk`, `RuntimeCreateProfilerTraceParameters`).
- **`tool-presets.mjs` reads the built engine** (`dist/engine/expose.js` and
  `dist/engine/create-registry.js`), so the level table and the printed counts come from the
  same code the server runs. `--level` is the argument; `--preset` is still accepted.
- **The `system` argument description states the actual requirement**: required when several
  systems are configured, optional when exactly one is. The previous text described a default
  for the multi-system case, which `runtime.resolve` does not apply.
- `docs/OPERATIONS.md` stated that an omitted `system` falls back to `defaultSystem`; with
  several systems configured it is required, as `docs/USAGE.md` and `runtime.resolve` specify.
- `README` §Architecture and `docs/ARCHITECTURE.md` now describe the multi-system model: every
  configured system keeps a live ADT session, reads are never queued, and writes queue per
  system.

### Added

- **`tests/expose.test.ts`**: pins the advertised size of every level, the kind partition, the
  rule that `allow` narrows but cannot widen a level's own curation, and which levels carry the
  facade.
- **Write-concurrency tests for several systems** in `tests/contract.test.ts`: writes to
  different systems overlap, and two writes to the same system are serialised.
- **Regression tests for GUI status creation and SQL preview**: `tests/cua.test.ts` pins
  the single-status reference copy, `tests/sql-query.test.ts` pins the `SELECT` precheck,
  and `tests/check-retry.test.ts` covers the inactive-to-active check fallback.

### Fixed

- **GUI status lifecycle is consistent for programs without a CUA.** `GetGuiStatus`,
  `GetGuiStatusList` and `ReadGuiStatus` treat `RS_CUA_INTERNAL_FETCH` subrc 1 as an
  empty status set (`count: 0`) instead of an upstream failure. `CreateGuiStatus` copies
  exactly one status from the reference CUA, including only the `SET`, `FUN`, `PFK` and
  `BUT` rows that status refers to, and refuses a program that already owns a CUA.
- **`UpdateGuiStatus` and `UpdateGuiStatusLow` perform a true full-document replace.**
  They no longer pre-fetch the target CUA, so the first status can be created; `cua_data`
  accepts either a structured object or a JSON string, and an empty `STA` is rejected
  instead of silently wiping the definition.
- **CUA writes carry the mandatory `TRKEY`** to `RS_CUA_INTERNAL_WRITE`, so the status is
  recorded in the program's transport task.
- **The ABAP check no longer reports a missing `REPORT`/`PROGRAM` statement for a program
  that has one.** When the inactive check answers that message but the inactive source
  carries the statement, the gateway resets the session once and falls back to the active
  version; the same contradiction on an active check is reported as `unavailable` rather
  than a compile error. Check message texts are XML-decoded.
- **`Validate*Low` states that it checks name availability**: it returns `exists`,
  `validation_kind: "name_availability"` and points callers to `Check*` for syntax
  validation of an existing object.
- **`GetSqlQuery` validates the statement before calling Data Preview**: it accepts one
  `SELECT`, caps `row_number` at 5000, requests one extra row so `truncated` reflects
  whether more rows exist, and maps syntax or temporary-pool failures to
  `INVALID_ARGUMENT` / `UPSTREAM_FAILED` with actionable guidance.

### Deprecated

- `toolPolicy.layers` and `toolPolicy.gateway` are still accepted. They are mapped onto the
  nearest level, and a message on stderr names the level that was applied and any difference
  (`docs/CONFIGURATION.md` §5 documents the mapping).

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
