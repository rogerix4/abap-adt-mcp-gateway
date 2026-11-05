# Troubleshooting

> Work out which layer is broken first, then fix it. Repeating the same failing call is the most expensive thing you can do here.

## Contents

- [The server does not start](#the-server-does-not-start)
- [Restarting the server](#restarting-the-server)
- [The client says it cannot pass all tools](#the-client-says-it-cannot-pass-all-tools)
- [Cannot connect or log on](#cannot-connect-or-log-on)
- [Objects are locked](#objects-are-locked)
- [A write does not land](#a-write-does-not-land)
- [Activation reported, source unchanged](#activation-reported-source-unchanged)
- [400, 403, expired sessions](#400-403-expired-sessions)
- [Bridge tools unavailable](#bridge-tools-unavailable)
- [Data preview looks wrong](#data-preview-looks-wrong)
- [Reading a probe run](#reading-a-probe-run)

---

## The server does not start

| Symptom | Cause | What to do |
|---|---|---|
| `configuration error: …` | One layer failed validation; the message names the layer and field path | Fix that field. Common: a plain-text credential, a misspelled `tier`, an invalid `url` |
| Client says "server sent invalid JSON" | Something wrote to stdout | All diagnostics go to stderr; if you edited the code, remove the `console.log` |
| `0/335 tools implemented` | `dist/` is stale | `npm run build`, then retry |
| It starts but has no systems | Configuration is in a location that is not read | See [CONFIGURATION](CONFIGURATION.md#1-five-layers-low-to-high) |
| `credentials could not be resolved` | Keychain unreadable, or the environment variable is missing | Switch to a `file:` or `env:` reference until it works |

One command to sanity-check a build:

```powershell
node dist/bin.js --coverage          # expect 335/335
```

## Restarting the server

The server is a **child of the MCP client** that spawned it (`copilot-runtime.exe`, Claude Desktop, …). Its lifetime follows that session, so "restart" is the client's action, not a file operation:

| What you want | What to do |
|---|---|
| Pick up a new build, new config, or a new tool list | Start a new chat session (or reload the window). The client closes stdin, the server exits, a fresh process starts |
| Check what is running | `node tools/scripts/mcp-status.mjs` — prints pid, owner, start time, and marks a process **STALE** when it predates `dist/` |
| Stop an orphan | `node tools/scripts/mcp-status.mjs --kill`, then start a new session |

Why there may be no restart button: the VS Code MCP list only offers restart for servers registered in **its own** `mcp.json` (`%APPDATA%\Code\User\mcp.json` or `.vscode/mcp.json`). A server that comes from another app's config — for example `~/.copilot/mcp-config.json` — appears in the list but is owned by that provider, so there is nothing to restart. Register it in the VS Code file if you want the button:

```jsonc
// %APPDATA%\Code\User\mcp.json
{ "servers": { "abap-adt-mcp-gateway": { "type": "stdio", "command": "node",
  "args": ["<package>\\dist\\bin.js"] } } }
```

Keep one registration only: two entries for the same server means two processes and twice the tools.

A stale process is the usual reason "my changes are not visible": it keeps talking to the previous build and holding its SAP sessions. `mcp-status.mjs` marks it `STALE`.

## The client says it cannot pass all tools

A client that caps the tool budget reports something like *"the model only supports 128 tools, 247 tools were not provided"*. The contract stays at 335; what the server **advertises** decides what fits. `toolPolicy.expose` picks one level, and `allow` / `deny` narrow it:

```jsonc
"toolPolicy": { "expose": "gateway", "allow": [], "deny": [] }
```

| Level | Tools | Use when |
|---|---|---|
| `gateway` (default) | 3 | `full` in its compressed form: three tools that reach all 335 by name |
| `core` | 127 | everyday ABAP work — the shape that fits 128 |
| `readonly` | 115 | the agent should never see a write tool at all |
| `write` / `low` | 86 / 134 | only write tools, or only the `*Low` variants |
| `high` | 201 | reads and writes, no `*Low` |
| `full` | 335 | every named tool listed; no client-side limit |
| `none` | 0 | diagnose a client without any tools |

**With `gateway`** the client sees exactly three tools:

| Tool | Purpose |
|---|---|
| `GatewayListSystems` | configured systems, and which one is the default |
| `GatewayListTools` | search the 335-tool contract: `pattern`, `verb`, `query`, `layer`, `detail: "names" \| "descriptions" \| "schema"` |
| `GatewayCallTool` | `{ tool, arguments, system }` — runs any tool, advertised or not |

Verified end to end: with this config `tools/list` returns 3 tools, and `GatewayCallTool` fetched a 9 KB program from a real system.

**Narrowing a level** — `allow` keeps only matches, `deny` removes afterwards, and neither can widen the level:

```jsonc
"toolPolicy": {
  "expose": "high",
  "allow": ["SearchObject", "*Program", "*Class", "GetSqlQuery", "ActivateObjects"],
  "deny": ["*Low"]
}
```

- Patterns are case-insensitive globs; `allow` non-empty ⇒ only matches survive.
- Visibility only: a hidden tool can still be called — through `GatewayCallTool`, or directly by name. The write boundary is enforced per call either way.
- Ready-made: `node tools/scripts/tool-presets.mjs` lists every level with its size; `--level core --check` prints the count and whether it fits 128.
- The startup banner states the truth: `exposing 127 tools (expose: core, 124 named + 3 gateway)`.

**If it still says 335**, the running process does not see your configuration: check `npm run status` for a stale process and look for `no systems configured` in the client's MCP log — that pair means the server was started with a working directory that has no config and could not find one next to the package either.

## Cannot connect or log on

Separate the network from the request:

```powershell
Test-NetConnection <host> -Port <port>
```

- Unreachable: a `network` class error — network path, certificate or proxy. Not a code problem.
- Reachable but 401: user, password or client is wrong; also check the user is not locked in `SU01`.
- `Session timed out` / `session expired`: the session died. The gateway re-establishes it and replays once; only a failure after that is real.
- Many operations failing at once with 400, including a harmless read: a session problem. Restart the server in the client rather than editing code.

## Objects are locked

`User X is currently editing Y` has three possible owners:

1. **An editor tab** — the object is open and was saved in ADT or the ABAP extension. Close the tab.
2. **A handle you never released** — journalled in `<LOCALAPPDATA>\abap-adt-mcp-gateway\locks-*.json`. While the entry exists, the next lock on that object releases it first. If the entry is gone, only SAP session timeout clears it.
3. **A second gateway process** — two processes using the same SAP user cannot coordinate. Stop the extra one.

If SM12 shows no lock but the object still answers "currently editing", the dialog lock has been released while the object stays in a session that has not ended: have that user log off again, or wait for `rdisp/gui_auto_logout`.

Deletion follows the same rule: unlock first, then delete. The high-level `Delete*` tools already do this.

## A write does not land

Check four layers, once each:

| Layer | Symptom | What to check |
|---|---|---|
| Lock | `locked`, `invalid-lock` | Previous section. A handle only belongs to its own session |
| Transport | `transport-required` | A transportable object needs `transport_request`. If another user's unreleased request already holds the object, the change belongs to that request |
| Tier | `SYSTEM_READ_ONLY` | The target is `qa` or `prd`. Point the call at a development system; do not widen the tier |
| Source | pre-check syntax error | Nothing was written. Fix the code and send again — do not resend the same source |

Objects in `$TMP` need no request number. For a new object, create the shell and write the full source in the next call.

## Activation reported, source unchanged

In order:

```sql
-- Is there a leftover draft? (supporting evidence, not proof)
SELECT PROGNAME, R3STATE FROM REPOSRC WHERE PROGNAME = '<name>'
```

- Only `A` left: no draft.
- `A` and `I` together: a draft exists — activate again.
- To confirm content: read `version: "active"` and compare with your copy line by line.

For CDS (`DDLS`), query `DD02L` with `TABNAME` = the value of `sqlViewName` and check `AS4LOCAL`.

## 400, 403, expired sessions

- **Retry the same call once, unchanged.** The session replays a 403 or a lost CSRF token automatically; a manual call benefits the same way.
- A dead session shows up as everything failing together: writes, checks, reads and data preview. If a harmless read also fails, it is the session.
- Restart the MCP server in the client, then run one harmless read to confirm it is alive.

## Bridge tools unavailable

Screens, CUA, text pools and usage queries report "bridge not installed", or a SOAP fault:

```powershell
node tools/scripts/import-abap-bridges.mjs --profile <system-id>
node tools/scripts/probe-bridge.mjs --profile <system-id>
```

| Symptom | Cause |
|---|---|
| `FUNCTION_ALREADY_EXISTS` | The module exists. The importer skips it; delete it first to recreate |
| `INVALID_FUNCTION_POOL` and "function group does not exist" | SOAP parameter names must be uppercase; an empty group name produces exactly this |
| 500 with `kernel rc=9` | The module is not remote-enabled. ADT cannot change the processing type: delete and recreate with the importer |
| `subrc = 0` but an empty result | The module body is not active, or the client did not decode the XML-escaped JSON |
| Every bridged tool fails for one system | `rfcBackend` is not `soap`, or `/sap/bc/soap/rfc` is unreachable |

## Data preview looks wrong

| Symptom | Cause |
|---|---|
| 400 "unknown column `MANDT`" | Client-dependent tables must not select `MANDT`; the endpoint filters by logon client. `T000` and similar are the exception |
| 400 "unknown column `LENGTH(X)`" | This is a column preview and does not evaluate functions. Select the raw column and compute outside |
| Only a few hundred rows | `totalRows` is paged. Run `COUNT(*)` for the real size |
| Aggregate columns look unsigned | Aggregates may not display a sign. Count rows with `WHERE field < 0` instead |
| `GENERATE_SUBPOOL_DIR_FULL` | Too many distinct column sets were queried in one session and the temporary subprogram pool is full. Restart the session or merge the column sets |

## Reading a probe run

```powershell
node tools/scripts/probe-routes.mjs --profile <system-id> --families
```

| Section | Meaning |
|---|---|
| recognised | The system accepted the route (2xx, or 400/401/403/405 — path right, request or state wrong) |
| wrong path | 404 that echoes the request path and matches no `/discovery` collection prefix |
| route is right, sample object missing | The path exists; the sample object does not |
| wrong media type | 415 / 406 |
| declared unavailable on purpose | This release genuinely has no such endpoint |
| write verbs — path built, nothing sent | Write verbs are never sent; only their URLs are built |
| routed over the RFC bridge | Covered by `probe-bridge.mjs`, not by the route probe |
