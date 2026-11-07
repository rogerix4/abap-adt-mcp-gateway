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
- [Reading a live run](#reading-a-live-run)
- [SAP answers that look like a code error](#sap-answers-that-look-like-a-code-error)
- [Reading a runtime dump](#reading-a-runtime-dump)
- [Checkpoints (`SAAB`)](#checkpoints-saab)

---

## The server does not start

| Symptom | Cause | What to do |
|---|---|---|
| `configuration error: …` | One layer failed validation; the message names the layer and field path | Fix that field. Common: a plain-text credential, a misspelled `tier`, an invalid `url` |
| Client says "server sent invalid JSON" | Something wrote to stdout | All diagnostics go to stderr; if you edited the code, remove the `console.log` |
| `0/335 tools implemented` | `dist/` is stale | `npm run build`, then retry |
| It starts but has no systems | Configuration is in a location that is not read | See [CONFIGURATION](CONFIGURATION.md#five-layers-low-to-high) |
| `credentials could not be resolved` | Keychain unreadable, or the environment variable is missing | Switch to a `file:` or `env:` reference until it works |

One command to sanity-check a build:

```text
node dist/bin.js --coverage # expect 335/335
```

## Restarting the server

The server is a **child of the MCP client** that spawned it (`copilot-runtime.exe`, Claude Desktop, …). Its lifetime follows that session, so "restart" is the client's action, not a file operation:

| What you want | What to do |
|---|---|
| Pick up a new build, new config, or a new tool list | Start a new chat session (or reload the window). The client closes stdin, the server exits, a fresh process starts |
| Check what is running | `node tools/scripts/mcp-status.mjs` — prints pid, owner, start time, and marks a process **STALE** when it predates `dist/` |
| Stop an orphan | `node tools/scripts/mcp-status.mjs --kill`, then start a new session |

Why there may be no restart button: the VS Code MCP list only offers restart for servers registered in **its own** `mcp.json` — workspace `.vscode/mcp.json`, or the user file:

| OS | User-level `mcp.json` |
|---|---|
| Windows | `%APPDATA%\Code\User\mcp.json` |
| macOS | `~/Library/Application Support/Code/User/mcp.json` |
| Linux | `~/.config/Code/User/mcp.json` |

A server that comes from another app's config — for example `~/.copilot/mcp-config.json` or Claude Desktop's file — appears in the list but is owned by that provider, so there is nothing to restart. Register it in the VS Code file if you want the button:

```jsonc
// <the user mcp.json for your OS, see the table above>
{ "servers": { "abap-adt-mcp-gateway": { "type": "stdio", "command": "node",
 "args": ["<package>/dist/bin.js"] } } }
```

On Windows the path in `args` needs doubled backslashes (`"D:\\path\\dist\\bin.js"`); on macOS and Linux use the plain `/path/to/dist/bin.js`.

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

```text
# Windows (PowerShell)
Test-NetConnection <host> -Port <port>

# macOS / Linux
nc -vz <host> <port>
```

- Unreachable: a `network` class error — network path, certificate or proxy. Not a code problem.
- Reachable but 401: user, password or client is wrong; also check the user is not locked in `SU01`.
- `Session timed out` / `session expired`: the session died. The gateway re-establishes it and replays once; only a failure after that is real.
- Many operations failing at once with 400, including a harmless read: a session problem. Restart the server in the client rather than editing code.

## Objects are locked

`User X is currently editing Y` has three possible owners:

1. **An editor tab** — the object is open and was saved in ADT or the ABAP extension. Close the tab.
2. **A handle you never released** — journalled in `abap-adt-mcp-gateway/locks-*.json` under `%LOCALAPPDATA%` (Windows), or `$HOME` (macOS / Linux). While the entry exists, the next lock on that object releases it first. If the entry is gone, only SAP session timeout clears it.
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

```text
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

## Reading a live run

The probes answer one question each: does *this build* work on *this* system, and was every tool in
the contract really called.

```text
npm run live:families -- --profile <system-id> --report families.json
npm run live:tools -- --profile <system-id> --report tools.json --check families.json
node tools/scripts/probe-bridge.mjs --profile <system-id>
```

| Output | Meaning |
|---|---|
| `PASS <tool> {…}` | The tool answered; the JSON next to the name is its own answer, truncated |
| `SKIP <family> <reason>` | This logon or release cannot exercise that family (no `S_DEVELOP` for BDEF, no service definition target) |
| `FAIL <tool> <code>: <text>` | The tool answered with an error. The code is the tool's classification, not the probe's |
| `never called: …` | `--check` compared the reports with `tools/catalog.json`; those names were never exercised |
| `### passed: 23 / ### failed: 0` | `probe-bridge` judges the answer, not just the call: a CUA write has to come back, a text pool has to gain the element |

A `FAIL` is a finding about the tool, never about the probe: the fixtures are conformance-checked
against each tool's schema before the call goes out, so a missing argument is reported as
`fixture is missing <arg> for <tool>` instead of reaching SAP as a 400.

## SAP answers that look like a code error

These come from the check and the activation, not from the gateway. Search the message text; each
row is the cause and the fix. A check reports the first error only, so fix one and run it again.

| Message (searchable) | Cause | Fix |
|---|---|---|
| `is longer than the allowed 30 characters` | an identifier is longer than 30 | drop redundant words, then use a standard abbreviation (`BUKRS`, `WERKS`, `AUFNR`), and only then invent one—with the full name in a comment |
| `can be up to eight characters long` | a `PARAMETERS` or `SELECT-OPTIONS` name is longer than 8 | same ladder; selection-screen names are their own limit, not the 30 |
| `Table keys "PRIMARY_KEY" and "SK_..." are both unique and the components... are the initial part` | a unique secondary key is a prefix of the primary key—a warning, it does not block | drop the secondary key; read with a `WITH KEY` prefix of the primary key |
| `... are identical except for their names` | a unique secondary key is identical to the primary key—also a warning | keep one of them |
| `Type "..." is unknown` · `No component exists with the name "..."` · `The field "..." is unknown, but there is a field with the similar name "..."` | a rename was not applied everywhere, or the component really is missing (the third form names the closest candidate) | search for the old name; the check stops at the first error, so iterate |
| `"GROUP" is not allowed here` under `FOR ALL ENTRIES` | `FOR ALL ENTRIES` must not be combined with `GROUP BY`; where it is accepted it does not group | use `INNER JOIN... GROUP BY` (aggregate in the database), or fetch detail rows and group in ABAP |
| `Component "..." of key "PRIMARY_KEY" of table "..." is not specified or is incomplete.` | `WITH TABLE KEY` does not name every key field | name the full primary key; for a partial key use `WITH KEY`, which compiles but falls back to a linear search unless the fields are a prefix, or define a secondary key |
| `replacement object` (warning, does not block) | the table has a successor (`COEP`, `COSS`, `COSP`, `MBEW`,...) | use the successor (`ACDOCA`, with `RLDNR` where it applies) |
| `has a replacement object and hence should no longer be used` · `Use the associated entity "NSDM_E_MSEG"` (blocking) | `MSEG` / `MKPF` were replaced in S/4 | `NSDM_E_MSEG` / `NSDM_E_MKPF` on a new S/4; compatibility views `NSDM_V_*` (they are `VIEW`) or the new single table `MATDOC` (`TABL`) where those fit; `MSEG` / `MKPF` only on ECC. Check on the target system |
| `The row structure of the table "..." is incorrect.` | `WHERE col IN @itab` was given something that is not a range table | declare it `TYPE RANGE OF <field>` |
| `The type of "..." cannot be converted to the type of "..."` | a `SELECT-OPTIONS` name used as an internal table: in a statement the name means the header line, not the table | use the table body, `s_x[]`; only ABAP SQL `IN @s_x` reads the body implicitly |
| `... is obsolete`—the syntax check does not report it, ATC does | old syntax (`WITH HEADER LINE`, `ADD... TO`,...) | replace it; a release that still compiles it is not a reason to keep writing it |
| `The result of an arithmetic calculation cannot be passed to parameter "..."` | an expression passed to a parameter with a concrete type | assign the result to a variable of that type first |
| `No value was passed to the mandatory parameter "..."` | a parameter without `OPTIONAL` was omitted | pass it, or declare it `OPTIONAL` / give it a `DEFAULT` |
| `Statement is not accessible.` | the statement sits outside an event block or form—typical for a leftover line after an edit | move it into the block, or delete it |
| `Field "X" is not valid` / `Field "X" is unknown`, while `X` is declared and deleting a `SELECT-OPTIONS` makes the error go away | the check reports at a position downstream of the real problem (declaration order, selection screen) | do not edit the reported line: write the program back in segments—declarations and selection screen first, then fetch, compose, output—and bisect |
| `This Open SQL statement uses additions that can only be used when fixed point arithmetic is switched on` | new syntax (host variables, `@`) needs the fixed-point-arithmetic program attribute; an include or a standard class cannot set it | set the attribute, or use the older form, or move the arithmetic into a function module. **Rule out a false report first**: if the attribute is already on, an expired session produced the message—reconnect and check again. When it appears together with `Field... is unknown` for fields that are declared, do not touch the code |
| `The operators DIV and MOD cannot be used in expressions that contain real decimal numbers` | `DIV` / `MOD` on a packed decimal inside Open SQL | use the SQL function `DIVISION( )`, which takes the number of decimals as a parameter |

A write reported as successful with `written: true, activated: false` is the other class of
half-truth: the source landed as an inactive version. See [WORKFLOW.md](WORKFLOW.md).

## Reading a runtime dump

The dump text names a runtime error, and the runtime error names the shape of the bug. The
exception name is what you search for; the class in the dump header only tells you where to look in
ST22.

| Runtime error | Real cause | What to change |
|---|---|---|
| `CX_SY_ITAB_LINE_NOT_FOUND` | a table expression `itab[... ]` found no row; it does not set `sy-subrc`, it raises. All operand positions raise—the only three exceptions are a result type with a default value, use inside `ASSIGN` (which sets `sy-subrc = 4` instead), and use inside `line_exists` | test with `line_exists( )` first, or wrap the read in `TRY... CATCH` |
| `CX_SY_CONVERSION_*` on dates and periods | a user-entered `YYYYMM` was assembled into a date by hand and an illegal month blew up the conversion | do not convert: filter with string semantics (`SUBSTRING( CAST(... ) )`) |
| `TSV_TNEW_PAGE_ALLOC_FAILED`, `TSV_TNEW_BLOCKS_NO_ROLL_MEMORY` | an internal table grew past memory—everything fetched at once and nothing released | `FREE` tables you no longer need, fetch in batches, or move the job to the background |
| `DBIF_RSQL_SQL_ERROR` | the SQL layer refused the statement: a condition too wide, an incomplete key, a type that does not match | supply the full composite key; check the field types you compare |
| `TIME_OUT`, `DBIF_RSQL_INVALID_REQUEST` | one `SELECT` per loop iteration, or a full table scan | fetch outside the loop; make `FOR ALL ENTRIES` safe against an empty driver table, and de-duplicate it |
| `COMPUTE_BCD_OVERFLOW`, `CX_SY_CONVERSION_OVERFLOW` | a packed number too short for the result, often a hand-made `DEC15` | type the field from a DDIC element or a standard table field instead of an invented length |
| `CX_SY_MOVE_CAST_ERROR`, `CX_SY_ASSIGN_CAST_ERROR` | assign or `CAST` between incompatible types | use `CORRESPONDING`, `CONV` or `EXACT`; check for a leftover `MOVE-CORRESPONDING` |
| `CX_SALV_NOT_FOUND`, `CX_SALV_DATA_ERROR` | SALV column name is not a structure component of the output table, or an argument has the wrong type | create the SALV inside `TRY... CATCH cx_salv_msg` and use component names |
| `ITAB_ILLEGAL_SORT_ORDER` | a row was inserted into a sorted or keyed table in an illegal position | `INSERT <wa> INTO TABLE <itab>` lets the table place it by key |
| `TABLE_ILLEGAL_STATEMENT` | a `LOOP` over one table was used with the same work area to `MODIFY` a second table of the same structure | `MODIFY... TRANSPORTING <fields> WHERE <condition>`, or delete and re-insert |
| `DYNPRO_SEND_IN_BACKGROUND` | a background or RFC call walked into a dialog chain—most often a standard function calling `RS_CORR_INSERT` because it needs a transport request, which pops `TRINT_TADIR_POPUP` and `CALL SCREEN 100` | have the object recorded in a request before the call, or run it in dialog. Suppressing the popup is not an option |
| `CX_SY_DYNAMIC_OSQL_SEMANTICS` ("maximum number of digits 34") | arithmetic on amount or quantity columns inside Open SQL | move the arithmetic to ABAP, or `CAST` first |
| `CX_SY_CONVERSION_NO_DATE` / `_NO_TIME` / `_NO_DATE_TIME` | string-to-date or string-to-time conversion on an empty or malformed value | validate and check for empty before converting; do not rely on implicit conversion |
| `CX_SY_ZERODIVIDE`, `CX_SY_RANGE_OUT_OF_BOUNDS`, `CX_SY_REF_IS_INITIAL`, `CX_SY_CONVERSION_NO_NUMBER` | divisor is zero / substring offset beyond the string / dereferencing an unbound reference / a character field that is not a number | check the divisor, validate offset and length, test `IS BOUND`, test `IS NUMERIC` or use a regex |
| `CX_SY_DYN_CALL_ILLEGAL_FUNC`, `_PARAM_NOT_FOUND`, `_PARAM_MISSING` | `CALL FUNCTION` with a dynamic name: misspelled or nonexistent function, a parameter the callee does not have, or a mandatory parameter left out | spell the name from a constant, and copy parameter names from the interface |
| `SQL error -10692 occurred while accessing table...` | the database's statement cache is in a bad state—not a bug in the program | apply the matching SAP note; report `CUCASTAT` (package `SBUF`) resets the statement cache of one application server, `SM51` lists the instances |
| `CLEANUP` did not run, or ran at an unexpected moment | `CLEANUP` runs only when the `TRY` block of the same `TRY` construct raises a catchable exception that an **outer** `TRY` handles. With `BEFORE UNWIND` on the handling `CATCH`, the context is deleted when the `CATCH` ends, so `CLEANUP` runs **after** the handler; without it, **before**. A resumable exception resumed with `RESUME` never runs it | keep cleanup logic free of statements that leave the context early; put ordered cleanup in the `CATCH`; use `BEFORE UNWIND` when the order matters |
| an exception raised in a static constructor or an event handler reaches nobody | those two contexts cannot propagate an exception (the only exception is `CX_NO_CHECK`) | handle it there with `TRY... CATCH` |

## Checkpoints (`SAAB`)

`ASSERT`, `BREAK-POINT` and `LOG-POINT` are diagnostics, not logging. They cost nothing while they
are inactive, and they change behaviour in ways that surprise people.

- `ASSERT... CONDITION log_exp`: **without `ID` it is always active** and a false condition raises the
 uncatchable `ASSERTION_FAILED`, ending the program. With `ID`, a checkpoint group in `SAAB` decides—
 and the group must already exist. `FIELDS` / `SUBKEY` expressions are evaluated only when the
 assertion is active and false. Methods used in `log_exp` must have no side effects, or the program
 behaves differently depending on whether the assertion is switched on.
- `BREAK-POINT`: without `ID` it is always active. In dialog it enters the debugger; in a background
 job the program does **not** stop and only a `Breakpoint reached` line goes to the system log (an
 active breakpoint is then ignored completely); under update processing it follows the debugger
 settings; over RFC it enters the debugger when a dialog is possible; in ICF / APC only external
 debugging (time-limited, two hours by default) stops it, otherwise it behaves like background.
- `LOG-POINT ID <group>`: writes one entry to the same log `ASSERT` uses, then continues. Entries of
 the same point **overwrite** each other—read the counter to see how often it was hit. Field size is
 limited by `abap/aab_log_field_size_limit` (1024 bytes by default) and an oversized internal table is
 dropped as a whole, so what you see can be incomplete. There is no export API, so it is not a
 general-purpose log and never an audit log.
