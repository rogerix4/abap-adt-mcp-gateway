# Architecture

> Why the server is shaped the way it is. Read this before the code.

## Call path

```
MCP client ──stdio──▶ dist/bin.js
                        ├─ config/load.ts      layered config + zod validation
                        ├─ config/secrets.ts   resolves keychain:/env:/file: into real credentials
                        ├─ runtime.ts          systems, tiers, one AdtSession per system
                        └─ mcp/server.ts       tools/list (adds `system`), tools/call (serialized writes)
                              └─ engine/registry.ts ─ handlers ─┬─ tools/routes.ts     high level: one object, one route
                                                               ├─ families/handlers.ts same-verb families
                                                               └─ tools/bridges.ts     what ADT lacks → RFC bridge
                                                                     └─ adt/session.ts  HTTPS, ADT session, lock journal
```

One process. No child processes, no external engine, no patches over an installed package.

## Protocol layer

| | |
|---|---|
| Wire format | JSON-RPC 2.0 over stdio; stdout carries the protocol and nothing else, diagnostics go to stderr |
| Protocol versions | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` — the version the client asks for is echoed back (`@modelcontextprotocol/sdk` 1.32.2) |
| Capabilities | `tools` only, `listChanged: false`. The contract is fixed before the transport connects, so the list never changes after `initialize` |
| Advertised subset | `toolPolicy.layers` / `allow` / `deny` filter the list at `tools/list`; the registry still holds all 335 and calls by name still work |
| Gateway mode | Default on. `toolPolicy.gateway` adds `GatewayListSystems`, `GatewayListTools`, `GatewayCallTool` — three visible tools that reach the whole contract; `GatewayCallTool` runs writes through the same serialization and tier checks |
| Not advertised | resources, prompts, sampling, logging |
| Tool annotations | Derived per tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Advisory for clients; they never alter a name, description or schema |
| Transport | stdio only. There is no HTTP or SSE listener |

## The tool contract

- The 335 names, descriptions and input schemas in `tools/catalog.json` are a contract. `verify-catalog.mjs` and `contract.test.ts` compare both directions.
- The registry registers the whole contract up front; a tool without a handler answers `NOT_IMPLEMENTED` rather than a plausible success. `--coverage` reads 335/335.
- `Low` means "the caller owns the lock and the session": one tool call, one ADT request. It does not mean "the twin of the tool next to it" — 89 of the 134 `*Low` tools have no high-level sibling.
- `tools/layer-map.json` carries the metadata derived from each schema (needs a `lock_handle`, writes or not). Do not infer it from the name.

## Sessions and locks

One `AdtSession` per system, reused for every call. This is a requirement, not an optimisation: a lock handle is valid only in the session that created it, so `Lock*Low` followed by `Update*Low` in a later call must land in the same ABAP session.

What the session holds on to:

| Mechanism | Why |
|---|---|
| `sap-contextid` is not pinned while a lock is held | Pinning it binds the lock to one context and locks everyone else out |
| `sap-usercontext` pinned to the configured client | Otherwise follow-up requests can land in the default client |
| Stateful is forced while a lock exists | A handle makes no sense in a stateless session |
| A missing CSRF token is not fatal; a 403 is replayed once | The token is lost when the session moves between pages — that is not a bad request |
| An expired session is re-established and the call replayed **once** | `401` and `Session timed out` read like "your source is wrong" |

**Lock journal** (`adt/lock-journal.ts`): `%LOCALAPPDATA%/abap-adt-mcp-gateway/locks-<sha1(url|client|user).slice(0,12)>.json`, mapping object URL → lock handle.

- A successful LOCK is journalled immediately.
- Before locking the same object again, the journalled handle is released first.
- UNLOCK and DELETE remove the entry.

A lock handle appears exactly once, in the response that created it. If that response is lost — an error on the same call, a restart, a wrong media type — the object stays locked to this user with no way back except SM12 or session timeout. The journal turns that dead end into "release it before the next lock".

## Write boundary

`runtime.resolve(system, sessionId, needsWrite)` is the only decision point:

- `needsWrite` comes from the request semantics — the route table derives it from method ≠ GET or a write RFC action; families and bridges declare it explicitly.
- A target on tier `qa` or `prd` raises `SYSTEM_READ_ONLY` with `system` and `tier`.
- A missing or misspelled tier is treated as `prd`, so a copied configuration cannot open a production system for writing.

Concurrency: writes to the same system are queued in `mcp/server.ts`; reads are not. Two writes in flight against one stateful session interleave LOCK and UNLOCK, and the loser ends up holding a lock it never released.

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

41 `Create*` and 42 `Delete*` tools are not 41 copies of the same code. `families/descriptors.ts` declares per object type what it is called, how its URI is built, and which arguments are required; `handlers.ts` executes. Adding an object type is one descriptor.

Platform behaviour that is not obvious lives in the descriptors rather than scattered through handlers:

- name checks need a `description` query parameter; programs validate at `programs/validation`;
- lock media types and `?lockHandle=` usage differ per object type;
- a behavior implementation's lock can only be released with `UnlockClassLow`;
- service bindings expose no usable validation endpoint (every media type is rejected).

## Bridges

Screens, CUA, text pools, job usage and transaction usage have no ADT resource, so they run over remote-enabled function modules:

| Module | Function group | Tools |
|---|---|---|
| `ZMCP_ADT_DISPATCH` | `ZMCP_ADT_UTILS` | 4 screen tools + 4 GUI status tools |
| `ZMCP_ADT_TEXTPOOL` | `ZMCP_ADT_UTILS` | 4 text element tools |
| `ZMCP_WL_TCODE_USAGE` | `ZMCP_WL_UTILS` | `GetTcodeUsage` |
| `ZMCP_WL_JOB_USAGE` | `ZMCP_WL_UTILS` | `GetJobUsage` |

- Sources are in `abap/`; install with `tools/scripts/import-abap-bridges.mjs --profile <id>` (re-runnable, existing modules are skipped).
- A remote-enabled module can only be created through SOAP `RPY_FUNCTIONMODULE_INSERT` with `REMOTE_CALL='X'`. ADT's create payload has no processing-type field, so it always creates `normal` and the flag cannot be changed afterwards.
- The bridge needs `rfcBackend: "soap"` (default) and a reachable `/sap/bc/soap/rfc`. JSON in the response is XML-entity encoded and must be decoded.

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
| `probe-routes.mjs` | Verifies every route against a real system: `--families` adds family verbs, `--dry-run` only builds URLs, `--filter` narrows |
| `probe-bridge.mjs` | Verifies the 16 bridged tools (requires the bridge) |
| `mcp-status.mjs` | Lists running gateway processes, marks one that predates `dist/`, and can stop them (`--kill`) |
| `tool-presets.mjs` | Prints `toolPolicy` fragments: `full`, `gateway`, `readonly`, `high`, `core`; `--check` reports the advertised count |
| `import-abap-bridges.mjs` | Installs or reinstalls the four bridge modules and smoke-tests them |
| `gen-schema.mjs`, `gen-tools-doc.mjs` | Generate `adt-mcp.schema.json` and `docs/TOOLS.md`; `--check` fails on drift |
| `verify-catalog.mjs`, `scan-private.mjs`, `check-deprecated.mjs`, `analyze-catalog.mjs` | Contract integrity, secret scan, deprecated symbols, contract analysis |

Probe classification (documented in the script header): 2xx, or 400/401/403/405, means the route was recognised; 404 that echoes the request path and matches no `/discovery` collection prefix is a wrong path; 404 naming an object, or 500 `URI-Mapping cannot be performed`, means the route is right and the sample object is missing. Write verbs are never sent — only their URLs are built.

## Tests

`npm run verify` runs the whole chain: contract, secret scan, deprecated symbols, `tsc`, generated artefacts, documentation, then 12 test files / 124 tests.

All tests are offline — either a scripted HTTP layer or `InMemoryTransport`. They cover the contract, configuration layering and tiers, error classification, the lock journal, serialized writes, family verbs, the bridge, the unit-test fallback, and data preview.

## Trade-offs

| Decision | Reason | Cost |
|---|---|---|
| One process instead of child processes | One configuration, one lock journal | A slow system delays **writes** to other systems; reads are unaffected |
| One session per system | A lock handle must survive across calls | Writes to one system are serialized |
| No source caching | Distinguishing active from draft content is too easy to get wrong | Every read is a real read |
| Frozen tool contract | Prompts and scripts keep working | New capability needs a new tool, not a renamed one |
