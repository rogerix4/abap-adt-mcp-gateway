# Operations

Everything an operator needs: how the process behaves, where the write boundary sits, how
configuration is layered, how to connect a new SAP system, and what to do with `dist/`.

- [Process model](#process-model)
- [Sessions and locks](#sessions-and-locks)
- [The write boundary](#the-write-boundary)
- [Configuration layers](#configuration-layers)
- [Advertised surface (`toolPolicy`)](#advertised-surface-toolpolicy)
- [Lock journal](#lock-journal)
- [Connecting a new SAP system](#connecting-a-new-sap-system)
- [Build and `dist/`](#build-and-dist)
- [Where to look next](#where-to-look-next)

---

## Process model

```
MCP client ──stdio──▶ dist/bin.js ──┬──HTTPS──▶ <system A>/sap/bc/adt          each system: one AdtSession
                                    ├──HTTPS──▶ <system B>/sap/bc/adt          (all alive at once)
                                    ├──HTTPS──▶ <system C>/sap/bc/adt
                                    └──SOAP───▶ <same system>/sap/bc/soap/rfc   bridge actions only
```

- **One process.** No child servers, no external engine, no patch layer. Changing behaviour
  means changing `src/` and rebuilding.
- **Every configured system is online at the same time.** Each has its own `AdtSession` with its
  own cookies, CSRF token, ABAP session id and pinned client, reused for the life of the
  process; there is no "active system" to switch and no re-logon when the target changes. A lock
  handle is only valid in the session that created it, which is why `Lock*Low` and the
  `Update*Low` that follows it land in the same session.
- **Writes to one system are serialised, reads are not.** Two writes interleaved in the same
  stateful session can leave one of them holding an unreleased lock; writes to *different*
  systems have separate queues and do not wait for each other. A slow system slows only its own
  writes.
- **`ReloadProfile` is the one global operation.** It re-reads the configuration and rebuilds
  every session, so calls in flight to any system fail and have to be retried.
- **The contract is fixed at 335 tools.** The list does not change after `initialize`, and it is
  the same list for every system. A tool whose server-side surface does not exist answers
  `NOT_IMPLEMENTED` with the reason; it never fakes a success, and it never substitutes another
  system's answer.
- **Every tool takes an extra `system` argument.** With one system configured it may be omitted.
  With several it is required: omitting it answers `SYSTEM_UNKNOWN` with the valid ids instead
  of picking one. `defaultSystem` only shapes the tool descriptions and the
  `GatewayListSystems` answer — it does not make `system` optional and never redirects a call.
- **Tool names are matched bare** (`GetProgram`, `ActivateObjects`). Any prefix a client
  displays is added by the client and is not part of the judgement.

## Sessions and locks

| Situation | Behaviour |
|---|---|
| `Lock*` / `Lock*Low` succeeds | The handle is written to the lock journal and returned to the caller |
| Another `Lock*` on the same object | The journalled handle is released first |
| `Unlock*` / `Delete*` succeeds | The journal entry is removed |
| Process restarts with a stale handle | The next lock on that object releases the stale handle before locking |
| A write hits "object is locked" | The gateway retries once in a fresh session and reports `retried_in_new_session: true` |

`Lock*Low` + `Update*Low` is the pair that expects the caller to own the handle: pass the
`lock_handle` you got back, and the gateway will not release it for you.

## The write boundary

There is exactly one place where a write is allowed or refused — `runtime.resolve(system,
sessionId, needsWrite)`:

- **Only `tier: "dev"` is writable.** `qa` and `prd` answer `SYSTEM_READ_ONLY` with the system
  id and tier in the error details.
- **A missing or misspelled tier is treated as `prd`.** A copied config with a typo cannot
  turn a production system writable.
- **`needsWrite` comes from the request semantics** (method ≠ GET, or a write-class bridge
  action), never from whether a tool *looks* read-only.
- **The tier belongs to the system, not to the process.** One conversation can read a `prd`
  system and write a `dev` system; every call is judged against its own target, so a read-only
  system never blocks work on a writable one.
- `toolPolicy` does **not** participate. Hiding a tool is visibility; the tier is the boundary.

## Configuration layers

Five layers, lowest priority first. Each layer is validated on its own, and an error names the
layer and the field path.

| Layer | Location |
|---|---|
| 1. Defaults | built in (`src/config/defaults.ts`) |
| 2. User | `%APPDATA%\abap-adt-mcp-gateway\config.jsonc` (macOS/Linux: `$XDG_CONFIG_HOME`) |
| 3. Workspace | `<cwd>/adt-mcp.config.jsonc` or `<cwd>/.adt-mcp/config.jsonc`; the gateway package directory is read as a fallback because some clients start the server with an unrelated cwd |
| 4. Environment | `ABAP_ADT_MCP_DEFAULT_SYSTEM`, `ABAP_ADT_MCP_LOG_LEVEL` — only these two |
| 5. Command line | `--config`, `--system`, `--log-level` |

Credentials are references only: `keychain:<service>/<account>`, `env:<NAME>`, `file:<path>`.
A plain-text secret fails startup validation.

One system is one entry in `systems[]`:

```jsonc
{
  "id": "dev",                       // the `system` argument and the scripts' --profile
  "tier": "dev",                     // dev | qa | prd; anything else counts as prd
  "endpoint": { "url": "https://sap.example.com:44300", "client": "100", "language": "EN", "systemType": "onprem" },
  "auth": { "type": "basic", "username": "env:ADT_USER", "password": "env:ADT_PASSWORD" },
  "rfcBackend": "soap"               // needed for screens, CUA, text elements, usage queries
}
```

See [CONFIGURATION.md](CONFIGURATION.md) for every field. Add more entries and they are all
live at once: `systems` merges by `id` across layers, and nothing is switched at runtime — see
[ARCHITECTURE.md](ARCHITECTURE.md#multi-system-concurrency).

## Advertised surface (`toolPolicy`)

| Key | Effect |
|---|---|
| `expose` | one level: `none` · `gateway` (default) · `readonly` `write` `low` · `high` · `full` · `core` |
| `allow` / `deny` | glob patterns on top: `allow` keeps only matches, `deny` removes afterwards |

| Level | Advertised | Level | Advertised |
|---|---|---|---|
| `none` | 0 | `high` | 201 |
| `gateway` (default) | 3 — `full`, as three tools: all 335 reachable | `full` | 335 |
| `readonly` | 115 | `core` | 127 (124 + 3 facade) |
| `write` | 86 | | |
| `low` | 134 | | |

- `gateway` is `full` compressed — the whole contract reachable through three tools. `core` is
  the curated level that fits a 128-tool budget. The level table and counts live in one place:
  `node tools/scripts/tool-presets.mjs`.
- `allow` can only narrow the level, never widen it (the curated set behind `core` is a level
  rule, not an `allow` list); `deny` is applied last.
- **`expose` / `allow` / `deny` are not an authorisation boundary.** They filter `tools/list`
  only; a hidden tool can still be called by bare name or through `GatewayCallTool`. The
  boundary is the tier.
- The startup banner states what is exposed: `exposing 127 tools (expose: core, 124 named + 3 gateway)`.
- A configuration still on the old `layers` / `gateway` keys starts and is mapped onto the
  nearest level; the notice on stderr names the level and what changed
  ([CONFIGURATION](CONFIGURATION.md#5-toolpolicyexpose-and-its-patterns-are-not-authorisation)).

## Lock journal

`%LOCALAPPDATA%\abap-adt-mcp-gateway\locks-<sha1(url|client|user)>.json` maps an object URL to
its lock handle. A successful lock is journalled immediately, a stale handle is released before
the next lock on the same object, and unlock/delete removes the entry — so a lost handle does
not have to wait for `SM12` or a session timeout.

## Connecting a new SAP system

1. **Add the system** to `adt-mcp.config.jsonc` with `tier: "qa"` or `"prd"` first; switch it to
   `"dev"` only when you actually intend to write there.
2. **Check ADT access**: `node tools/scripts/probe-routes.mjs --profile <id>`. The gateway needs
   `<url>/sap/bc/adt` with basic authentication.
3. **Install the bridge modules** if you want screens, GUI statuses, text pools, SmartForms or
   usage queries:

   ```bash
   node tools/scripts/import-abap-bridges.mjs --profile <id>
   ```

   The script creates the function group if needed, creates the function module remote-enabled
   through `RPY_FUNCTIONMODULE_INSERT` (`REMOTE_CALL = 'X'`), writes the source, activates it and
   smoke-tests it — in that order, and it is safe to re-run (existing modules are skipped, not
   overwritten). The two function groups (`ZMCP_ADT_UTILS`, `ZMCP_SSF_UTILS`, `ZMCP_WL_UTILS`)
   and their modules are infrastructure: they do not carry business changes, and upgrading means
   re-importing them.
4. **Do not** rely on `<fmodule:processingType>remoteEnabled</fmodule:processingType>` in the
   create payload: the POST answers 201 and a read-back still says `normal`.
5. **Write function-module sources with value parameters only** (`VALUE(iv_action) TYPE string`):
   a remote-enabled module cannot take reference parameters.
6. **SOAP prerequisites**: the ICF node `/sap/bc/soap/rfc` must be reachable and the module must
   be remote-enabled — an un-enabled module answers HTTP 500.
7. **The advertised system list is fixed at startup.** The `system` argument carries an `enum`,
   a description and a `GatewayListSystems` answer built from the configuration the process
   started with, so a system added to the file answers `SYSTEM_UNKNOWN` until the gateway is
   restarted. `ReloadProfile` rebuilds the *sessions* — and closes all of them, so in-flight
   calls to any system fail and have to be retried — after which the new id is accepted, but the
   enum, the description and `GatewayListSystems` still show the startup set. Restart after
   changing the system list. Adding one does not touch the other systems' tier, write queue,
   bridge modules or lock journal file.

Bridge troubleshooting is in [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and the module list is in
[`../abap/README.md`](../abap/README.md).

## Build and `dist/`

- **`src/` is the only source of truth.** `dist/` is `npm run build` output (`tsc -p
  tsconfig.json`). Never edit `dist/` by hand: the next build overwrites it, and the edit is not
  where the error appears.
- **Build before verifying**: `npm run build` → `node dist/bin.js --coverage` (must read 335/335)
  → `npm run verify` (contract, secret scan, tsc, schema/doc drift, tests).
- **The contract is frozen**: the 335 names, descriptions and schemas live in
  `tools/catalog.json`. Changing it requires regenerating `adt-mcp.schema.json` and
  `docs/TOOLS.md`; `npm run verify` fails on drift. New capability means a new tool, not a
  renamed one.
- **Test objects belong in `$TMP`** (local package, no transport request); only deliverables go
  into a project package and a request. Anything that creates objects cleans up after itself:
  run-scoped names, read-back after delete, includes closed separately, locks returned.

## Where to look next

| Question | Document |
|---|---|
| How the pieces fit together | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Every configuration field | [CONFIGURATION.md](CONFIGURATION.md) |
| Tool names and arguments | [TOOLS.md](TOOLS.md) |
| How to call things | [USAGE.md](USAGE.md) |
| Something does not work | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| The ABAP side | [`../abap/README.md`](../abap/README.md) |
