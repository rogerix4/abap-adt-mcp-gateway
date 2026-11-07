# Architecture

> Why the server is shaped the way it is. Read this before the code.

## Principles this code is held to

"Java's seven" read as SOLID plus the Law of Demeter and the Composite-Reuse Principle. The live
campaign of found four defects that were all *one* mistake: a fact declared in two places.
The table says what each principle asks for here, and what the refactor changed.

| Principle | Rule here | What was wrong, and what closed it |
|---|---|---|
| Single responsibility | dispatch decides *which* verb; families decide *how* | `handlers.ts` also built payloads and rolled back: the three write shapes moved to `families/update/{payloads,rollback}.ts`. It is still 1,130 lines and still owns per-verb orchestration |
| Open/closed | a new family is a new file, not an edit to a switch | `descriptors.ts` held all families in ~1,200 lines: it is a 92-line barrel now, and the 17 families live in `ddic/`, `oo/`, `cds/`, `program/`, `rap/`, `program.ts`, `package.ts`, `service-binding.ts` |
| Liskov | a declared capability must be honoured | a family that declares no text source used to answer `Check*Low → errors: 0` for text nobody read; the check verb now answers `errors: 0` **plus `unavailable`**, naming the capability that is missing |
| Interface segregation | `SourceFamily` / `DocumentFamily` / `Verifiable`, not one interface with 20 optionals | still one `ObjectFamily` with optional members; `spec/properties.ts` carries the per-family property spec so patch and read-back cannot diverge |
| Dependency inversion | handlers use ports, not `session` URLs | the write shapes moved out, but `update()` still builds `?lockHandle=…&corrNr=…` itself (`lowUpdateQuery`) |
| Law of Demeter | a handler gets a family and a name | handlers still walk `session → path → query` wherever the two rows above were not moved |
| Composite reuse | one `PropertySpec` per family, used by patch **and** verification | closed: one spec, three uses (`families/spec/properties.ts`) |

Two rules fall out, and would have prevented the whole batch:

1. **one spec, three uses** — the accepted keys, the markup they map to, and the read-back check come
 from the same object, so they cannot diverge;
2. **one capability, one interface** — a verb that needs `sourceParam` requires a `SourceFamily`, and
 the type system refuses a half-declared capability.

## Where ABAP text may live

Three kinds of text look alike and must not be confused:

| Kind | Belongs in | Why |
|---|---|---|
| **Protocol payload** — the XML body a `Create*` POST needs (`abapClass:abapClass`, `doma:domain`, …) | the adapter (`families/descriptors.ts`) | ADT has no "create with nothing": without the document SAP answers 400 |
| **Fixture** — `source: "WRITE / 'x'."` in a test | `tests/` only | it is the *input* under test; it never reaches a system |
| **Object skeleton** — `REPORT …`, `CLASS … DEFINITION`, DDL with annotations | **never in this repo** | it belongs to the system and the caller; it is read back (`GetTable`, `GetStructure`, `GetGuiStatus`) and edited |

The third row is a rule earned the hard way: a hand-written table DDL was assumed to be complete and
SAP refused it until `@AbapCatalog.enhancement.category: #NOT_EXTENSIBLE` was there. Anything the
compiler adds is not ours to memorise.

## Current layout

```text
src/
 adt/ AdtSession · RfcBridge · SoapBridge, lock journal, write, activate, check, read
 core/ the frozen catalog and the derived layer map
 engine/ registry (factory), exposure levels, error table
 families/ 17 families — one module per object type, plus spec/ and update/
 tools/ everything that is not a family: routes, reads, analysis, bridges, smart forms
 config/ layered config + secrets
 mcp/ tools/list and tools/call over stdio
```

The families were a single `descriptors.ts` until the refactor; what is left there is the
barrel that lists them. Where that refactor stands:

- done: one spec per family used by patch and read-back (`families/spec/`), the three write shapes in
 `families/update/`, `descriptors.ts` reduced to a barrel, error wording in one table
 (`adt/signals.ts`, both languages, each row with the answer that produced it);
- open: per-verb orchestration, rollback and document verification still live in `handlers.ts`
 (1,130 lines), and `update()` still writes `?lockHandle=` / `?corrNr=` itself;
- open: session decorators (existence, lock ledger, retry, enrichment) were never introduced — those
 are `adt/lifecycle.ts` helpers today.

Each step keeps the five invariants (`verify:catalog`, `verify:schema`, `verify:private`,
`check:tests`, `verify:docs`) green; `npm run verify` is the whole chain.

## Call path

```text
MCP client ──stdio──▶ dist/bin.js
 ├─ config/load.ts layered config + zod validation
 ├─ config/secrets.ts resolves keychain:/env:/file: into real credentials
 ├─ runtime.ts systems, tiers, one AdtSession per system
 └─ mcp/server.ts tools/list (adds `system`), tools/call (writes queued per system)
 └─ engine/registry.ts ─ handlers ─┬─ tools/routes.ts high level: one object, one route
 ├─ families/handlers.ts same-verb families
 └─ tools/bridges.ts what ADT lacks → RFC bridge
 └─ adt/session.ts HTTPS, ADT session, lock journal
```

One process. No child processes, no external engine, no patches over an installed package.
All configured systems are held at once — see [Multi-system concurrency](#multi-system-concurrency).

## Protocol layer

| | |
|---|---|
| Wire format | JSON-RPC 2.0 over stdio; stdout carries the protocol and nothing else, diagnostics go to stderr |
| Protocol versions | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` — the version the client asks for is echoed back (`@modelcontextprotocol/sdk` 1.32.2) |
| Capabilities | `tools` only, `listChanged: false`. The contract is fixed before the transport connects, so the list never changes after `initialize` |
| Advertised subset | `toolPolicy.expose` picks one level — `none` … `full`, plus `core`; the default is `gateway` (three tools, whole contract) — then `allow` / `deny` narrow it; the registry still holds all 335 and calls by name still work |
| The facade | `gateway` and `core` advertise `GatewayListSystems`, `GatewayListTools`, `GatewayCallTool` — three tools that reach the whole contract; `GatewayCallTool` runs writes through the same serialization and tier checks |
| Not advertised | resources, prompts, sampling, logging |
| Tool annotations | Derived per tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Advisory for clients; they never alter a name, description or schema |
| Transport | stdio only. There is no HTTP or SSE listener |

## The tool contract

- The 335 names, descriptions and input schemas in `tools/catalog.json` are a contract. `verify-catalog.mjs` and `contract.test.ts` compare both directions.
- The registry registers the whole contract up front; a tool without a handler answers `NOT_IMPLEMENTED` rather than a plausible success. `--coverage` reads 335/335.
- `Low` means "the caller owns the lock and the session": one tool call, one ADT request. It does not mean "the twin of the tool next to it" — 89 of the 134 `*Low` tools have no high-level sibling.
- `tools/layer-map.json` carries the metadata derived from each schema (needs a `lock_handle`, writes or not). Do not infer it from the name.

## Multi-system concurrency

`systems[]` is not a list of endpoints to pick from at startup — it is a set of sessions that are
alive at the same time.

```text
runtime.ts
 #entries: Map<system id, { system, session, sessionId: "sys:<id>" }>
 "dev" → AdtSession(dev.url, client 100) own cookie jar · CSRF · sap-adt-connection-id
 "qa" → AdtSession(qa.url, client 100) own cookie jar · CSRF · sap-adt-connection-id
 "prd" → AdtSession(prd.url, client 100) own cookie jar · CSRF · sap-adt-connection-id
```

- The `GatewayRuntime` constructor builds one `AdtSession` per configured system; no other part
 of the process holds a session, and there is no "current system" field that could drift.
- Sessions log on lazily: the first request to a system establishes it, and the same session —
 same cookies, same CSRF token, same `sap-adt-connection-id` — serves every later call.
 `sap-usercontext` is pinned to that system's client (`adt/session.ts`), and the connection id
 is what makes a lock handle valid in the next tool call.
- Selecting another system costs a `Map` lookup, not a logon. That is the whole point of the
 design: a conversation can read production while it writes development, and neither call
 waits for the other.

### What is kept apart

| Item | Keyed by | What goes wrong if it were shared |
|---|---|---|
| `AdtSession`: cookie jar, CSRF token, `sap-adt-connection-id`, `sap-usercontext` | system id | A lock handle and an activation are valid only in the session that created them |
| Write queue (`mcp/server.ts`, `writeChains`) | system id | Two writes in one stateful session interleave LOCK / UNLOCK and one strands a lock |
| Lock journal (`adt/lock-journal.ts`) | `sha1(base URL \| client \| user)` | Releasing a handle on a server that never issued it — and two logons of one system erasing each other |
| Tier (`runtime.resolve`) | system id, every call | Write permission is a property of the target, not of the caller |
| `session_id` (`sys:<id>`) | system id, validated | `Lock*Low` then `Update*Low` with another system's id would land in the wrong ABAP session |
| Bridge modules (`abap/`, `import-abap-bridges.mjs --profile <id>`) | installed into one system | A tool backed by a module the target lacks fails there only, instead of everywhere |

### What stays shared

| Item | Consequence |
|---|---|
| Configuration (layers, credential references, `defaultSystem`) | One file describes every system; `ReloadProfile` re-reads all of them |
| Tool contract (335 names, descriptions, schemas) | One advertised list for all systems — `system` is the routing argument, not a per-system variant of the same name |
| Advertised `system` enum, its description and `GatewayListSystems` | Built from the configuration at **startup**; `ReloadProfile` rebuilds sessions but not this list, so restart after changing the system set |
| `toolPolicy` | Narrowing the advertised list cannot make one system write-capable or read-only (that is the tier) |
| Lock journal directory | One file per system identity, in the same folder |
| Process | A crash or a reload drops every session; each system then logs on lazily again |

### Resolving a call

`runtime.resolve(system, sessionId, needsWrite)` decides, in this order:

1. `system ?? defaultSystem()` — `defaultSystem()` answers only when exactly one system is configured.
2. Nothing to resolve (no system configured, or several and none named) → `SYSTEM_UNKNOWN`, and the message lists the ids.
3. Unknown id → `SYSTEM_UNKNOWN` with the ids it does know.
4. `session_id` naming another system → `INVALID_ARGUMENT` with the expected one.
5. `needsWrite` on a tier other than `dev` → `SYSTEM_READ_ONLY` with `system` and `tier`.

`defaultSystem` in the configuration is a default for the description text and the
`GatewayListSystems` answer. With several systems configured it does **not** make `system`
optional, and it never redirects a call that names its target.

### Concurrency

| In flight | Behaviour | Why |
|---|---|---|
| read + read, same system | concurrent | Reads take no lock, so they cannot strand one; serialising them would make a wide scan block everything else |
| read + write, same system | concurrent | Same reason, from the other side: the read changes no state |
| write + write, different systems | concurrent | separate queues, separate sessions, separate journals |
| write + write, same system | queued | interleaved LOCK / UNLOCK in one stateful session strands a lock |
| `ReloadProfile` + anything | every session closes | the one globally disruptive operation: in-flight calls to any system fail and have to be retried |

## Sessions and locks

One `AdtSession` per system (see above), reused for every call — a lock handle is valid only in the session that created it, so `Lock*Low` followed by `Update*Low` in a later call must land in the same ABAP session.

What the session holds on to:

| Mechanism | Why |
|---|---|
| `sap-contextid` is not pinned while a lock is held | Pinning it binds the lock to one context and locks everyone else out |
| `sap-usercontext` pinned to the configured client | Otherwise follow-up requests can land in the default client |
| Stateful is forced while a lock exists | A handle makes no sense in a stateless session |
| A missing CSRF token is not fatal; a 403 is replayed once | The token is lost when the session moves between pages — that is not a bad request |
| An expired session is re-established and the call replayed **once** | `401` and `Session timed out` read like "your source is wrong" |

**Lock journal** (`adt/lock-journal.ts`): `abap-adt-mcp-gateway/locks-<sha1(url|client|user).slice(0,12)>.json` under `%LOCALAPPDATA%` on Windows and `$HOME` on macOS and Linux, mapping object URL → lock handle.

- A successful LOCK is journalled immediately.
- Before locking the same object again, the journalled handle is released first.
- UNLOCK and DELETE remove the entry.

A lock handle appears exactly once, in the response that created it. If that response is lost — an error on the same call, a restart, a wrong media type — the object stays locked to this user with no way back except SM12 or session timeout. The journal turns that dead end into "release it before the next lock".

## Write boundary

`runtime.resolve(system, sessionId, needsWrite)` is the only decision point:

- `needsWrite` comes from the request semantics — the route table derives it from method ≠ GET or a write RFC action; families and bridges declare it explicitly.
- A target on tier `qa` or `prd` raises `SYSTEM_READ_ONLY` with `system` and `tier`.
- A missing or misspelled tier is treated as `prd`, so a copied configuration cannot open a production system for writing.

Concurrency is decided per system — the matrix is under [Multi-system concurrency](#multi-system-concurrency).

## Error classification

`adt/errors.ts` separates answers that look like something else. Every code carries a `nextAction`:

| What you see | What it means | `code` |
|---|---|---|
| 400 / 401 / `Session timed out` | The session is gone, not the source | `auth` (re-logon and one replay) |
| 403 `User X is currently editing` | The object is locked, not a permission problem | `locked` |
| 403 with an unusable handle | The handle belongs to another session | `invalid-lock` |
| 500 `No URI-Mapping defined for URI` | There is nothing to check here | `not-found` |
| 415 / 406 | ADT rejects the type its own discovery advertises | `content-negotiation` (retried with `*/*`) |
| 400 containing `corrNr` | A transportable object without a request | `transport-required` |

`toPayload()` produces a credential-free shape that can go straight back to the client.

## Activation

`activateAndVerify()` decides activation by comparing the active version with the source that was written. `REPOSRC.R3STATE = 'A'` is supporting evidence only: it proves no draft is left behind, not that the active version is the new content.

## Families

41 `Create*` and 42 `Delete*` tools are not 41 copies of the same code. One module per object type declares what it is called, how its URI is built and which arguments are required; `handlers.ts` executes. Adding an object type is one more module in `families/`, listed once in `families/registry.ts`.

Platform behaviour that is not obvious lives in the descriptors rather than scattered through handlers:

- name checks need a `description` query parameter; programs validate at `programs/validation`;
- lock media types and `?lockHandle=` usage differ per object type;
- a behavior implementation's lock can only be released with `UnlockClassLow`;
- service bindings expose no usable validation endpoint (every media type is rejected).

## Bridges

Screens, CUA, text pools, local includes and test classes, Smart Forms, job usage and transaction
usage have no ADT resource, so they run over remote-enabled function modules. The modules, what each
one serves and the install order are in [abap/README.md](../abap/README.md) — one copy, because the
sources and their documentation must not drift apart.

- `BRIDGE_TOOL_NAMES` (`src/tools/bridges.ts`) is the set of tools that need those modules: 24 of
the 335. A tool outside that set reaches SAP over ADT only, so it keeps working on a system where
the bridge was never installed.
- Sources are in `abap/`; install with `tools/scripts/import-abap-bridges.mjs --profile <id>`
(re-runnable, existing modules are skipped).
- A remote-enabled module can only be created through SOAP `RPY_FUNCTIONMODULE_INSERT` with
`REMOTE_CALL='X'`. ADT's create payload has no processing-type field, so it always creates `normal`
and the flag cannot be changed afterwards.
- The bridge needs `rfcBackend: "soap"` (default) and a reachable `/sap/bc/soap/rfc`. JSON in the
response is XML-entity encoded and must be decoded.

## Configuration

Five layers, lowest priority first: defaults → user → workspace (both `<cwd>/adt-mcp.config.jsonc` and `<cwd>/.adt-mcp/config.jsonc` are read) → environment → command line.

- Each layer is validated on its own, so an error names the layer and the field path instead of disappearing in the merge.
- Objects deep-merge, `systems` merges by `id`, arrays are replaced.
- Credentials are references only (`keychain:`, `env:`, `file:`); plain text fails validation.
- `adt-mcp.schema.json` is generated from `src/config/schema.ts` (`npm run gen:schema`) and checked for staleness by `npm run verify`.

## Offline scripts

| Script | Purpose |
|---|---|
| `profile.mjs` | One credential resolution for the server and the scripts (system id → config + keychain, or a `.env` path) |
| `probe-bridge.mjs` | Judges the bridge-backed tools end to end: a CUA write has to come back, a text pool has to gain the element (requires the bridge) |
| `mcp-status.mjs` | Lists running gateway processes, marks one that predates `dist/`, and can stop them (`--kill`) |
| `tool-presets.mjs` | Prints the exposure levels and their sizes, and the `toolPolicy` fragment for one; reads the built engine so counts cannot drift |
| `import-abap-bridges.mjs` | Installs or reinstalls the bridge modules and smoke-tests them |
| `gen-schema.mjs`, `gen-tools-doc.mjs` | Generate `adt-mcp.schema.json` and `docs/TOOLS.md`; `--check` fails on drift |
| `verify-catalog.mjs`, `scan-private.mjs`, `check-deprecated.mjs`, `analyze-catalog.mjs` | Contract integrity, secret scan, deprecated symbols, contract analysis |
| `live-registry.mjs` | Shared wiring for the two live scripts: registry, argument filter, report shape |
| `live-families.mjs` | Every implemented family through its whole verb set, object gone at the end (`npm run live:families`) |
| `live-tools.mjs` | The tools the family sweep cannot reach; read-only unless `--allow-writes`, `--check` turns the reports into the coverage gate (`npm run live:tools`). Its `Delete*` steps are probes of the delete verb — the **setup** objects it builds on are *not* removed (2026-11-07: a green run left 19 of them in `$TMP`) |
| `live-cleanup.mjs` | Executes a `{ tool, args }` plan through the same registry, so the leftovers of a write run are removed by data rather than by hand: `--profile <id> --plan <json>` |

Probe classification (documented in the script header): 2xx, or 400/401/403/405, means the route was recognised; 404 that echoes the request path and matches no `/discovery` collection prefix is a wrong path; 404 naming an object, or 500 `URI-Mapping cannot be performed`, means the route is right and the sample object is missing. Write verbs are never sent — only their URLs are built.

## Tests

`npm run verify` runs the whole chain: contract, secret scan, deprecated symbols, `tsc` for `src` **and** `tests` (vitest transpiles, it never type-checks), generated artefacts, documentation, then the test suite (444 tests over 39 files).

All tests are offline — either a scripted HTTP layer or `InMemoryTransport`. They cover the contract, configuration layering and tiers, error classification, the lock journal, serialized writes, family verbs, the bridge, the unit-test fallback, data preview, and one file per defect the live campaign found (dumps, enhancements, transactions, transports, Smart Forms, type information, object structure, service bindings).

## Trade-offs

| Decision | Reason | Cost |
|---|---|---|
| One process instead of child processes | One configuration, one lock journal, one place that enforces the write boundary | A crash or a `ReloadProfile` drops every session; a reload interrupts in-flight calls to every system |
| One session per system, live from startup | A lock handle must survive across calls, and changing the target must not cost a logon | Writes to one system are serialised; a slow system slows only its own writes, never another system's |
| No source caching | Distinguishing active from draft content is too easy to get wrong | Every read is a real read |
| Frozen tool contract, built at startup | Prompts and scripts keep working; one list serves every system | New capability needs a new tool, not a renamed one; the advertised `system` enum and descriptions do not follow a `ReloadProfile`, so changing the system set needs a restart |
