# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`tools/scripts/live-cleanup.mjs` removes what a write sweep leaves behind.** It runs a plan of
 `{ tool, args }` steps through the same registry the server uses, so the leftovers of a
 `--allow-writes` run are deleted by data instead of by hand; a wrong name is visible in the plan
 file rather than computed inside the script. Order is the plan's business (structures and tables
 before the data elements they reference, data elements before their domains).
- **`Update*` accepts `source_file`, `patch` and payload fingerprints.** `source_file` reads the
 payload from a local UTF-8 file instead of requiring it inline; `patch`
 (`[{old, new, expected_count}]`) applies replacements to the active source in the gateway, so
 unchanged lines are never re-sent; `expected_line_count` / `expected_sha256` abort with the new
 `CONTENT_MISMATCH` code before any lock or write. `check_no_change` answers `no_change: true`
 without locking when the active version already equals the payload.
- **Update responses report `line_count`, `sha256` and `transport_used`**, so callers can verify the
 write and know which request carried it. An `activate: false` write additionally returns a `note`
 stating that an inactive version was left behind.

### Changed

- **`live-families.mjs` resolves `--profile` the way the server does.** It used to parse a `.env`
 file itself, so a system id from `adt-mcp.config.jsonc` — the form every other entry point takes —
 answered `ENOENT`. It now goes through `profile.mjs`, which is the one place that maps a system to
 its logon; a script with its own reader can be pointed at a different host than the server it is
 testing.
- **`live-families.mjs` reports what it could not clean up.** A failed fallback delete was
 `.catch(() => undefined)`: a fully green run could still leave the object in the system. A failure
 is now a FAIL row (404 counts as gone), and the run ends with the list of objects that may still
 exist.
- **`live-families.mjs` checks every argument against the declared schema.** Keys a tool does not
 declare are dropped and printed as `unused arguments dropped (…)`, so a fixture that fell behind
 the contract shows up in the output instead of turning a whole family red with
 `INVALID_ARGUMENT` — or, worse, being passed along silently.
- **`live-families.mjs` can write the same coverage report `live-tools.mjs` reads.** `--report
 <path>` writes `{ tools: [...] }`, accumulated across runs, so `live-tools --check families.json`
 can union both sweeps into one "335 of 335 exercised" answer. The flag was already described in
 `live-tools.mjs`'s header but the script never had it, so the documented flow had no producer.
- **`CreateTransport` no longer claims `target_system` is optional.** The handler has refused an
 empty target since a user ruling ("the target system always has to be given") and the schema still
 promised `If not provided or empty, uses 'LOCAL'`. The contract now lists `target_system` under
 `required` and its description names `E070-TARSYSTEM`, so the refusal arrives from the argument
 check instead of from inside the handler.
- **The tool catalog is re-read when it changes on disk.** Schema and description edits in
 `tools/catalog.json` take effect on the next `tools/list` instead of requiring a process restart;
 code changes still require a new process. The advertised tool surface never grows or shrinks at
 runtime — only its descriptions and arguments are refreshed.
- **Tests are type-checked.** `npm run verify` now runs `tsc -p tsconfig.test.json` over `src` and
 `tests`. Vitest only transpiles, so a type error in a test used to reach a green build — one did.
- **ADT answers are read with a real parser.** `fast-xml-parser` is a direct dependency now (it was
 already in the tree through `@abaplint/core`). The activation and check readers walk the element
 tree instead of matching markup, so a namespace prefix, a nesting level or a reporter wrapper
 needs no new branch. Measured live: the activation report puts its text in
 `<msg><shortText><txt>…</txt></shortText></msg>`, the check report in a `chkrun:shortText`
 attribute — both are read by the same code.
- **XML patching locates spans instead of matching markup.** `patchElement` / `patchAttribute` /
 `patchBlock` use a depth-aware scanner (`src/adt/xml-scan.ts`): nested same-name elements, a `>`
 inside a quoted attribute value, and tags inside comments or CDATA are handled. The document is
 still byte-identical outside the replaced span — it is never re-serialised, because the document
 belongs to SAP. The one block lookup in the DDIC updater (`doma:outputInformation`) uses the same
 scanner instead of a regex.
- **`docs/USAGE.md` is the one place that teaches the calling side.** It documents the payload
 arguments (`source_file`, `patch`, the fingerprints), the complete error-code table including
 `CONTENT_MISMATCH` and `unrecognized-response`, and the answers that used to look successful
 without being so. `docs/README.md` names it as the starting point for a new agent or colleague,
 so a consumer does not have to keep a second copy of this knowledge.
- **`docs/USAGE.md` gained a "Working efficiently" table.** Fourteen measured traps that cost a
 session each — disk-wide searching for the server, guessed argument names, typing a large source
 inline, judging a change on another client, an editor tab holding the lock, Data Preview used as a
 database client, `SPRAS = 'ZH'`, waiting for a transportable object's `TADIR` row, and more. Each
 row says what it cost and what to do instead, so a new agent (or colleague) starts with the
 experience instead of repeating it.

### Fixed

- **`GetIncludesList` checks `object_type` against its own enum.** `object_type` is exempt from the
 registry's enum check because the generic `*ObjectLow` routes take far more ADT type ids than
 their enum lists — but this route is not generic: ADT answers an empty node structure for any
 other id, so the caller read "this object has no includes" instead of "that type does not own
 includes". It now answers `INVALID_ARGUMENT` with the four allowed values and never sends the
 request.
- **A write sweep now deletes the objects it created for the behaviour-definition groups.**
 `teardown()` had no `BehaviorDefinition` entry and never recorded the `bdef2` root view, so every
 `--cleanup` run left `ZC_MCP_LTROOT` (DDLS) and `ZI_MCP_LTCVEW` (BDEF) in `$TMP` while reporting
 all checks green. A created kind that the teardown table does not know is now a FAIL row instead
 of a silent `continue` — that silent branch is what hid the leak.
- **The family sweep runs against the current contract again.** It reported 76/86 with every
 failure an `INVALID_ARGUMENT` or a bare `Can't save due to errors in source`: `source_code` where
 the table and structure verbs take `ddl_code`, `package_name` on tools that do not declare it, a
 `session_id` sent to `UnlockClassLow` (which does not take it) and omitted from the ten unlock
 verbs that require it, a missing `CdsView` fixture, and a metadata extension sharing its view's
 name. All corrected against the declared contract; measured 136/136 on a live development system.
- **A metadata extension and its view can no longer be confused by the sweep.** The extension is
 now `<view>_MD` and the target view carries `@Metadata.allowExtensions: true`; without that
 annotation activation answers `Annotation 'Metadata.allowExtensions' missing in '<view>'` and the
 previous active source comes back.
- **The DDIC fixtures use data elements, not built-in types.** `abap.int4` in a table or structure
 DDL carries no description, label or F1 help; the fixtures now read back what `GetStructure`
 returns, including `@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE`.
- **`live-tools` no longer claims a teardown it does not perform.** Its `Delete*` steps probe the
 delete verb on a throwaway twin; the setup objects the other groups build on were never removed,
 so a green 231/231 run left 19 objects in `$TMP`. The header says so now, and a write run ends by
 printing the cleanup command.
- **An answer the gateway cannot read is no longer counted as success.** The activation parser
 treated every shape other than `<msg>` as "zero errors", and the check parser treated every shape
 other than a `chkrun` document as "zero messages" — both read as *activated* / *checked and
 clean*. Activation now sets `ok: false` plus `unrecognized`, and the check throws
 `unrecognized-response` with the raw text, so a shape that changes on a release fails loudly
 instead of silently. The platform's own empty report (`<chkl:messages>` with only
 `<chkl:properties>`, captured live) is recognised as a normal answer.
- **Entities in ADT text are decoded exactly once.** The activation path never decoded them, so an
 escape SAP sent once reached the caller as markup (`Unable to interpret
 "LO_WORKSHEET-&gt;SET_CELL("`), and other paths decoded `&amp;` before `&lt;`, turning a single
 escape into markup. One implementation now lives in `src/adt/xml.ts`, `&amp;` last.
- **Message-text classification no longer assumes English.** The answer follows the logon
 language, and not even the configured one reliably: the same check came back in Chinese on one
 system and in English on another. An English-only classifier fell through to the
 generic branch. The wording now lives in `src/adt/signals.ts`, one table with the evidence for
 every entry. The localised check wording was captured live: without it a healthy program was
 reported with one error.

## [0.3.0] - ### Changed

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
- **The CDS family is named `CdsView`.** The 13 former `View*` tools are not registered as
 aliases; callers migrate to `CdsView*`. This is a deliberate breaking rename in the
 frozen 335-tool contract.

### Added

- **`tests/expose.test.ts`**: pins the advertised size of every level, the kind partition, the
 rule that `allow` narrows but cannot widen a level's own curation, and which levels carry the
 facade.
- **Write-concurrency tests for several systems** in `tests/contract.test.ts`: writes to
 different systems overlap, and two writes to the same system are serialised.
- **Regression tests for GUI status creation and SQL preview**: `tests/cua.test.ts` pins
 the single-status reference copy, `tests/sql-query.test.ts` pins the `SELECT` precheck
 and the SQL failure classification, `tests/smartforms.test.ts` pins the create guard,
 and `tests/check-retry.test.ts` covers the inactive-to-active check fallback.
- **Service-binding regression coverage**: `tests/families.test.ts` verifies the 415 to
 v1 media-type retry during creation, and `tests/adt.test.ts` verifies that deletion is
 read back before success is reported.

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
- **Service binding creation performs the same preflight as the archived client.**
 It verifies the service definition and the installed OData binding type, runs the CTS
 check for transportable packages, then retries the media type required by release 754
 and generates the OData service metadata after activation. `activate:false` now stages
 the binding without activating it; the previous generic path activated it regardless.
- **Service binding deletion unpublishes and verifies before reporting success.** A
 published binding is unpublished before the lock/delete pair. If the generic DELETE
 returns 412, the gateway releases the lock, calls the deletion resource, and reads the
 binding back. A request that SAP accepts but does not execute is reported as `412` with
 the reason, not as `success: true`.
- **`Create*` honours `activate:false`.** The flag is applied in the shared create path,
 so a staged object is not activated or post-processed by an activation hook.
- **`CreateSmartForm` no longer reports a stored-but-ungenerated form as success.** When
 activation returns an active form without a generated function module, the tool answers
 `UPSTREAM_FAILED` with the form interface check as the next action, instead of leaving
 `RenderSmartForm` to fail later with "activate it first".
- **`GetSqlQuery` separates ADT internal 500s from invalid SQL.** `Invalid access with
 negative length to a string` is now `UPSTREAM_FAILED` (simplify the query or read the
 table directly), while unknown columns remain `INVALID_ARGUMENT`. The unknown-column
 hint names the recurring table mistakes: `AS4TEXT` belongs to `E07T` (not `E070`),
 `RBUKRS` belongs to `ACDOCA`/`FAGLFLEXT` (not `T001`), and `SPRAS` is a one-character
 language key (`'1'` on this system, not `'ZH'`).

### Deprecated

- `toolPolicy.layers` and `toolPolicy.gateway` are still accepted. They are mapped onto the
 nearest level, and a message on stderr names the level that was applied and any difference
 (`docs/CONFIGURATION.md` §5 documents the mapping).

## [0.2.0] - ### Added

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
 Chinese-locale system (lock refusals, missing-resource answers, short-dump chapter titles).
- `scan-private.mjs` works without git: it honours `.gitignore` while walking the tree, so a
 downloaded ZIP can still run `npm run verify`.

### Fixed

- `SSFCOMPOSER/010` on SmartForm rendering: the RFC user needs a default output device
 (`USR01-SPLD`), because `GETOTF` takes the device from the user master and rejects an
 explicit one (`SSFCOMPOSER/016`).
- FORM-based interfaces (`BAPI_USER_CHANGE`, `CONVERT_OTF`) reject empty-key tables; the
 affected tables use `WITH DEFAULT KEY`.

## [0.1.0] - First release: a single-process, multi-system ABAP ADT MCP gateway serving a fixed
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
