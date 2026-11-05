# Usage

> The tool list is in [TOOLS.md](./TOOLS.md) (335 tools, generated from `tools/catalog.json`). This page is about using them correctly: which system a call reaches, how to read and rewrite source, how activation is judged, and the places where a call can look successful without having done anything.

## Contents

- [Call shape](#call-shape)
- [Gateway mode](#gateway-mode)
- [Which system a call goes to](#which-system-a-call-goes-to)
- [Reading objects](#reading-objects)
- [Rewriting an object](#rewriting-an-object)
- [Driving the lock yourself](#driving-the-lock-yourself)
- [Activation](#activation)
- [Checks and unit tests](#checks-and-unit-tests)
- [Transport requests](#transport-requests)
- [Screens, GUI statuses, text pools](#screens-gui-statuses-text-pools)
- [Data preview](#data-preview)
- [Error codes](#error-codes)
- [Looks successful, is not](#looks-successful-is-not)

---

## Call shape

Every tool takes a JSON object and returns either an object or plain text. A failure returns `isError: true` with a JSON body:

```json
{
  "ok": false,
  "code": "SYSTEM_READ_ONLY",
  "message": "System \"qas\" is tier \"qa\", which is read-only. Writing requires tier \"dev\".",
  "details": { "system": "qas", "tier": "qa" }
}
```

Argument names are exactly as declared in the tool schema (`program_name`, `transport_request`, …). Renaming one produces `INVALID_ARGUMENT`.

## Gateway mode

`Gateway*` follows the exposure level: `toolPolicy.expose: "gateway"` advertises the three tools and nothing else, `"core"` advertises them next to a curated set, and every other level advertises none. They are the way to use a tool that is not in the advertised list.

```jsonc
// 1. which systems do I have?
{ "tool": "GatewayListSystems", "arguments": {} }
// { "systems": [ { "id": "dev", "default": true }, { "id": "qas", "default": false } ] }

// 2. find the tool
{ "tool": "GatewayListTools", "arguments": { "query": "sql query" } }
// { "total": 1, "tools": ["GetSqlQuery"], "next": "Call with GatewayCallTool …" }

// 3. read its arguments if needed
{ "tool": "GatewayListTools", "arguments": { "tool": "UpdateProgram", "detail": "schema" } }

// 4. run it
{ "tool": "GatewayCallTool",
  "arguments": { "tool": "GetProgram", "arguments": { "program_name": "ZFIR0094" }, "system": "dev" } }
```

- `GatewayListTools` filters: `pattern` (`Get*`, `*Program*`, `*Low`), `verb`, `query` (every word must appear), `layer` (`readonly` / `write` / `low`), `limit`.
- `detail`: `names` (default), `descriptions` (adds one line and the effect), `schema` (needs `tool`; returns the full input schema).
- `GatewayCallTool` accepts any name in the contract, including tools the current filter hides. Writes behind it are serialized per system and hit the same tier check — it is a dispatcher, not a bypass.
- It refuses an unknown name and refuses to call itself.

## Which system a call goes to

The contract has no `system` parameter, so the server adds one to every tool in `tools/list`:

```jsonc
// GetProgram gains this property:
"system": { "type": "string", "enum": ["dev", "qas", "prd"], "description": "SAP system to use …" }
```

- One system configured: omitting `system` uses it.
- Several systems configured: `system` is required, otherwise `SYSTEM_UNKNOWN` lists the valid ids.
- An unknown id: `SYSTEM_UNKNOWN` with `details.systems`.
- `defaultSystem` only affects the description text; it does not make `system` optional when several systems exist.

## Reading objects

```jsonc
{ "tool": "GetProgram",         "arguments": { "program_name": "ZFIR0094", "system": "dev" } }
{ "tool": "GetClass",           "arguments": { "class_name": "ZCL_SD_R001" } }
{ "tool": "ReadCdsView",           "arguments": { "view_name": "ZI_SALES_ORDER" } }
{ "tool": "ReadTable",          "arguments": { "table_name": "ZTSD001" } }
{ "tool": "ReadFunctionModule", "arguments": { "function_module_name": "Z_SD_R001_GET", "function_group_name": "ZFG_R001_01" } }
```

- A read returns the **submitted** version. Pass `version: "inactive"` to look at a draft.
- `GetProgram` and friends return `source_code`. A missing object can answer `success: true` with `source_code: null`, so use `SearchObject` or `GetObjectInfo` to decide whether an object exists.
- `GetProgFullCode` fetches a program together with its includes.

## Rewriting an object

Write tools accept the **whole source**; there is no patch channel. The sequence is fixed:

1. read the current source and keep it as a baseline on disk;
2. change the few lines locally;
3. upload the whole file with `UpdateProgram` (or `UpdateClass`, `UpdateCdsView`, `UpdateTable`, …);
4. read the active version back and compare it with what you sent.

```jsonc
{ "tool": "UpdateProgram",
  "arguments": { "program_name": "ZFIR0094", "source_code": "<full source>", "transport_request": "S4HK900123" } }
```

- There is no editor and no autosave: only a successful response means the source was written. A real syntax error is caught before upload, in which case nothing in the system changed — fix the code and send again.
- An object in a transportable package needs `transport_request`, otherwise SAP refuses the write and the tool reports `transport-required`. Objects in `$TMP` do not.
- To create something: `Create*` creates the shell only (no source argument). Write the full source as the very next call rather than filling fields in over several calls.

## Driving the lock yourself

The `*Low` tools map one tool call to one ADT request, so you own the lock:

```text
LockProgram        → lock_handle
UpdateProgramLow    (lock_handle, source_code)     // no activate
UnlockProgram       (lock_handle)
ActivateObjects     (name + type)
```

- A lock handle is valid only in the session that created it. This gateway keeps one session per system, so consecutive calls land in the same ABAP session.
- Always release it. An object left locked answers every later lock request with 400. The high-level write tools release the lock for you.
- Do not mix a `*Low` lock with a high-level write on the same object; the high-level tool takes its own lock.
- A handle that is truly lost can only be cleared by SAP session timeout or in SM12.

Prefer the high-level tools (`UpdateProgram`, `DeleteClass`, …): they lock, write and unlock in one call.

## Activation

```jsonc
{ "tool": "ActivateObjects", "arguments": { "objects": [ { "name": "ZFIR0094", "type": "PROG/P" } ] } }
```

- `objects` needs `type` (`PROG/P`, `PROG/I`, `CLAS/OC`, `TABL/DT`, `DDLS/DF`, …). A name alone fails, because there is no URI to resolve.
- Objects that reference each other must be activated in one batch, otherwise the first one fails to compile.
- `activated: true` means the active version equals the source just written. `REPOSRC.R3STATE = 'A'` only proves there is no leftover draft — the active version could still be older content, so it is supporting evidence, not proof.
- An include (`PROG/I`) can be activated on its own, but its real compilation evidence comes from the main program.

## Checks and unit tests

```jsonc
{ "tool": "CheckProgramLow", "arguments": { "program_name": "ZFIR0094" } }
{ "tool": "RunUnitTest", "arguments": {
    "container_class": "ZCL_SD_R001",
    "tests": [ { "container_class": "ZCL_SD_R001", "test_class": "LTC_SD_R001", "methods": [ "test_GET" ] } ],
    "duration": { "risks": [ "medium" ], "durations": [ "short" ] } } }
```

- Read `executed` and `errors`, not the wording of `success`. `executed: false` means nothing was checked (`status: notProcessed`) — it is not a pass.
- Unit test outcomes are in `run_result` (`Total` / `Passed` / `Failed`), not in the status line.
- CDS syntax checks are not available on every release (`0 analyzed`); activation is the compile step there.

## Transport requests

```jsonc
{ "tool": "ListTransports",  "arguments": { "modifiable_only": true } }
{ "tool": "GetTransport",    "arguments": { "transport_number": "S4HK900123" } }
{ "tool": "CreateTransport", "arguments": { "description": "MM vendor interface R001 20261104" } }
```

- When an object is already recorded in an unreleased request, the change belongs to that request; pass its number on the write call.
- Create a request only when one is actually needed. **The description must be ASCII**: non-ASCII characters are stored as `#`.
- `CreateTransport` does not return a request number in a dedicated field; it is the last segment of the returned `uri`. Confirm with `GetTransport`.
- `modifiable_only: true` does not tell you whether a usable request exists — check `status_text` from `GetTransport`, or `E070-TRSTATUS` directly.

## Screens, GUI statuses, text pools

ADT has no resource for these three, so those tools call remote-enabled function modules that must be installed in the target system (sources in [`abap/`](../abap/README.md)):

| Tools | Bridge module |
|---|---|
| `GetScreen`, `CreateScreen`, `UpdateScreen`, `DeleteScreen` | `ZMCP_ADT_DISPATCH` |
| `GetGuiStatus`, `CreateGuiStatus`, `UpdateGuiStatus`, `PatchGuiStatus` | `ZMCP_ADT_DISPATCH` |
| `GetTextElement`, `CreateTextElement`, `UpdateTextElement`, `WriteTextElementsBulk` | `ZMCP_ADT_TEXTPOOL` |
| `GetTcodeUsage`, `GetJobUsage` | `ZMCP_WL_TCODE_USAGE`, `ZMCP_WL_JOB_USAGE` |

- The bridge needs `rfcBackend: "soap"` (the default) and a reachable `/sap/bc/soap/rfc`.
- The modules must be remote-enabled. ADT cannot create a remote-enabled module, so use `node tools/scripts/import-abap-bridges.mjs --profile <id>`.
- `UpdateScreen` and `UpdateGuiStatus` replace the whole definition: `Get*` first, change, write back. Use `PatchGuiStatus` for a few rows.
- Text pools are written per language. Read back with the same `language`, otherwise you get the logon language's pool.

## Data preview

```jsonc
{ "tool": "GetSqlQuery", "arguments": { "sql_query": "SELECT carrid, connid FROM spfli WHERE carrid = 'LH'", "row_number": 50 } }
```

- This is a column preview, not a SQL console: real column names, `AS` aliases, aggregates, `WHERE` / `JOIN` / `ORDER BY`. Functions such as `LENGTH(x)` are rejected with 400 — select the raw column and compute elsewhere.
- Do not select `MANDT` on client-dependent tables: the endpoint filters by logon client and treats the column as unknown. `T000` and similar client tables are the exception.
- `state.totalRows` is paged silently; `N of N+1` means truncated. Run a `COUNT(*)` for the real size.

## Error codes

Five codes come from the gateway, the rest from the ADT layer:

| `code` | Meaning | Next step |
|---|---|---|
| `SYSTEM_UNKNOWN` | No `system` sent, unknown id, or nothing configured | Check `details.systems` |
| `SYSTEM_READ_ONLY` | Target tier is not `dev` | Point the call at a development system |
| `INVALID_ARGUMENT` | Missing or mistyped argument | Follow `message` |
| `UNKNOWN_TOOL` | Name not in the contract | See [TOOLS.md](./TOOLS.md) |
| `NOT_IMPLEMENTED` | In the contract, not in this build (`--coverage` should read 335/335) | Report a defect |
| `auth` | 401, failed logon, or an expired session that failed after one replay | Check credentials and the user in `SU01` |
| `locked` | The object is locked by another session, or by a handle you did not release | Close the editor tab, inspect SM12, check for a second gateway process |
| `invalid-lock` | The handle does not belong to this session | Lock again |
| `not-found` | No such object, or the name/type pair does not match | Confirm with `SearchObject`; names are uppercase |
| `transport-required` | Transportable package without `transport_request` | Pass the request number |
| `content-negotiation` | ADT rejects the declared `Accept` | The session retries once with `*/*`; if it still fails the resource is genuinely unavailable |
| `check-failed` / `upstream` | SAP rejected the request; `sapText` holds its text | Fix the request, do not retry blindly |
| `network` | Unreachable, TLS failure, timeout | Check the network path and certificate |

## Looks successful, is not

| Symptom | What is really going on |
|---|---|
| `success: true` with `source_code: null` | The object does not exist. Use `SearchObject` to decide existence |
| Activation reported, source unchanged | Only a draft was written. Read `version: "active"` and compare |
| A write returned without error but nothing changed | No `transport_request` on a transportable object; check the returned `code` |
| A check reports `errors: 0` | Look at `executed` first — `false` means nothing was checked |
| A unit test "passed" | Read the counters in `run_result`, not the status line |
| Text elements were written but cannot be read | Read and write used different `language` values |
| The preview returned only a few rows | `totalRows` is paged; count with `COUNT(*)` |
