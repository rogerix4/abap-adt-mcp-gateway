# AGENTS.md

Notes for an AI agent that works **on this repository** (not with it). Using the server from a
client is covered by the [README](README.md) and [docs/USAGE.md](docs/USAGE.md).

## Ground rules

1. **`src/` is the only source of truth.** `dist/` is `npm run build` output — never edit it.
2. **Build and verify before you claim anything.** `npm run build`, then
 `node dist/bin.js --coverage` (335/335), then `npm run verify` (it type-checks `tests/` too —
 vitest alone would let a type error through).
3. **The contract is frozen.** The 335 tool names, descriptions and schemas live in
 `tools/catalog.json`. A new capability is a new tool; changing the catalog means regenerating
 `adt-mcp.schema.json` and `docs/TOOLS.md`, and `npm run verify` will tell you if you forgot.
4. **No invented ADT endpoints.** If a surface does not exist in ADT, the tool answers
 `NOT_IMPLEMENTED` with SAP's own reason, or the capability goes into an ABAP bridge module in
 `abap/` with a test that proves it works on a real system.
5. **A shape you cannot read is not a success.** New readers fail closed: an answer in an unknown
 shape raises `unrecognized-response` (check) or sets `ok: false` with `unrecognized`
 (activation). Do not add one more regex branch and leave the fall-through returning zero.
6. **Parse markup, do not match it.** ADT answers are read through `fast-xml-parser` and edited
 through the offset scanner in `src/adt/xml-scan.ts`; a regex over XML cannot nest and breaks on
 a `>` inside a quoted value.
7. **Examples carry placeholder names only**: `ZDEMO_*`, `DEVK…`, `$TMP`. `verify:private` fails
 on a transport number that is not `DEVK…`; a real customer object name is a defect a reviewer
 must reject the same way.
8. **English** in code, comments, commit messages and documentation. The only non-English
 literals allowed are the message wordings in `src/adt/signals.ts` — they are matched against
 what SAP sends, and a translated pattern never fires.

## Cross-platform and cross-client

- Every path goes through `node:path` and the helpers in `src/config/defaults.ts`. Do not
 hard-code `\\`, `%APPDATA%` or `/home`: the user layer is `%APPDATA%` on Windows and
 `$XDG_CONFIG_HOME` (falling back to `~/.config`) elsewhere, and a test that asserts a separator
 only passes on the machine it was written on.
- Behaviour must be identical on Windows, macOS and Linux. The lock journal already falls back
 from `LOCALAPPDATA` to `HOME`; new storage follows the same rule.
- The transport is stdio and stays stdio. No client-specific handshake, resource, prompt or
 sampling: every client gets the same contract, filtered by `toolPolicy`.
- Assume the client cannot pass 335 tools. The default exposure is three, so a new tool must be
 reachable through `GatewayCallTool` without being advertised.
- Documentation that names a client names its key (`servers` vs `mcpServers`) and says that the
 client's own documentation is authoritative for where the file lives. Do not guess a path you
 have not seen; mark it as typical.

## Project structure

```text
src/bin.ts CLI: serve / --coverage / --version / --help / --config
src/runtime.ts systems, sessions, write queues
tools/catalog.json the frozen 335-tool contract
docs/ behaviour docs (USAGE, OPERATIONS, CONFIGURATION, ARCHITECTURE, TROUBLESHOOTING)
src/adt/ ADT primitives: session, lifecycle, errors, xml, xml-scan, xml-patch, signals, rfc
src/families/ objects as families (create/read/update/check/activate/delete) + descriptors
src/tools/ tools that are not an object family (SQL preview, analysis, smartforms, profiler, routes)
src/engine/ registry, exposure levels, error types
src/config/ layers, schema, secrets
src/core/ catalog and layer map
tests/ 24 vitest files; offline tests use a scripted fetch
abap/ remote-enabled bridge modules (screens, CUA, text pools, SmartForms)
```

New behaviour goes into the narrowest folder that owns it; a tool that needs a new ADT
primitive gets it in `src/adt/`, not in the tool handler.

## Before you push

- [ ] `npm run build` and `node dist/bin.js --coverage` reads **335/335**
- [ ] `npm run verify` is green (contract, secrets, deprecations, both tsconfigs, generated files, tests)
- [ ] A behaviour change has a test that fails without it; a new shape has a fixture from a real answer
- [ ] `docs/USAGE.md` says the same thing the code now does — it is the calling-side truth
- [ ] `docs/TOOLS.md` / `adt-mcp.schema.json` regenerated if `tools/catalog.json` changed
- [ ] No real system id, object name, transport number or home path in the diff

## Common errors and what they mean

| Symptom | Cause | Fix |
|---|---|---|
| Every call answers `SYSTEM_UNKNOWN` | No configuration was read (this is the normal state of a fresh clone) | Write `adt-mcp.config.jsonc` next to `dist/`, or pass `--config` |
| The advertised tool count is not what you configured | The running process predates the build, or its working directory has no config | `node tools/scripts/mcp-status.mjs`; restart the client |
| `unrecognized-response`, or `activated: false` with `unrecognized` | SAP answered a document the parser did not understand | Read `sapText` / `status`; add a fixture and teach the parser — do not add a regex branch |
| `CONTENT_MISMATCH` | `expected_line_count` / `sha256` / `patch.expected_count` did not match | Re-read the active source and rebuild the payload; nothing was written |
| `locked` although nobody edits the object | An editor tab holds the enqueue, or a previous process left a handle | Close the tab; check the lock journal; clear in SM12 only as a last resort |
| A write reports `written: true, activated: false` | The source landed as an inactive version | Fix the cause and write again; do not treat it as done |

## Where to look

| Question | File |
|---|---|
| How a call travels, how several systems stay online together, why locks are journalled, how activation is verified | `docs/ARCHITECTURE.md` |
| Write boundary, tiers, configuration layers, advertised surface, onboarding a system | `docs/OPERATIONS.md` |
| How the calling side must drive the tools, the error codes, and the traps that cost a session each | `docs/USAGE.md` |
| A tool's arguments | `docs/TOOLS.md` (generated) |
| Why something answers oddly | `docs/TROUBLESHOOTING.md` |
| The ABAP side | `abap/README.md` |

`docs/USAGE.md` is the one place that teaches the calling side. When behaviour changes, update it
there — do not restate its rules in code comments or in a second document.

## Working on a change

1. Change `src/**` (and `tests/**` for anything that can be tested without a system).
2. `npm run build` → `npm test` → `npm run verify`.
3. **Restart the client's server process** before you test anything live: a newer `dist/` proves
 nothing while a process started earlier is still serving the old code. `node
 tools/scripts/mcp-status.mjs` lists the gateway processes and whether they predate the build.
4. Anything that creates objects cleans up after itself: run-scoped names, `$TMP` unless it is a
 deliverable, read-back after delete, every lock returned.

## Verifying against a real system

The server needs `adt-mcp.config.jsonc`, and that file is **git-ignored on purpose** — a fresh
clone has no systems, and every call answers `SYSTEM_UNKNOWN`.

- Do not invent credentials or copy a config out of a document. Ask the user which system id to
 use and where the logon comes from (`keychain:` / `env:` / `file:` reference, never a literal).
- `node dist/bin.js --coverage` and `npm test` need no configuration; `probe-*`, `live:*` and any
 tool call do.
- The order that works: `node tools/scripts/probe-routes.mjs --profile <id>` (configuration +
 credentials + ADT reachability), then the capability you changed, then a read-back of what you
 wrote.
- Probe in `$TMP`, verify the deletion, and leave no draft behind.

## What not to do

- Do not hand-edit `dist/`, `adt-mcp.schema.json` or `docs/TOOLS.md` — they are generated.
- Do not widen the write boundary. `tier: "dev"` is the only writable tier, by design.
- Do not "fix" a refusal by retrying: the message names the reason, and the next step is to read
 it (`SYSTEM_READ_ONLY`, `NOT_IMPLEMENTED`, `UPSTREAM_FAILED` with `details`).
- Do not commit a real system id, transport number, object name or path from the machine you tested
 on. `npm run verify:private` catches some of it; the rest is on the review.
