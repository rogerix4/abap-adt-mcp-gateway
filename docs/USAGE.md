# Usage

> The tool list is in [TOOLS.md](./TOOLS.md) (335 tools, generated from `tools/catalog.json`). This page is about using them correctly: which system a call reaches, how to read and rewrite source, how activation is judged, and the places where a call can look successful without having done anything.

## Contents

- [Call shape](#call-shape)
- [Gateway mode](#gateway-mode)
- [Which system a call goes to](#which-system-a-call-goes-to)
- [Reading objects](#reading-objects)
- [Rewriting an object](#rewriting-an-object)
- [Argument shapes differ by verb](#argument-shapes-differ-by-verb)
- [Measured traps](#measured-traps)
- [Driving the lock yourself](#driving-the-lock-yourself)
- [Activation](#activation)
- [Checks and unit tests](#checks-and-unit-tests)
- [Transport requests](#transport-requests)
- [Screens, GUI statuses, text pools](#screens-gui-statuses-text-pools)
- [Data preview](#data-preview)
- [Working efficiently](#working-efficiently)
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
 "arguments": { "tool": "GetProgram", "arguments": { "program_name": "ZDEMO_REPORT" }, "system": "dev" } }
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
{ "tool": "GetProgram", "arguments": { "program_name": "ZDEMO_REPORT", "system": "dev" } }
{ "tool": "GetClass", "arguments": { "class_name": "ZCL_DEMO_REPORT" } }
{ "tool": "ReadCdsView", "arguments": { "view_name": "ZI_DEMO_ORDER" } }
{ "tool": "ReadTable", "arguments": { "table_name": "ZDEMO_TABLE" } }
{ "tool": "ReadFunctionModule", "arguments": { "function_module_name": "Z_DEMO_GET", "function_group_name": "ZFG_DEMO" } }
```

- A read returns the **submitted** version. Pass `version: "inactive"` to look at a draft.
- `GetProgram` and friends return `source_code`. A missing object can answer `success: true` with `source_code: null`, so use `SearchObject` or `GetObjectInfo` to decide whether an object exists.
- `GetProgFullCode` fetches a program together with its includes.

## Rewriting an object

There is no editor and no partial write: the payload always carries the whole source. What
the tools do offer is a way to *build* that payload without re-sending it:

| Argument | What it does |
|---|---|
| `source_code` | the full text, inline |
| `source_file` | absolute path to a UTF-8 file the gateway reads itself — use it above ~500 lines instead of escaping 90 KB into JSON |
| `patch` | `[{ old, new, expected_count }]` applied to the **active** source in the gateway, so unchanged lines never travel. Every hunk must match the declared number of times or nothing is written |
| `expected_line_count` / `expected_sha256` | validated **before** the lock is taken; a mismatch aborts with `CONTENT_MISMATCH` and leaves no lock, no write, no inactive version |
| `check_no_change` | reads the active version first; when it already equals the payload the call answers `no_change: true` without locking or writing |

```jsonc
{ "tool": "UpdateProgram",
 "arguments": { "program_name": "ZDEMO_REPORT", "source_file": "C:/work/ZDEMO_REPORT.abap",
 "expected_line_count": 1832, "activate": true } }
```

The path is read by the **gateway**, not by your editor, so it must be absolute and it must exist
on the machine the server runs on: `C:/work/...` on Windows, `/home/you/...` on macOS and Linux.

The sequence stays the same:

1. read the current source and keep it as a baseline on disk;
2. change the few lines locally;
3. upload with `UpdateProgram` (or `UpdateClass`, `UpdateCdsView`, `UpdateTable`, …);
4. read the active version back and compare it with what you sent.

- Every response reports `line_count`, `sha256` and `transport_used`, so step 4 has something to compare against. A non-empty `mismatch` means the active version is **not** what you sent.
- A real syntax error is caught before upload, in which case nothing in the system changed — fix the code and send again.
- An object in a transportable package needs `transport_request`, otherwise SAP refuses the write and the tool reports `transport-required`. Objects in `$TMP` do not.
- To create something: `Create*` creates the shell only (no source argument). Write the full source as the very next call rather than filling fields in over several calls.
- `activate: false` leaves an inactive version behind, and the response says so. That is a deliberate staging step, not a finished write.

## Argument shapes differ by verb

There are 72 object families and one verb is not the same argument set across them. Measured
on a live system: a call that sends an argument the tool does not declare fails whole with
`INVALID_ARGUMENT` naming every extra key, so one schema check per *verb*, not per family, saves
the round. The full list is in [TOOLS.md](./TOOLS.md).

| Payload argument | Tools that take it |
|---|---|
| `source_code` | `UpdateProgram`, `UpdateClass`, `UpdateInterface`, `UpdateInclude`, `UpdateFunctionModule`, `UpdateBehaviorDefinition`, `UpdateMetadataExtension`, `UpdateServiceDefinition`, `CreateInclude` |
| `ddl_code` | `UpdateTable`, `UpdateStructure`, `CheckTableLow`, `CheckStructureLow` |
| `ddl_source` | `CreateCdsView`, `UpdateCdsView`, `UpdateCdsViewLow`, `CheckCdsViewLow` |
| `properties` | `UpdateDataElementLow`, `UpdateDomainLow` |
| `fields` | `CreateStructure`, `GetTableContents` |
| `cua_data` / `dynpro_data` | `UpdateGuiStatus`, `UpdateGuiStatusLow`, `PatchGuiStatus`, `UpdateScreen`, `UpdateScreenLow` |
| `cua_data` (create) / `xml_file` | `CreateGuiStatus`, `CreateSmartForm` |

- A high-level `Create*` takes the name and the package; the source is the **next** call. Two
 exceptions carry their definition already: `CreateStructure` needs `fields` and
 `CreateCdsView` takes `ddl_source`.
- `Create*Low` wants `description` where `Create*` defaults it, and `Update*Low` always wants
 `lock_handle` — the low-level pair never locks for you.
- `Validate*Low` takes the name plus `description` in most families, and `package_name` in the
 families whose name check is really an existence check.
- `Unlock*Low` is **not** uniform: `Class`, `ClassTestClasses`, `GuiStatus`, `Screen` and
 `MetadataExtension` want name + `lock_handle` only; the families with an ADT lock resource
 also want `session_id`.
- `MetadataExtension` spells its own name differently per verb: `name` for create, update, lock,
 check and validate, `metadata_extension_name` for read, get and delete.
- The local-include writes (`UpdateLocalTestClass`, `UpdateLocalTypes`, `UpdateLocalMacros`,
 `UpdateLocalDefinitions`) take `activate_on_update` and honour it (default `false`). They write
 the **inactive** include only, so without it the change is not what SAP compiles.
- `UpdateCdsUnitTest` is the same kind of write but has **no** activation argument — its contract
 is `class_name` + `test_class_source` — and `RunUnitTest` runs the active version. The working
 order is `CreateCdsUnitTest` → `UpdateCdsUnitTest` → `ActivateClassTestClassesLow` →
 `RunUnitTest`. `DeleteCdsUnitTest` deletes the whole generated class, not just the include, so a
 later `UpdateCdsUnitTest` on that name answers `Not found: Resource CLASS_INCLUDE …`.
- `FunctionModule` verbs always need `function_group_name` next to the module name.
- `Include` is a four-verb family (create, get, update, delete): no lock, check or activate, and
 `CreateInclude` needs `main_program`.
- `BehaviorDefinition` create needs `root_entity` and `implementation_type`; `BehaviorImplementation`
 names the class in `class_name` and needs the BDEF in `behavior_definition`.

## Bridge-backed tools

Some verbs do not go through ADT at all: they call a function module over RFC
(`ZMCP_ADT_DISPATCH`, `ZMCP_ADT_TEXTPOOL`, `ZMCP_SSF_*`, `ZMCP_WL_*`) and the module returns its
result as a string. Two consequences, both measured:

- The string arrives XML-escaped (`&#34;HEADER&#34;`). The gateway decodes it and parses it when it
 holds JSON, and hands back the decoded text when it does not, so a caller sees the same shape as
 a native tool. Anything that bypasses the gateway sees the escaped form.
- That decoding is per bridge, not per transport: the ADT route and the SOAP RFC bridge each have
 their own parser, and a bridge whose answer never got decoded reads as *empty* rather than as an
 error (`{&#34;PART&#34;:…}` fails `JSON.parse`, so the caller sees "returned no XML" / "no text
 elements" although SAP answered `subrc=0` with a 218 kB payload). If a bridge tool reports an
 empty answer while the same action works in SE37, suspect the decoder before the module.
- A bridge that answers nothing is not an error the gateway can tell from an empty result. When a
 bridge read comes back empty, suspect the module on the target system (missing customising,
 missing authorisation) before suspecting the argument list.

Screen and GUI-status writes need a *document* shape that ADT never shows you. The smallest GUI
status that round-trips is `{ADM:{},STA:[{CODE:"MAIN",MODAL:"",INT_NOTE:"…"}],SET:[],FUN:[],PFK:[],
BUT:[],MEN:[],MTX:[],ACT:[],DOC:[],TIT:[],BIV:[]}`; `CreateScreen` needs `dynpro_data` for the same
reason. Both are write-shaped, so they are refused on a read-only tier.

## Leftover generation enqueues (`E_ABAP_GENPH`)

Activation is not a write to one object: SAP *generates* the object's includes (a class gets a `C`
and a `P` part, an object with an extra part gets a third), and each generated include is enqueued
exclusively — enqueue object `E_ABAP_GENPH`, key `~<include name>` — so no second activation can
build the same include at the same time. The entry belongs to that generation and is dequeued when
the generation finishes.

Measured on a live dev system, one variable at a time:

| Action | Entries in SM12 |
|---|---|
| one `UpdateClass` (write + activate) on a single object | visible while it ran, gone afterwards |
| a test-class include written and **not** activated | none |
| a unit-test-only run | visible while it ran, gone as soon as the run ended |
| a full sweep (hundreds of verbs) | several, still there when read immediately after the last step |

The lifetime is the generation itself — seconds. A burst makes many overlap, so a reading taken
right after a big run catches the tail of the drain, which is what made this look like a leftover
lock. Nothing lingers: the entries are gone on their own within seconds to a couple of minutes, and
there is nothing to clean up.

They are still not releasable from the client side, which is why they look permanent while they
last: `UNLOCK` has no key for it, `logoff` does not take it, deleting the object does not clear it,
and the enqueue table is not readable over ADT here (`GetTableContents` on `SEQG3` →
`400 处理权限检查时 出错`), so SM12 is the only view.

Practical rule: one entry per generated include, alive for the generation. Keep write runs opt-in,
run them to completion instead of cancelling them, and do not treat an entry seen right after a bulk
run as a defect — it blocks nothing except a re-activation of that same object for a few seconds.

Entries stay behind only when a generation is **aborted mid-flight**: the client process is killed,
the connection drops during a long activation, or the session is logged off while a generation is
still queued. That is the only way to produce the batch this repository saw during interrupted
coverage runs; those aged out on SAP's own timer within tens of minutes. An ABAP Unit run (test-class
include written, activated, then `RunUnitTest`) was measured the same way and also left SM12 empty,
so the generation of test includes is not special. Nothing on the client side releases one —
`UNLOCK` has no key for it, `logoff` does not take it, deleting the object does not clear it — and
the enqueue table is not readable over ADT here (`GetTableContents` on `SEQG3` →
`400 处理权限检查时 出错`), so SM12 is the only view.

Practical rule: one entry per generated include, alive for the duration of the generation. Let a
write pass finish instead of cancelling it, keep write passes opt-in, and read a leftover entry as
evidence that a run was interrupted rather than as something the run forgot to clean up.

## Tool-by-tool notes

Measured one tool at a time on a live dev system, normal path and the wrong way round.

### `DeleteClass`

- Existing `$TMP` class: `{deleted: true, status: 200, lock_released: true}` — the delete takes the
 lock itself and releases it, so no `Unlock` is needed afterwards.
- Object that never existed: `not-found` from the lock step (`CLASS X 不存在`), no dump. Deleting is
 therefore idempotent from the caller's point of view: a rerun reports the same not-found.
- Deleting a standard object (SAP namespace) is not something this gateway polices: the name/type
 pair simply goes to ADT. Only Z*/Y* objects are yours to delete — a wrapper or a guard on the
 caller's side may refuse it earlier, and if the request does reach SAP the refusal comes back as
 an ordinary `check-failed` / `upstream` with SAP's own text.

### `GetClass`

- Existing object: `{version, line_count, source_code}`.
- Never-created or deleted object: `not-found`, HTTP 404, and no dump is left behind — the tool
 checks existence first, and reading the source of an object that is gone used to answer 500 plus a
 short dump (`CX_OO_CLIF_NOT_EXISTS` in `CL_OO_CLIF_SOURCE`).

### `UpdateClass`

- `$TMP` class with valid source: `{written: true, activated: true, status: "activated",
 line_count, sha256, transport_used: null}` — one call locks, checks, writes and activates.
- Invalid source: SAP's own refusal (`HTTP 400 The statement THIS is unexpected`); nothing is
 written, so the object keeps its previous version.
- Object does not exist: `not-found` from the lock step (`CLASS X 不存在`), not a dump.
- `source_file` that cannot be read: `INVALID_ARGUMENT` naming the path and the OS error, with
 "pass an absolute path readable by the gateway process, or send `source_code` inline".

### `CheckClassLow`

- Without `source_code`: checks the **stored** (inactive) version and answers
 `{errors, warnings, messages, checked_version}`.
- With `source_code`: `INVALID_ARGUMENT` — "a checkrun only sees a stored version". Write first
 (`LockClassLow` → `UpdateClassLow` → `UnlockClassLow`) or use `UpdateClass`, which checks the
 payload before it writes. Before this guard existed the call answered `errors: 0` for text that
 was never looked at.

### `UpdateClassLow`

- No `lock_handle`: `INVALID_ARGUMENT` — "needs \"lock_handle\" from LockClassLow". The low verb never
 locks for you; `UpdateClass` is the one that locks, writes and activates in a single call.
- Correct handle: writes and answers `{lock_handle, activated: false, line_count, sha256,
 transport_used}`. `activated: false` is the contract: the write lands in the inactive version, so a
 `Check…`/activation has to follow.
- Wrong handle: `invalid-lock`, HTTP 423, with SAP's own text
 (`Resource CLASS X is not locked (invalid lock handle: …)`) and the reminder that a handle only
 lives in the session that created it.

### `LockClassLow` / `UnlockClassLow`

- Locking an object that another session already edits: `locked`, HTTP 403, `使用者 <user> 当前编辑
 <object>`. A lock whose owning session is gone (the process was restarted) stays until it is
 cleared in SM12 — a new session cannot take or release it.
- `UnlockClassLow` answers `success: true` even when the handle is wrong: ADT replies 200 to an
 unlock that released nothing. Trying to verify by locking again does **not** work either — the
 same session can always take the lock again, so the second attempt succeeds whether or not the
 first unlock did anything. The response therefore carries
 `release_unverified: true`: only a lock attempt from a *different* session shows the truth, and
 the gateway cannot arrange that.
- `session_id` is **not** uniform across the unlock verbs: `UnlockClassLow` does not declare it,
 while the other `Unlock*Low` verbs require it (`missing "session_id"`). Passing it everywhere is
 an `INVALID_ARGUMENT`, passing it nowhere fails the other ten — check the declared schema per tool
 instead of assuming one shape (measured 2026-11-07).

### `GetCdsView` / `UpdateCdsView`

- `GetCdsView` returns the DDL source (`source_code`) with the annotations SAP holds; a missing view
 answers `not-found` (`No such object: /ddic/ddl/sources/<name>`), no dump.
- `UpdateCdsView` takes `ddl_source` (not `source_code`) and locks, writes and activates in one call:
 `{written: true, activated: true, status: "activated"}`.
- The gateway does **not** insist on `@AccessControl.authorizationCheck`: a view without it was
 accepted and activated on a live system. Requiring the annotation is a *process* rule
 (usually enforced by a hook or review), not something SAP refuses here — do not expect the tool to
 catch it.
- Also accepted without complaint: dropping a key field. The view activated; whether that is a
 meaningful change is a review question, not a gateway one.

### `GetTable` / `UpdateTable` / `GetStructure` / `UpdateStructure`

- `GetTable` / `GetStructure` return the **DDL source** (`source_code`), including the annotations
 SAP put there — that is the text to edit, not a hand-written skeleton.
- `UpdateTable` / `UpdateStructure` with the read-back DDL plus one more field:
 `{written: true, activated: true, status: "activated"}`.
- Without `@AbapCatalog.enhancement.category: #NOT_EXTENSIBLE` the save is refused:
 `HTTP 400 Can't save due to errors in source; execute check for details`. SAP rejects the source
 **before storing it**, so there is no draft to check — running a check cannot explain it, and the
 answer now says so and names the missing annotation as the usual cause.

### `GetDomain` / `UpdateDomainLow` / `GetDataElement` / `UpdateDataElementLow`

- `GetDomain` / `GetDataElement` return the object **document** (`content`, XML), not source text.
- `UpdateDomainLow` / `UpdateDataElementLow` take `properties` (`{datatype, length, description, …}` /
 `{data_type, field_label_short, …}`) under a `lock_handle`, and answer `activated: false` — they only
 stage the change, so an activation has to follow.
- Both the flat arguments and `properties` are accepted, and numbers work: `properties: {length: 50}`
 changes both `<doma:length>` nodes (type and output) — `40 → 50 → 40` was verified by reading the
 document back. Earlier the payload was read from the flat arguments only and a JSON number
 was dropped, so the call answered `written: true` while nothing changed; the write path now also
 re-reads the document and reports `mismatch` when a property it was given is not in what SAP stored.

### `FunctionGroup` / `FunctionModule`

- `GetFunctionModule` without `function_group_name`: `INVALID_ARGUMENT` — "Missing
 \"function_group_name\"". Every `FunctionModule` verb needs the group next to the module name.
- `CreateFunctionModule` in an existing group: `{adt_type: "FUGR/FF", activated: true}`.
- `CreateFunctionModule` in a group that does not exist: **`not-found`** (`Not found: 功能组 X 不存在`,
 status 500). The 5xx text names a missing object, so it is classified as one; Earlier it
 answered `upstream` and a wrapper had to read `sapText` to tell "parent missing" from "server broken".
- `UpdateFunctionModule` refuses the classic SE37 interface comment block **before** touching SAP:
 a `*"` line answers `INVALID_ARGUMENT` ("SAP answers \"Parameter comment blocks are not allowed\"")
 with the header form to use instead.
- `UpdateFunctionGroup` is a **description patch** on the object document, not a source write: the
 group source is generated from its includes. The answer still carries `written / activated /
 line_count / sha256`, and `line_count` there is the *document's* one line — not source lines. Read
 the description back with `SearchObject` (`description` field) to confirm it landed.
- `UpdateFunctionModule` with valid source: `{written: true, activated: true}`. With a payload SAP
 cannot compile: `{success: false, activated: false, reverted: true}` and the previous active source
 is restored, same as `UpdateProgram`.
- Its source is compared as a **token stream**, not line by line: SAP stores the signature in its own
 section and re-lays the text out on read, and how it does that depends on the system's editor
 setup. Line breaks, indentation and keyword case are therefore irrelevant to the verdict; a missing
 statement or a changed literal is still a mismatch (`token streams differ at character N`).

### `GetInterface` / `UpdateInterface`

- Existing interface: `{version, line_count, source_code}`; missing: `not-found`
 (`No such object: /oo/interfaces/<name>`), no dump.
- `UpdateInterface` with a syntax error behaves like `UpdateClass`, not like `UpdateProgram`: the
 interface source PUT is refused by SAP itself (`HTTP 400 The statement THIS is unexpected`), so
 nothing is stored and no rollback is needed.
- With valid source: `{written: true, activated: true, status: "activated", line_count, sha256}`.

How the three source families react to a payload SAP cannot compile — worth knowing, because only
one of them leaves anything behind:

| Family | Rejected payload |
|---|---|
| Class, Interface | SAP refuses the PUT (HTTP 400), nothing is written |
| Program | the PUT succeeds, activation fails, and the previous active source is written back (`reverted: true`) |
| any family with `activate:false` | the draft is kept on purpose — that is what the flag asks for |

### `GetProgram` / `UpdateProgram`

- `GetProgram` on an existing program: `{version, line_count, source_code}`; on a missing one:
 `not-found` (`No such object: /programs/programs/<name>`), no dump.
- `output: "file"` (declared on `GetProgram`, `GetClass`, `GetInterface`, `GetInclude`,
 `GetFunctionModule`, `GetProgFullCode`) writes the source to
 `<output dir>/sources/<tool>/<name>[-<version>].abap` and answers `{path, line_count, outline}`.
 The outline is the top-level blocks only (`CLASS … DEFINITION|IMPLEMENTATION`, `INTERFACE`,
 `FORM`, `FUNCTION`, `MODULE`) with their line range — a map, not a parse. `ABAP_ADT_MCP_OUTPUT_DIR`
 moves the directory; the default is `<tmp>/abap-adt-mcp`.
- `UpdateProgram patch: [{old, new, expected_count?}]` is applied to the **active** source and reports
 `{applied: [{match, count}]}`; a hunk that matches a different number of times answers
 `CONTENT_MISMATCH` and writes nothing. `expected_sha256` / `expected_line_count` do the same for the
 payload as a whole. `check_no_change: true` answers `{written: false, no_change: true}` (the
 `activated` field then only reports the state, nothing was activated).
- `UpdateProgram activate:false`: `{written: true, activated: false, note: "activate=false left an
 inactive version; activate it or revert before leaving it there."}` — the deliberate staging step.
- `UpdateProgram` with a syntax error, `activate` left at its default: the source is written (a
 program source PUT accepts any text), the activation reports the error, and the **previous active
 source is written back and re-activated** — the answer is
 `{success: false, activated: false, reverted: true, status: "activation reported 1 error(s): … —
 the previous active source was restored, so nothing changed"}`. A following `ActivateObjects`
 then answers `activation_executed: false` (there is no draft), and `GetProgram` still returns the
 old source. `UpdateClass` behaves the **same way**, not as the earlier
 note claimed — no family writes a broken draft and leaves it.

### `ActivateObjects`

- `objects` needs `type` per entry (`PROG/P`, `CLAS/OC`, …). A name alone answers
 `INVALID_ARGUMENT: unsupported type "" for <name>. Pass "uri" instead.`
- Success: `{activation_executed, generation_executed, errors, warnings, messages, raw_xml}`.
 `activation_executed: false` means there was nothing to activate — the active version already
 equals the draft, which is also how you confirm that a rejected write left no draft behind.

### `CreateInclude`

- `main_program` is optional — it is what registers the include under a program. Without it the
 include is still created and answers
 `{inserted_into_main: false, insert_note: "main_program is required to register the include"}`:
 the object exists, but no program references it, so nothing compiles it.
- With `main_program` + `insert_into_main: true`: writes the `INCLUDE` line into the parent, activates
 both, and answers `{inserted_into_main: true, main_program_activated, program_tree_check}`.
- Parent program that does not exist: `not-found` (`未找到 X 的对象列表`), no dump.

### `GetInclude` / `UpdateInclude`

- Existing include: `{version, line_count, source_code}`; the source is the active version.
- `UpdateInclude` locks, writes and activates in one call (`written`, `activated`, `line_count`,
 `sha256`, `transport_used`). With `main_program` it also answers `program_tree_check`
 (`{errors, warnings, messages}`) — an include only compiles inside its program, so that check runs
 on the parent, not on the include.
- Missing include: `not-found` — `GetInclude` says `No such object: /programs/includes/<name>`,
 `UpdateInclude` refuses at the lock step (`ZMMR_MCP_LTPROG_I03 does not exist`). Neither leaves a dump.

### `DeleteInclude`

- Answers `{status, pre_delete, lock_released}`. When the include is still named by a main program the
 tool **removes the `INCLUDE` line and re-activates the parent first**
 (`pre_delete: {main_program, removed_from_main: true, main_program_activated: true}`), so the old
 `403 其它程序中已索引了程序 X` no longer happens.
- A parent program that is already deleted is no longer fatal: `pre_delete` says
 `removed_from_main: false, remove_note: "the main program no longer exists …"` and the include is
 still deleted. Measured: reading the gone parent answered 404 and the whole delete failed.

### `CreateClass` / `UpdateClass` / `GetClass` / `ReadClass`

- `CreateClass` → `{success, name, package_name, description, adt_type, activated}`; the class comes
 back as the skeleton `CLASS ZCL_X DEFINITION … ENDCLASS.` / `… IMPLEMENTATION. ENDCLASS.`
 (`GetClass` shows it, 13 lines). `GetClass` and `ReadClass` answer the same
 `{version, line_count, source_code}`; `GetClass` also takes `output: "file"`, whose outline lists the
 definition and the implementation block separately (`{kind: "class", start_line: 1, end_line: 4}` /
 `{… 6 … 10}`).
- `UpdateClass` writes and activates in one call; a syntax error is **reverted** like a program's
 (`{written: true, activated: false, reverted: true, mismatch: "first difference at line 8: …"}`).
- `UpdateClassLow` needs `lock_handle` (from `LockClassLow`) and does not activate;
 `ActivateClassLow` does. Activating a class also publishes its local includes.

### Class test classes and ABAP Unit

- `UpdateLocalTestClass` requires `class_name` + `test_class_code`, and `activate_on_update: true`
 activates the parent class so the include reaches the active version. Earlier that flag
 was read through a string-only helper and a JSON `true` was ignored — the include stayed inactive and
 the run below answered an **empty** result document.
- `GetLocalTestClass` → `{path, status, source_code}` of the `testclasses` include;
 `DeleteLocalTestClass` empties it (`{cleared: true, activated: true}`) — there is no DELETE method on
 an include, so a clear is a PUT of an empty source.
- `RunClassUnitTestsLow {tests: [{container_class, test_class}]}` → `{run_id, location}`; then
 `GetClassUnitTestStatusLow {run_id}` → `{finished, status, percentage}` and
 `GetClassUnitTestResultLow {run_id}` → `{success, unit_result: {tests, failures, alerts[]}, raw_xml}`.
 `success` comes from the result document: a `failedAssertion` alert is `severity="critical"`, and
 Earlier it still answered `success: true`.
- An **empty** `<aunit:runResult/>` means nothing ran (inactive include, wrong test class name). It is
 reported as `tests: 0, test_classes: 0` — deliberately not as a pass.

### `CreateProgram` / `CreateProgramLow`

- Arguments the contract lists under `required` are **enforced** (335 tools, one check):
 `CreateProgram {program_name}` answers `missing "package_name"`, `CreateProgramLow` without
 `description` answers `missing "description"` — neither creates anything. Earlier both
 succeeded silently (`$TMP` / description = object name).
- A `program_type` outside the schema's enum is refused with the whole set
 (`must be one of "executable", "include", …; got "report"`); it used to be dropped and the
 program created as `executable`.
- The name being taken answers `already-exists` (SAP's 500 `已存在名为 X 的程序或 include`), with
 `nextAction: use Update* / Delete*` — not `upstream`.
- Both answer `{success, name, package_name, description, adt_type, activated}`; `CreateProgramLow`
 additionally takes `skip_check: true` to leave the post-create check to the caller.

### `CheckProgramLow` / `ValidateProgramLow`

- `CheckProgramLow` on a program that does not exist answers `not-found`. It used to answer
 `errors: 1 — The REPORT/PROGRAM statement is missing, or the program type is INCLUDE` about a
 `/programs/includes/…` URI nobody asked for, which reads like a defect in the caller's source.
- `ValidateProgramLow` answers name **availability**, not syntax: `{exists, available}`, and on a taken
 name adds `next_action: "… to check the existing object use Check*"`. It requires `description`
 because the contract does, even though availability does not depend on it.

### `LockProgramLow` / `UnlockProgramLow`

- `LockProgramLow` → `{lock_handle, transport_request}`. Activating while the lock is held answers
 `locked` (403 `使用者 U 当前编辑 X`): unlock first, then activate.
- `UnlockProgramLow` requires `session_id` (contract), and a handle the gateway's lock journal does not
 hold is **refused** (`No lock of this gateway is open under that handle`). Measured: SAP
 answers a plain 200 for an UNLOCK with an invented handle, so `success: true` was a false green.
 A handle minted by another client (ADT in Eclipse) cannot be released from here — close it there or
 clear it in SM12.
- A wrong handle on `UpdateProgramLow` answers `invalid-lock` (423) with SAP's own text.

### `DeleteProgram`

- Answers `{status, lock_released}`; confirm with `GetProgram` → `not-found`. A missing program answers
 `{success: true, deleted: false, already_gone: true, note: …}` — the lock step is where SAP says
 "Object directory entry was not found", and the caller's goal (the object is gone) is already
 reached. Earlier that path raised `not-found` instead.
- The same `already_gone` answer applies to every `Delete*` in the families.

### `GetProgFullCode`

- Returns the program **and its includes**: membership from the repository tree, falling back to
 `D010INC` (the tree is buffered per logon session), then each include's `source/main` appended under
 a `*&---- INCLUDE <name> ----` header. `{includes_source, includes: [{name, line_count}], source_code}`;
 an include that cannot be read is named in the text instead of being dropped.
- Earlier it returned `source/main` alone, so a program whose body is one `INCLUDE` came back
 with no body at all.
- The separators reuse the main source's line ending (SAP sends CRLF), so the assembled text does not
 mix `\r\n` and `\n`.
- `output: "file"` writes the assembled text and answers `{path, line_count, outline}`; the outline
 covers the includes too, because their bodies are in the file.

### `RuntimeRunProgramWithProfiling`

- Answers `{profiler_id, trace_id, run_status, output}` — `output` is the program's own list output
 (`WRITE` lines), which is how you prove a program actually ran. Both ids feed the profiler tools
 (`RuntimeListProfilerTraceFiles`, `RuntimeGetProfilerTraceData`).
- `description` becomes the trace description shown in SAT.
- Profiling a program that does not exist answers `not-found` (SAP puts `Error: Program does not
 exist!` in the body of a **200**, so Earlier the answer was `success: true,
 trace_pending: true` and the caller went looking for a trace that could never appear).
- The trace appears within a few seconds; when it does not, the answer carries `trace_pending: true`
 plus the exact next step instead of an empty `trace_id` without explanation.

### Runtime dumps: `RuntimeListDumps` / `RuntimeGetDumpById` / `RuntimeAnalyzeDump` / `HandlerDumpView`

Measured on a test system (client 100) (logon language ZH).

- `RuntimeListDumps {top, skip, user, orderby, include_summary}` → `{count, truncated, dumps:
 [{dump_id, error, program, user, published}]}` from the Atom feed. Each entry carries the dump's
 whole long text inside `atom:summary` (~13 KB), so it is dropped unless `include_summary: true`.
 `top` / `skip` are real query parameters — the tool used to be a route with a fixed `$top`.
- **All three single-dump tools read the same two resources**: `…/runtime/dump/<id>`
 (`application/vnd.sap.adt.runtime.dump.v1+xml`) for the facts and the chapter index, and
 `…/formatted` only when the caller asks for the long text. Earlier all three were a
 fixed route to `/formatted`, so `view` / `response_mode` / `chapters` changed nothing:
 `RuntimeGetDumpById {response_mode: "summary"}` answered 166 KB of long text, `path: "…/formatted"`,
 and no `summary` field at all.
- `RuntimeGetDumpById` shapes the answer by `response_mode`:
 `payload` (default) = `{facts, chapters}`; `summary` = `{summary: {title, error, exception, program,
 termination_uri, user, datetime}}` and **no** text is fetched; `both` = summary + facts + chapters.
- `facts.termination_uri` is the termination point:
 `adt://SID/sap/bc/adt/programs/programs/ztest_wtx3/source/main#start=1753` — the `#start=` is the
 statement line, which is how you open the exact place the dump happened.
- `chapters: ["developer"]` (or any chapter title / category prefix, e.g. `"源代码提取"`) implies
 `view: "formatted"` and returns only those sections, each under `===== <title> =====`. Measured:
 the developer chapters of a `CONVT_NO_NUMBER` dump are ~21 KB out of a 166 KB long text.
- Chapter titles come in the **logon language** (ZH here), so a title filter must use the titles the
 same answer's `chapters` shows; `"developer"` is the language-neutral shortcut (it matches the
 English, Chinese and German titles).
- A `dump_id` copied from `RuntimeListDumps` arrives percent-encoded and padded with spaces; the tools
 decode it, keep the last path segment and re-encode it, so pasting the feed value verbatim works.
- `HandlerDumpView {dump_id, view}` is the legacy name and answers the same shape as
 `RuntimeAnalyzeDump` (default view = facts + chapter index).

### Class family

- `CreateClass` / `CreateClassLow` → `{success, name, package_name, description, adt_type, activated}`.
 The testclasses include is declared in the create payload, which is what makes that include
 exist at all.
- `GetClass` / `ReadClass` → `{version, line_count, source_code}`; `GetClass` also honours
 `output: "file"` (outline splits `CLASS … DEFINITION` and `CLASS … IMPLEMENTATION` as two blocks).
- `UpdateClass` with a syntax error: `{written: true, activated: false, reverted: true, mismatch:
 "first difference at line N: …"}` — the previous active source is written back, exactly like
 `UpdateProgram`. `UpdateClassLow` writes without activating (`activated: false`).
- `ValidateClassLow` answers **availability, not syntax**: `{exists, available}`, and it needs
 `package_name` + `description` because the contract requires them. A name that exists answers
 `{success: false, exists: true, available: false}`. It used to answer "available" for an existing
 class because the probe read any refusal as absence.
- `LockClassLow` → `UpdateClassLow` → `UnlockClassLow` → `ActivateClassLow` is the manual chain;
 activating while the lock is held answers `locked` (403 `使用者 U 当前编辑 X`).
- `GetLocalTestClass` / `UpdateLocalTestClass` / `DeleteLocalTestClass` work on the `testclasses`
 include. `UpdateLocalTestClass {activate_on_update: true}` activates the parent and answers
 `{activated: true, activation: {status, errors, warnings}}`; Earlier the flag was read
 through a string-only helper, so a JSON `true` was ignored and the tests were left **inactive** —
 which makes every following unit-test run come back empty.
- `LockClassTestClassesLow` → `UpdateClassTestClassesLow` → `UnlockClassTestClassesLow` →
 `ActivateClassTestClassesLow`: the write body comes from **`test_class_source`** (the contract's
 name), not `test_class_code`; with the wrong name the PUT carried an empty body and SAP answered
 `Not found: Resource CLASS_INCLUDE <class> does not exist`.
- `RunClassUnitTestsLow` → `{run_id}` → `GetClassUnitTestStatusLow` → `{unit_status: {finished,
 status, percentage}}` → `GetClassUnitTestResultLow` → `{unit_result: {success, programs,
 test_classes, tests, failures, alerts[]}}`. The result tool's `success` follows the **result**:
 a failed assertion answers `success: false` with the assertion text in `alerts`, and an empty
 `<aunit:runResult/>` answers zero tests (nothing ran) instead of a silent pass.
- `RuntimeRunClassWithProfiling` needs `IF_OO_ADT_CLASSRUN` on the class. A class without it answers
 `UPSTREAM_FAILED` + `kind: classrun-not-supported` instead of `success: true, trace_pending: true`.
- `DeleteClass` / `DeleteClassLow` → `{status, lock_released}`; confirm with `SearchObject`.

### DDIC: `Table` / `Structure` / `Domain` / `DataElement`

- **Names**: a table or structure whose name has `_` at position **2 or 3** is refused with HTTP 422
 `表 X (不允许底线位于第二或第三库位)`. `ZT_MCP_T01` / `ZS_MCP_T01` cannot exist; `ZTST_…` / `ZST_…`
 can. The gateway now reports that as `request-rejected` (a 4xx is the caller's to fix, not
 `upstream`).
- `CreateTable` seeds the annotation block (`@EndUserText.label`, `#NOT_EXTENSIBLE`, `#TRANSPARENT`,
 `#A`, `#RESTRICTED`) and one `key client: abap.clnt` field. `UpdateTable` must keep that block —
 SAP's own skeleton has it and a hand-written DDL without it answers
 `Can't save due to errors in source`.
- A `CURR`/`QUAN` field without a reference field answers three activation errors
 ("Annotation with reference to currency code … is missing"); the gateway writes, sees the failed
 activation and restores the previous active version (`reverted: true`), so nothing half-done stays.
- `CreateStructure` composes the DDL from the **required** `fields`
 (`[{name, data_type, length, decimals, data_element, domain}]` → `id: abap.char(10);`) and writes it
 before activating. `includes` is refused with `NOT_IMPLEMENTED` rather than dropped silently.
- `CreateDomain` applies `fixed_values` in the create body (`{low, text}` → `doma:fixValue`);
 `UpdateDomain` changes `length` / `lowercase`… through the property spec and **keeps** the fixed
 values and every field SAP owns (verified by reading the domain back).
- `CreateDataElement` takes `type_kind: "domain"` + `type_name` (the domain) and all four labels;
 the read-back shows `dtel:shortFieldLabel` … `dtel:headingFieldLabel` with the label lengths SAP
 fixes (10 / 20 / 40 / 55).
- Every `Delete*` in this group answers `{status, lock_released}`; confirm with `Get*` → `not-found`.

### CDS: `CdsView` / `MetadataExtension` / `ServiceDefinition` / `Package`

- `CreateCdsView {ddl_source, activate}` creates, writes and activates in one call. A DDL SAP refuses
 answers `{success: true, activated: false, activation_note: "activation reported N error(s): …"}`
 — the shell stays, and `UpdateCdsView` is how you fix it. Measured:
 `@AbapCatalog.sqlViewName` is **not allowed** on `define view entity` (it belongs to the classic
 `define view`), and the note says so.
- `UpdateCdsView` / `CheckCdsViewLow` / `GetCdsView` / `DeleteCdsView` behave like the other text
 families: `written / activated / line_count / sha256`, `{errors, warnings, messages, checked_version}`,
 `{version, line_count, source_code}`, `{status, lock_released}`.
 `CheckCdsViewLow` reports warnings without failing (`success: true`), e.g. a projection that does not
 repeat the key of the underlying table.
- `CreateMetadataExtension` / `CreateServiceDefinition` create an **empty shell** whose activation
 fails (`Illegal syntax. Malformed annotate statement` / `Malformed service definition`) until
 `UpdateMetadataExtension` / `UpdateServiceDefinition` writes the source. The create answer carries
 `activated: false` plus that note — do not read it as success.
- The metadata-extension name travels as `name` on create/update and as `metadata_extension_name` on
 Read/Get/Delete (the contract's own split).
- A metadata extension only activates on a view that allows it: the target must carry
 `@Metadata.allowExtensions: true`, otherwise the annotation answers
 `Annotation 'Metadata.allowExtensions' missing in '<view>'` and the tool **restores the previous
 active source** (`{written: true, activated: false, reverted: true}`) — the object keeps its old
 content, so the red is real and nothing was half-applied. A metadata extension also needs a name
 of its own: giving it the **same name as the view** creates, reads and deletes fine and only the
 activation complains. Measured 2026-11-07 with `<view>_MD`.
- `CreatePackage` needs `super_package` plus `software_component`, `transport_layer` and
 `transport_request`: ADT refuses to create a package below a `$`-local package (no software
 component) and answers `409 <request> is not a local request` for an empty layer. A working recipe
 measured: `super_package: "ZTEST"`, `software_component: "HOME"`, `transport_layer:
 `ZDEV`" (read them off the parent with `GetPackage`). `GetPackage` on `$TMP` shows the other shape:
 softwareComponent `LOCAL`, transportLayer `SAP`.
- `CheckPackageLow` / `ValidatePackageLow` / `LockPackageLow` need `super_package` — except
 `DeletePackageLow`, whose contract takes only `package_name` + `transport_request`. `Validate*`
 answers availability (`exists / available`), not a package check.
- `UpdatePackageLow` changes the description through the property patch. SAP keeps a package
 enqueued to the session that wrote it, so the first low PUT is refused as "already locked" and the
 gateway drops that session, re-locks in a new one, writes and releases again. The answer therefore
 carries `retried_in_new_session: true`, `lock_released: true` and **`lock_handle: null`** — nothing
 survives to be unlocked, so do not chain an `Unlock*` call on a handle you remember. (Until the answer echoed the already-released fresh handle, and `UnlockPackageLow` with it was
 refused by the gateway itself: `No lock of this gateway is open under that handle`.)
- `DeletePackageLow` refuses while the package still holds objects: `包 X 仍然包含开发对象或其它包`
 (HTTP 400). Deleting the objects first is not always enough — an unreleased transport request keeps
 their TADIR rows, so the package can only go after that request is released.
- `GetPackageContents` / `GetPackageTree` answer the same node structure (`count`, `nodes`,
 `object_types`, `tree`); an empty package answers `count: 0` and is still a valid answer.

### RAP: `BehaviorDefinition` / `BehaviorImplementation`

Measured against the real chain (CDS → BDEF → BIMP), on `ZMCP_RAP` with a transport.

- Argument names differ per verb — the contract is the source of truth:
 `CreateBehaviorDefinition {name, root_entity, implementation_type}`, `UpdateBehaviorDefinition {name, source_code}`,
 `GetBehaviorDefinition {behavior_definition_name}`, **`CheckBdefLow {name}`** (not `CheckBehaviorDefinitionLow`),
 `CreateBehaviorImplementation {class_name, behavior_definition}`, `DeleteBehaviorImplementation {behavior_implementation_name}`.
- `CreateBehaviorDefinition` creates a shell whose activation fails (`Type "X" is unknown`) until the source is
 written; the create answer says so (`activated: false` + note). It does **not** send an `adtTemplate` on
 purpose: any `adtProperty` there makes SAP answer 500 "Access using a 'ZERO' object reference".
- The root entity must be a **root** view entity: a plain `define view entity` answers
 `The type "X" is not a root entity or is not released for BEHAVIOR implementations` on create — change the CDS
 to `define root view entity X …` first.
- `managed` needs a persistency: a root view over a standard table answers
 `No persistency is specified for "X" ("X" has the implementation type "managed")`. A real managed BO needs a
 custom table and `persistent table` / `with draft`. `abstract;` activates without persistency, which is the
 cheapest way to prove the write path end to end.
- An abstract BDEF cannot be implemented: `The behavior definition "X" cannot be implemented (kind is "abstract")` —
 the BIMP class is still created (with `FOR BEHAVIOR OF`), so delete it if the model was wrong.
- `UpdateBehaviorDefinition` / `UpdateBehaviorImplementation` behave like every other source write: lock, PUT,
 activate, and **roll back to the previous active version** when the activation reports errors
 (`reverted: true` + the first difference).

### RAP: service binding (`SRVB/SVB`)

Measured on a test system (client 100) in `ZMCP_RAP` with a real transport. The chain is
CDS view entity → service definition → binding → publish.

- `CreateServiceBinding {service_binding_name, service_definition_name, binding_type}` creates,
 writes and activates in one call and then generates the service:
 `{activated: true, binding_type: "ODataV4", transport_check: "passed", generated_info_status: 200,
 generated_service_type: "odatav4", generated_service_name: "ZUI_…_O4", generated_service_version:
 "0001"}`. `binding_type` picks the binding version (`ODataV2` → `V2`, anything else → `V4`).
- **The binding name must end in `_O2` / `_O4`** for a transportable package; a plain
 `ZUI_<desc>` is refused before the call goes out (the naming layer answers why).
- Creating the binding preflights before it posts anything: the service definition must exist
 (`INVALID_ARGUMENT` "Service definition X does not exist" — create the definition first), the
 requested OData version must be in this system's binding types (`ODataV4 is not available on this
 system`, answered with the list it saw), and on a transportable package the CTS check must pass.
 A duplicate name answers `already-exists`.
- `GetServiceBinding` / `ReadServiceBinding` answer the binding document; its
 `srvb:published` (`"false"` / `"true"`) and `srvb:allowedAction` (`PUBLISH` / `UNPUBLISH`) are what
 say whether a publish is still needed.
- `UpdateServiceBinding {service_binding_name, desired_publication_state, service_type,
 service_name}` is **not** a PUT of the document — publishing is a job on
 `/businessservices/odatav4/publishjobs?servicename=…&serviceversion=…`, so a document upload
 answers "the description of <binding> is missing". Pass the generated service name and type
 (`odatav4` / `ODataV4`) that `CreateServiceBinding` reported.
- The publish job answers **HTTP 200 with `<SEVERITY>ERROR</SEVERITY>`** when it is refused; the
 gateway reads the payload and answers `{success: false, publication_state, status, error, detail}`.
 Measured refusal on client 100:
 `Local Publish of ZUI_MCP_T03_O4 failed` / `(Un-)Publishing of SRVB ZUI_MCP_T03_O4 in Customizing
 Client not allowed` — that text is SAP's answer about the **client**, not a gateway defect: a
 Customizing client does not allow (un-)publishing at all.
- `DeleteServiceBinding` unpublishes first and reports what it saw:
 `{success, status, pre_delete: {unpublished, published}, lock_released}`. A binding that was never
 published answers `pre_delete.unpublished: false` and deletes in one step.
- `ListServiceBindingTypes` / `HandlerServiceBindingListTypes` answer the named-item list **parsed**:
 `{count, types: [{name, version, label}], binding_types}` — `label` is the value `binding_type`
 takes (`"ODATA V4"`, `"ODATA V2"`, `"SQL"`, `"INA"`), while `name` alone does not tell V2 from V4
 (that is `version`, 0 / 1 in SAP's list). `response_format: "plain"` adds a `text` block and
 `response_format: "json"` drops `raw_xml`, which only `xml` (the default) keeps.
- `ValidateServiceBinding` / `HandlerServiceBindingValidate` need **both** `service_binding_name` and
 `service_definition_name` and answer two reads, not an ADT validation resource:
 `{success, available, service_definition_exists}` — `available` means "the binding name is free".
 A free name pointing at a missing definition answers `{success: false, available: true,
 service_definition_exists: false, detail_definition: "the service definition does not exist"}`.
- Deleting the service definition and the CDS view afterwards works in that order (binding →
 definition → view), which is the reverse of the create order.

### Text pool: `TextElement` / `WriteTextElementsBulk` / `ReadTextElementsBulk`

Measured through the `ZMCP_ADT_TEXTPOOL` bridge (not ADT — the text pool has no ADT resource).

- `CreateTextElement {program_name, text_type, text}` — `key` is optional in the contract and the tool now
 assigns the next free number (`001`, `002`, …) like SE38 does; before it answered `missing "key"` to a caller
 that sent what the schema asked for. `text_type` is the pool row id: `S` (selection text), `M`, `L`, `H`,
 `R` (program title, keyed by the program itself).
- Every write goes out **active**: the bridge answers `rfc_action: "write_active"` plus the note
 `WRITE_INACTIVE is not supported by this bridge`. There is no draft version to review afterwards.
- `ReadTextElementsBulk {program_name}` answers the whole pool, grouped:
 `{selection_texts, program_title, list_headings, symbols, text_elements, count}`.
 `GetTextElement {program_name, text_type}` answers one type (empty array when the pool has none).
- `WriteTextElementsBulk {text_elements: [{type, key, text}], replace_existing}` merges by default
 (`replace_existing: false` keeps rows it did not receive) and reports
 `{total_entries, total_rows_written, per_type, steps_completed}`.
- `DeleteTextElement` needs `text_type` + `key`; the answer is `{deleted: true, rfc_action: "write_active"}`.
- Argument names differ per verb: `text_type` + `key` on the single-row tools, `text_elements[]` on the bulk
 writer, and `ReadTextElementsBulk` takes only `program_name` + `language`.

### Structure: `GetObjectStructureLow` / `GetObjectStructure` / `GetNodeStructureLow`

- `GetObjectStructureLow {object_type, object_name}` (e.g. `CLAS/OC` / `PROG/P`) answers one level of
 one object **with the category nodes expanded**: `{object, count, truncated, object_types, nodes}`,
 each node carrying `category` / `category_type` (`方法` / `子例程` / `局部类` / `文本元素` …) plus
 SAP's own `type` / `name` / `tech_name` / `uri` / `expandable`. `object_types[].count` says how many
 nodes each category contributed.
- The root read alone is useless: SAP answers `TREE_CONTENT` **empty** for `CLAS/OC CL_SALV_TABLE` and
 `PROG/P ZTEST_WTX3` and only lists the categories. A tool documented as a
 "compact JSON tree" therefore has to drill into every category `node_id` itself — before that it
 returned `count: 0` for the two most common object types.
- `truncated: true` means one page of 500 nodes was reached (a wide class answers thousands of method
 nodes); continue with `GetNodeStructureLow` on one `node_id`.
- `GetNodeStructureLow {parent_type, parent_name, node_id}` is the single-level read, and `node_id`
 must come from a previous answer — `000000` is the root (categories only), a category id
 (`000014` = methods) lists its members. `PROG/I` (includes) is **not** offered as a category on
 this release, which is why `GetIncludesList` falls back to `D010INC`.
- Some nodes carry an empty `name` (SAP's `CLAS/OI` interface placeholders); they are passed through
 as-is rather than dropped, so `count` matches what SE80 shows.

### `GetTransaction`

- Answers `{transaction, type, state, description, kind, program_name, screen_number, parameters?}` per
 name (`transaction_name` or `transaction_names[]`), one object-header read plus **two batched**
 `TSTC` / `TSTCP` reads — not one per transaction.
- `kind` is `parameter` when `TSTCP` holds a `PARAM` for the t-code, `program` when only `TSTC` has the
 entry, `unknown` when neither does. `program_name` / `screen_number` come from `TSTC-PGMNA` / `TSTC-DYPNO`.
- A t-code SAP does not know answers `{success: false, kind: "unknown", error}` for that entry and
 leaves the other entries intact.

### Repository catalogue and source analysis

- `GetAdtTypes {}` answers the ADT **service catalogue**, parsed: `{workspace_count, collection_count,
 workspaces: [{title, collections: [{href, title}]}], note}`. It is not a list of repository type
 codes — the discovery document has none.
- `GetAdtTypes {validate_type}` is the question the tool is usually asked: SAP validates the
 `objectType` filter itself, so an unknown code answers `400 Value XXXX for property TYPE is invalid`
 and the tool answers `{success: false, valid: false, detail}`; a valid one answers
 `{success: true, valid: true}`.
- `GetAbapAST {code, filePath?}` parses source text with `@abaplint/core` (no system contact) and
 returns the statement tree with `from` / `to` positions; `filePath` writes the same JSON to disk.
- `GetAbapSemanticAnalysis {code}` answers `{analysis_level: "parse", symbols, references,
 scope_count, model}`. It reads the class / interface / form model **and** the declarations written
 in the source itself (`DATA` / `CONSTANTS` / `TYPES` / `PARAMETERS` / `SELECT-OPTIONS` /
 `FIELD-SYMBOLS`), which abaplint's model does not carry — Earlier a report with
 `DATA: lv_x TYPE i.` answered `symbol_count: 0`.
- It is **not** a type checker: `lv_x = 'ABC'` is not reported. Use `Check*Low` / activation on a real
 object for the compiler's verdict.
- References are `CALL FUNCTION`, `PERFORM`, `TYPE x` and `sy-*`; `GetAbapSystemSymbols {code}`
 resolves the first two against the system with `SearchObject`, so a `PERFORM missing_form` shows up
 as `resolved: false`.

### Smart Forms (RFC bridge)

SAP has no ADT resource for Smart Forms; all five tools run through `ZMCP_SSF_*` in
`ZMCP_SSF_UTILS`).

- Only `Z*` / `Y*` names are accepted; a standard form (`/BEV4/PL_SENDER`) is refused with
 `"/BEV4/PL_SENDER" is not a Z*/Y* SmartForm name`.
- `GetSmartFormLayout {form_name}` → `{form_name, language, active, page_formats: [{format, cpi, lpi,
 style}], pages: [{name, caption, orientation, next_page, numbering, windows: [{name, type, type_text,
 caption, top/left/width/height: {value, unit, mm}}]}]}`. Sizes come back in the unit SAP stored
 (CM / PT / IN) **and** in mm, so a preview can place a window without converting.
- `GetSmartFormContent {form_name, summary?, include_styles?, include_texts?, include_graphics?}`
 reads the Form Builder XML once and derives `node_counts` (`RC` root, `SE` screen/window, `CM`
 command, `CO` condition, `TI` table, `TX` text …), the styles as CSS, and the include texts.
 **The full result is written to `smartforms/<FORM>/<FORM>.content.json`** and the Form Builder XML
 to `<FORM>.form.xml`; the answer carries `files: {content, xml}`. `summary: true` answers the
 overview instead of the content tree: `windows` (`{page, name, caption, type, top_mm, height_mm}`),
 `symbols` (every `&SYMBOL&` the form uses, upper-cased, in source order) and the same `files`.
- SE78 graphics are **not** exported by the bridge: the answer says so
 (`graphics: {fetched: false, reason: …}`) and leaves the graphic keys in the node fields.
- A form that does not exist answers `not-found` (`SmartForm X does not exist`), and a form that was
 never activated answers `UPSTREAM_FAILED` with "has no active version" — the bridge reads the
 active version only, so activate in SMARTFORMS first.
- `CreateSmartForm {form_name, xml_file, overwrite?, activate?}` needs a **real**
 `SMARTFORMS > Utilities > Download` XML. A hand-written skeleton (namespace right, HEADER right)
 makes the upload bridge raise `Access using a 'ZERO' object reference is not possible.` and leaves
 a dump in the target system — copy an export, do not type one. The bridge writes `$…` packages
 only, so `package_name` / `transport_request` for a transportable package are refused before the
 call goes out.
- The donor copy is one call away: `GetSmartFormContent` already writes the real XML to
 `<FORM>.form.xml`, and that file can be handed straight to `CreateSmartForm` under a **new** name
 — the bridge takes `form_name` separately and rewrites the form name inside the XML. This
 is the cheap way to get a test form: read any existing form, copy it, delete the copy.
- `RenderSmartForm {form_name, values, device?, families?, language?}` runs the generated function
 module with `GETOTF` (no dialog, no print, no spool) and writes
 `smartforms/<FORM>/<FORM>.sap.otf.txt` + `.sap.pdf`, answering `files: {otf, pdf?}`. The form's
 own program lines run as in a real print and may read the database — pass invented sample values.
- `DeleteSmartForm {form_name, confirm}` is a **dry run until `confirm: true`**: the answer carries
 `dry_run`, `deleted`, `generated_fm` and `tadir_left` (the TADIR row the form leaves behind when
 only the generated module could be removed). After a real delete the bridge answers `not-found`
 for that form — that read is the proof the delete landed.

### Type information and browsing: `GetTypeInfo` / `GetVirtualFoldersLow` / `DescribeByList`

- `GetTypeInfo {type_name, include_structure_fallback?}` resolves one name through four steps and
 says which one answered: `kind: data_element` (`/ddic/dataelements`, with the four labels),
 `domain` (`/ddic/domains` + `DD07L` fixed values), `structure` / `table` (the structures endpoint
 gives only the header, so the **fields come from `DD03L`**: `{name, position, data_element, type,
 length, decimals, key}`), `table_type` (`DD40L` row type + kind), else `kind: "unknown"` with a
 `detail`. Measured: `BAPIRET2` used to answer `count: 0, fields: []` plus the raw
 `blueSource` header.
- Structure or table is decided by `DD02L-TABCLASS` (`INTTAB` = structure, anything else = table) and
 reported as `table_class`, because the structures endpoint says `TABL/DS` for a transparent table
 too. `T000` → `{kind: "table", table_class: "TRANSP", count: 17}` with `MANDT` `key: true`.
- A table type has no structure resource: the 404 there must not abort the lookup, and `BAPIRET2_T`
 answers `{kind: "table_type", row_type: "BAPIRET2", row_kind: "STRU"}`.
- A domain answers `{kind: "domain", description, data_type, length, decimals, lowercase, sign_exists,
 conversion_exit?, value_table?, fixed_values: [{low, high?, text}]}` — read from the domain document
 (`<doma:datatype>`, not `dataType`; the fixed values carry their text) with `DD07L` as the fallback
 when the document has no value range. Measured on a `$TMP` probe domain.
- `include_structure_fallback: false` keeps the strict behaviour: only the data-element lookup runs,
 and its error is raised.
- `GetVirtualFoldersLow {object_search_pattern, facet_order?, preselection?}` groups matching objects
 by package / type (`{folders: [{name, display_name, facet, uri, counter, has_children}],
 object_count}`). `preselection` is **ignored on this stack** (the request schema has no
 preselection element and answers HTTP 400); the answer lists what was ignored and says to narrow
 the pattern instead.
- `DescribeByList {objects: [{name, type?}]}` answers `{count, objects[{name, type, package_name,
 description, uri}], missing[]}`. `success: false` means at least one name was not found; the
 entries that were found keep their data. A `TRAN/T` name answers its package without a description.

### Enhancements: `GetEnhancements` / `GetEnhancementSpot` / `GetEnhancementImpl`

Measured on a test system (client 100).

- `GetEnhancements {object_name, object_type}` answers what SAP lists for that source:
 `{count, enhancements: [{name, type, version, enhanced_object: {name, type, uri}, switch: {state, name},
 element_count, elements: [{id, full_name, mode, replacing, row, column, object_row, object_column,
 source_chars, first_line}]}]}`. The code inside `<enh:source>` is **base64** and is decoded here;
 `row`/`column` is the line inside the enhancement, `object_row`/`object_column` the line in the
 enhanced object (the two differ: `#start=1,0` vs `#start=89,0`). An object without enhancements
 answers `count: 0` plus a note. Measured on `SAPMV45A`: four implementations, each one source-code
 plugin (e.g. `FSH_DET_PROCESS` / `ENHO/XHH`).
- `GetEnhancementSpot {enhancement_spot}` resolves the BAdI collection first (`enhsxsb`) and falls back
 to the plain spot collection (`enhsxs`, `v1` media) — discovery lists both and they accept different
 media types. Answer: `{name, type, description, responsible, version, package_name, tool_type,
 usage_count, usages[], badi_definition_count, badi_definitions: [{name, shorttext, single_use,
 fallback_class, interface, interface_type}]}`.
- Some spots cannot be read through ADT at all: `ES_RMMD07NEW`, `ES_RM06IBI0`,
 `ES_MM06EFIN_INFO_LESEN_RFQ_NEW` answer SAP's `I::000` on **both** collections and every media type,
 while `ES_BADI_ME_PIC_DFPS_SPECIAL` and `CIF_CCR_STOCK` answer normally. That is SAP's answer for
 those spots, not a route problem.
- `GetEnhancementImpl {enhancement_spot, enhancement_name}` reads `/enhancements/{spot}/{name}/source/main`
 and answers `{spot, name, line_count, source_code}`. For a source-code plugin the `spot` is the
 **type alias** `enhoxhh`, not an enhancement spot name — measured:
 `{enhancement_spot: "enhoxhh", enhancement_name: "FSH_DET_PROCESS"}` → 28 lines.
- A name that does not exist answers `not-found` (the route layer keeps the ADT classification; it
 used to answer `UPSTREAM_FAILED` for every 404).

## Measured traps
Each row was reproduced on a live S/4 system (logon language ZH) while
creating and deleting probe objects in `$TMP`. They are the answers SAP gives, not gateway
policy.

| Symptom | Cause | Do this |
|---|---|---|
| `UpdateTable` / `UpdateStructure`: `Can't save due to errors in source; execute check for details` | `@AbapCatalog.enhancement.category: #NOT_EXTENSIBLE` is required in the DDL — SAP's own generated skeleton has it, a hand-written table does not | start from the read-back source of the object you just created, or add the annotation |
| `CheckTableLow` (any DDL family) answers `errors: 0` for text you passed | a checkrun only sees a **stored** version; the payload argument is not read | the call now answers `INVALID_ARGUMENT`. Write first (lock → `Update…Low` → unlock), then check, or use `Update…` which checks before writing |
| `Update…` answers `activated: false` with a mismatch on a line you did not change | SAP re-formats DDL on save (it aligns the colons); the comparison ignored blank lines only | fixed: the loose comparison now also ignores inner whitespace and keyword case, and still compares string literals exactly |
| `CreateCdsView`: `SQL view name X and DDL view name X cannot be identical` | `@AbapCatalog.sqlViewName` was built from the view name | give the SQL view name its own prefix |
| CDS check: `NUMBER 是保留字；请选择其他字` | the alias was a reserved word | rename the alias (`number` → `message_number`) |
| Metadata extension: `Annotation 'Metadata.allowExtensions' missing` | the annotated view does not allow extensions | add `@Metadata.allowExtensions: true` to the view |
| `DeleteInclude`: `其它程序中已索引了程序 X` (403) | `CreateInclude` inserts `INCLUDE X.` into the parent, so the parent still names it | fixed: `DeleteInclude` now removes the `INCLUDE` line and re-activates the parent itself (`pre_delete.removed_from_main`); no manual parent edit needed |
| Reading a deleted object answered 500 and left a short dump (`CX_OO_CLIF_NOT_EXISTS`, `CL_OO_CLIF_SOURCE`) | the source of an object that no longer exists makes SAP's workbench resource raise an uncaught exception | fixed: a read now asks for the object document first and answers `not-found` without touching the source |
| `CreateScreen` answers `DYNPRO_DATA is required`, `ReadScreen` answers `RPY_DYNPRO_READ failed` | ADT has no screen resource; the bridge inserts a whole dynpro, so an empty screen cannot be created and a missing one cannot be read | read an existing screen from another program first and pass its `dynpro_data` |
| `CreateGuiStatus` answers `SAPLKKBL has no status STANDARD_FULLSCREEN` | the tool copies its first status from a reference program, and the CUA document the bridge reads for that program is **empty** even though `GetGuiStatusList` lists 40 statuses for it | create the first status from a Z program the bridge can read, or write the whole CUA with `UpdateGuiStatus`; the tool now names every candidate it tried |
| `CreatePackage` needs a transportable super package | `$TMP` cannot own sub-packages, and the element that decides is `transport_layer`: with an empty one SAP answers the misleading `409 … is not a local request` | read the super package (`GetPackage`) and pass its `pak:transportLayer` (e.g. `ZDEV`) and `pak:softwareComponent` (e.g. `HOME`) next to the request |
| `UpdatePackageLow` answers `409 … already locked in request X` | the object sits in the request the **lock** named (`lock_handle`'s `transport_request`), not in the one passed to the update | pass `transport_request` = the lock's `transport_request` |
| `WriteTextElementsBulk` answers `success` but `ReadTextElementsBulk` lists nothing | the bridge writes and reads with different language handling (`language: null` on write, "bridge default" on read) | write and read with the same explicit `language`; if the pool stays empty, report it — a silent text-pool write is a defect, not a usage problem |
| A run that creates and activates many objects leaves `E_ABAP_GENPH` enqueues in SM12 | SAP's generation enqueue (`E_ABAP_GENPH`) belongs to the **generation task and its ABAP session**, not to the object: activation takes it, `UNLOCK` does not release it, and it is exclusive — a standing one rejects later activations **even from the same user** | create+activate once and keep the object (a reused object is not regenerated); do not delete in the same breath; after a run, a leftover one ages out (measured elsewhere: 15–60 minutes) or is deleted in SM12. abapGit's CI filters it out of its lock check entirely — treat it as noise, not as contention |

## Driving the lock yourself

The `*Low` tools map one tool call to one ADT request, so you own the lock:

```text
LockProgram → lock_handle
UpdateProgramLow (lock_handle, source_code) // no activate
UnlockProgram (lock_handle)
ActivateObjects (name + type)
```

- A lock handle is valid only in the session that created it. This gateway keeps one session per system, so consecutive calls land in the same ABAP session.
- Always release it. An object left locked answers every later lock request with 400. The high-level write tools release the lock for you.
- Do not mix a `*Low` lock with a high-level write on the same object; the high-level tool takes its own lock.
- A handle that is truly lost can only be cleared by SAP session timeout or in SM12.

Prefer the high-level tools (`UpdateProgram`, `DeleteClass`, …): they lock, write and unlock in one call.

### When a lock becomes an orphan

Every lock was asked for by someone; SAP does not produce them on its own. What decides whether it
goes away is **how the owning session ends**:

| The session ends … | Object lock (`RSDEO`, `ENQUEUE_*`, …) |
|---|---|
| with `Unlock*` in the same session | released |
| with a normal logoff | released |
| because the process was killed (editor reload, `Ctrl-C`, crash) | **stays**, and no later session can release it |

An orphan is recognisable: `Lock*` answers `403 使用者 <user> 当前编辑 <object>` and an `Unlock*` with
the old handle answers `success: true` while the object stays locked. Only SM12 can clear it.

So the rule that keeps SM12 empty is about *when* locks are taken, not about cleaning up afterwards:

- use the high-level write verbs when you can — they take and release the lock inside one call;
- with the low-level pair, finish `Lock* → Update*Low → Unlock*` in one uninterrupted sequence;
- before stopping the server process, make sure no `Lock*` is outstanding;
- close the object's editor tab before writing — a tab is a session of its own and holds the same
 kind of lock;
- `E_ABAP_GENPH` is the exception: it belongs to the generation and clears itself.

## Activation

```jsonc
{ "tool": "ActivateObjects", "arguments": { "objects": [ { "name": "ZDEMO_REPORT", "type": "PROG/P" } ] } }
```

- `objects` needs `type` (`PROG/P`, `PROG/I`, `CLAS/OC`, `TABL/DT`, `DDLS/DF`, …). A name alone fails, because there is no URI to resolve.
- Objects that reference each other must be activated in one batch, otherwise the first one fails to compile.
- `activated: true` means the active version equals the source just written. `REPOSRC.R3STATE = 'A'` only proves there is no leftover draft — the active version could still be older content, so it is supporting evidence, not proof.
- A successful activation answers either an empty body or the platform's own empty report (`<chkl:messages>` carrying only `<chkl:properties>`). Neither is a failure, and neither proves the code went live — the read-back does.
- `activated: false` with `unrecognized` set means the answer was in a shape the gateway could not read. It is **not** a code error and not a reason to resend: report `status` (it names the root element) instead of retrying.
- An include (`PROG/I`) can be activated on its own, but its real compilation evidence comes from the main program.

## Checks and unit tests

```jsonc
{ "tool": "CheckProgramLow", "arguments": { "program_name": "ZDEMO_REPORT" } }
{ "tool": "RunUnitTest", "arguments": {
 "container_class": "ZCL_DEMO_REPORT",
 "tests": [ { "container_class": "ZCL_DEMO_REPORT", "test_class": "LTC_DEMO_REPORT", "methods": [ "test_GET" ] } ],
 "duration": { "risks": [ "medium" ], "durations": [ "short" ] } } }
```

- Read `executed` and `errors`, not the wording of `success`. `executed: false` means nothing was checked (`status: notProcessed`) — it is not a pass.
- A check that answers a document the gateway cannot read raises `unrecognized-response` instead of returning `errors: 0`. Treat it as *not checked*: the body never reached a verdict.
- Unit test outcomes are in `run_result` (`Total` / `Passed` / `Failed`), not in the status line.
- CDS syntax checks are not available on every release (`0 analyzed`); activation is the compile step there.

Which check actually validates something:

| Tool | Behaviour | Can it be a gate? |
|---|---|---|
| `CheckProgramLow`, `CheckClassLow`, `CheckTableLow`, `CheckStructureLow`, `CheckDomainLow`, `CheckDataElementLow` | `status: processed`, `executed: true`, real messages with line links; the DDIC ones read the **active** version unless you pass source | yes—judge on `executed` and `errors`, never on the wording of `success` |
| `CheckFunctionGroupLow` | filters the false "program type is INCLUDE" message it would otherwise get for the group's main program | yes |
| `CheckProgramLow` on an include (`PROG/I`) | always answers "The REPORT/PROGRAM statement is missing, or the program type is INCLUDE"—neither an error nor a pass | not applicable: the compile evidence is the main program, because activating it compiles the include |
| `CheckCdsViewLow` | only for CDS with a DDL source; a classic view (`VIEW/DV`) answers `executed: false` with "DDL Source does not exist" | yes for CDS; use activation or ATC for classic views |
| `CheckTableLow` / `CheckStructureLow` with `ddl_code` | **does not validate that source**: answers `executed: true`, `errors: 0`, "Object has been checked", while the same source sent to `Update*` fails with `Can't save due to errors in source` | no—the write is the gate for tables and structures; `CheckCdsViewLow` with `ddl_source` is the one that does read the source it is given |
| `CheckFunctionModuleLow` | warnings can point into `functions/groups/svim/includes/…` (table maintenance) | read the `href`: a message about someone else's object is not your error |
| the write tools themselves (`Update*` with `check_new_code`) | source with a syntax error is not stored at all | yes—so "a no-op check lets bad code through" only applies to the check tools, not to the write path |

Two return values mislead on their own: `executed: false` carries `status: notProcessed` and no errors
(it means *not checked*, not *clean*), and on gateways from before the check fix the DDIC checks answer
`notProcessed` with `has_errors: true` for active objects—on such a build do not use them as a gate.

## Transport requests

```jsonc
{ "tool": "ListTransports", "arguments": { "modifiable_only": true } }
{ "tool": "GetTransport", "arguments": { "transport_number": "DEVK900123" } }
{ "tool": "CreateTransport", "arguments": { "description": "MM vendor interface R001 20261104" } }
```

- When an object is already recorded in an unreleased request, the change belongs to that request; pass its number on the write call.
- Create a request only when one is actually needed. **The description must be ASCII**: non-ASCII characters are stored as `#`.
- `CreateTransport` does not return a request number in a dedicated field; it is the last segment of the returned `uri`. Confirm with `GetTransport`.
- `GetTransport {transport_number, owner?, include_objects?, include_tasks?}` answers **parsed**:
 `{header: {number, owner, description, type, status, status_text, target, parent, source_client,
 changed_at, uri}, task_count, tasks[], object_count, objects[]}`. Each object carries
 `{pgmid, type, name, wbtype, object_name, info, position, locked}`.
 Earlier it answered `{transport_number, raw_xml}` — 123 KB of document for a request with
 110 objects, with `include_objects` / `include_tasks` ignored.
- A **task** of the request appears in the same document (`parent` = the request number) and in
 `ListTransports` as its own row, so the same work can look like two requests. Check `parent`.
- `CreateTransport {description, target_system}` needs the **target** (user ruling ): SAP stores
 `TARSYSTEM` as given and a request without one is unusable for the landscape. `CreateTransportLow` has
 no target in its contract, so it writes `tm:target="LOCAL"` — the same request without a transport
 route. `HandlerTransportCreate` forwards to `CreateTransport`.
- **A `201` with a number is not proof that the request is still there.** Measured on a
 test system (client 100): creations answered `{success: true, transport_number: "<sid>K900500"}` and read back `404`
 minutes later — because those probe requests had been **deleted in SE09**, not because SAP failed
 to write them (a creation whose object was recorded at once, `<sid>K900513` + its task, stayed
 readable). The answer therefore carries `verified`, a snapshot of "readable right now": when it is
 `false` the call still reports `success: true` and adds a `note` naming SE09, so a deleted request is
 not mistaken for a failed creation. Confirm the number with `GetTransport` before recording objects
 into it.
- `modifiable_only: true` does not tell you whether a usable request exists — check `status_text` from `GetTransport`, or `E070-TRSTATUS` directly.
- `GetInactiveObjects {}` lists what is modified but not activated (`{count, objects: [{name, type, uri}]}`)
 — the fastest way to see whether a write left a draft behind.

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
- `GetTableContents {table_name, max_rows, fields, include_metadata}` is the SE16-style read: `fields`
 filters the returned columns, rows drop empty cells, and `column_metadata` carries
 `{name, type, description, length, key}`. **`key` is not usable as a key flag on this stack**: the
 DDIC preview sends `keyAttribute="false"` for every column, including the client key of `T000`. Read DD03L (`KEYFLAG`) when keys matter.
- `IN (...)` works in the freestyle preview, which is how one call answers many keys — e.g.
 `SELECT TCODE, PGMNA, DYPNO FROM TSTC WHERE TCODE IN ('SE38','SM30')`.

## Working efficiently

Every row below cost a real session. None of them is a tool defect — the tool did what it was
asked; the waste came from how it was driven. They are ordered by how much time they cost.

| Trap | What it cost | Do this instead |
|---|---|---|
| Searching the disk for the server or its config | Three recursive scans of a workspace root: 465 s in one round, 40% of its active time — and the answer was one call away | Ask the server: `GatewayListSystems`, then `GatewayListTools` |
| Typing a large source into `source_code` | A 1,832-line report typed four times; one write answered `success` and silently lost 389 lines | `source_file` + `expected_line_count`; `patch` for a few lines |
| Guessing argument names | 9 of 17 failed calls in one session were guessed parameter or column names | `GatewayListTools({ tool, detail: "schema" })` before the first call |
| Inferring the requirement from repository contents | Two sessions spent scanning for a specification that did not exist | Ask once, with options and what each one costs |
| Treating `success: true` as "done" | Draft written, active version unchanged; the caller moved on | Read the active version back and diff it — every response carries `line_count` / `sha256` / `mismatch` |
| Judging a change on another client | An empty result on the QA client was read as "the change failed" | Judge on the system you changed; use the other one for comparison only |
| Reading "object is locked" as a tool bug | Retry loops, then SM12 | Almost always an open editor tab holding the enqueue — close it first |
| Judging a never-activated object by its inactive version | `REPORT/PROGRAM statement is missing` on code that compiles | Check the active version; an empty inactive version says nothing about the object |
| Using Data Preview as a database client | 400s that look like SQL bugs, plus a 500 from a wide aggregate | One plain `SELECT`: no JOIN, no subquery, no `LIKE`, no `MANDT` on client-dependent tables, no expressions, at most ~6 aggregates, short `IN` / `OR` lists |
| Writing a language key as `ZH` | `not a valid value for C(1,0)` | `SPRAS` / `DDLANGUAGE` are one character; Chinese is `1` on these systems |
| Waiting for a transportable object's `TADIR` row to vanish | It never does — the object is gone and the row remains | Check `DELFLAG = 'X'` for transportable objects; only `$TMP` rows disappear |
| A Chinese transport description | SE09 shows `#` — the bridge cannot carry it | ASCII only; verify with a read-back of `E070-AS4TEXT` |
| Probing in a real package | Objects that need a transport and cannot be cleaned up | Probe in `$TMP`, and delete the probe when done |
| Retrying after an unrecognised answer | The same answer twice, then a wrong diagnosis of a code problem | `unrecognized-response` / `unrecognized` means the answer shape changed — report it, do not resend |

## Error codes

The first block comes from the gateway itself, the second from the ADT layer. A **route-backed** tool
keeps the ADT classification too: a 404 is `not-found`, an existing name is `already-exists`, a lock
conflict is `invalid-lock` — upstream code only appears for an answer the ADT layer could not classify.

| `code` | Meaning | Next step |
|---|---|---|
| `SYSTEM_UNKNOWN` | No `system` sent, unknown id, or nothing configured | Check `details.systems` |
| `SYSTEM_READ_ONLY` | Target tier is not `dev` | Point the call at a development system |
| `INVALID_ARGUMENT` | Missing or mistyped argument | Follow `message`; get the real names with `GatewayListTools(detail: "schema")` |
| `UNKNOWN_TOOL` | Name not in the contract | See [TOOLS.md](./TOOLS.md) |
| `TOOL_NOT_ALLOWED` / `TOOL_HIDDEN` | The chosen exposure level hides this tool | Raise `toolPolicy.expose`, or call it through `GatewayCallTool` |
| `NOT_IMPLEMENTED` | In the contract, not in this build (`--coverage` should read 335/335) | Report a defect |
| `UPSTREAM_FAILED` | The gateway gave up on SAP's answer | Read `message` and `details` |
| `CONFIG_INVALID` | The configuration file does not load | See [CONFIGURATION.md](./CONFIGURATION.md) |
| `CONTENT_MISMATCH` | The payload did not match `expected_line_count` / `expected_sha256` / `patch.expected_count`. **Nothing was written** | Re-read the active source and rebuild the payload |
| `auth` | 401, failed logon, or an expired session that failed after one replay | Check credentials and the user in `SU01` |
| `session-expired` | The stateful session was gone; the call is replayed once automatically | If it still fails, check the credentials |
| `locked` | The object is locked by another session, or by a handle you did not release | Close the editor tab, inspect SM12, check for a second gateway process |
| `invalid-lock` | The handle does not belong to this session | Lock again |
| `not-found` | No such object, or the name/type pair does not match | Confirm with `SearchObject`; names are uppercase |
| `transport-required` | Transportable package without `transport_request` | Pass the request number |
| `content-negotiation` | ADT rejects the declared `Accept` | The session retries once with `*/*`; if it still fails the resource is genuinely unavailable |
| `unrecognized-response` | SAP answered a document this gateway cannot read, and the result would otherwise have looked clean | **Not a code error.** Report the raw text; do not resend the same call |
| `check-failed` / `upstream` | SAP rejected the request; `sapText` holds its text | Fix the request, do not retry blindly |
| `network` | Unreachable, TLS failure, timeout | Check the network path and certificate |

SAP answers in the logon language, so `sapText` may be Chinese or English; the gateway
matches both when it classifies. When it cannot classify, it still hands the text back — read
`sapText` before assuming the request was wrong.

## Looks successful, is not

| Symptom | What is really going on |
|---|---|
| `success: true` with `source_code: null` | The object does not exist. Use `SearchObject` to decide existence |
| Activation reported, source unchanged | Only a draft was written. Read `version: "active"` and compare |
| A write returned without error but nothing changed | No `transport_request` on a transportable object; check the returned `code` |
| A check reports `errors: 0` | Look at `executed` first — `false` means nothing was checked |
| A check raises `unrecognized-response` | The answer was not a check report at all. Nothing was checked, and `sapText` holds what SAP actually sent |
| Activation answers `ok: false` with `unrecognized` | The report shape changed. Read `status` (it names the root element); retrying the same call will produce the same answer |
| A unit test "passed" | Read the counters in `run_result`, not the status line |
| Text elements were written but cannot be read | Read and write used different `language` values |
| The preview returned only a few rows | `totalRows` is paged; count with `COUNT(*)` |


### Text elements (RFC bridge)

- `CreateTextElement` on a fresh program answers `text element R/ already exists` — the program title row (`R`) is always there, so use `UpdateTextElement` for it. That refusal names the tool to use (`nextAction: use UpdateTextElement`).
- `UpdateTextElement` / `DeleteTextElement` answer `{transport: "rfc", rfc_action: "write_active", note: "WRITE_INACTIVE is not supported by this bridge; the rows were written active."}` — the pool is written **active**, not staged.
- `WriteTextElementsBulk {text_elements: [{type, key?, text}], activate, replace_existing}` is one TPOOL write: `{total_entries, total_rows_written, per_type: {R,S,I,H}}`. `R` ignores `key`, `I` needs a key, `S` needs a parameter name, `H` needs `listHeader` / `columnHeader_N`.
- `GetTextElement` / `ReadTextElementsBulk` answer the whole pool grouped by kind
 (`program_title`, `text_elements`, `selection_texts`, `symbols`, `list_headings`) plus a flat
 `text_elements` list and `count`; `language` reads `(bridge default)` when the caller did not pass one.

### Screens (RFC bridge)

- `CreateScreen {program_name, screen_number, description, activate}` → `{steps: [{action: "DYNPRO_INSERT", subrc: 0}], result: {created: true}}`.
 A minimal screen is a real dynpro: it comes back with `HEADER` (21×83, `NEXTSCREEN` = itself),
 one `SCREEN` container, an `OKCODE` field and `PROCESS BEFORE OUTPUT.` / `PROCESS AFTER INPUT.`.
- `GetScreensList {program_name}` reads `D020S` (`count`, `screens`); `GetScreen {program_name, screen_number}`
 returns the full definition (`HEADER`, `CONTAINERS`, `FIELDS_TO_CONTAINERS`, `FLOW_LOGIC`).
- `DeleteScreen` → `{steps: [{action: "DYNPRO_DELETE", subrc: 0}], result: {deleted: true}}`.
- `UpdateScreen` and `UpdateScreenLow` are both **DELETE + INSERT** and really update an active dynpro. What is
 refused is an **empty** payload: `dynpro_data: "{}"` answers
 `RPY_DYNPRO_INSERT failed (sy-subrc=5)`. Send what `GetScreen` returned (`result` is exactly the
 shape `dynpro_data` wants), changed where needed.

### GUI status (CUA, RFC bridge)

- `GetGuiStatusList {program_name}` → `{count, statuses: [{code, type, description}]}`; a program without a
 CUA answers `count: 0` plus "CreateGuiStatus can create the first one", not an error.
- `CreateGuiStatus {program_name, status_name, description, status_type, activate}` **copies**
 `SAPLKKBL/STANDARD_FULLSCREEN` and narrows it to the one status (user ruling: a status built from
 nothing has no back/exit/print/help). Measured: `{copied_from, statuses: 1, set_rows: 118,
 function_codes: 137, activated: true}`. A program that already has CUA rows is refused
 (`already has a GUI status definition` → use Update/Patch).
- `ReadGuiStatus {program_name}` is the **whole** document (141 KB for one status — every FUN/MEN/MTX/ACT
 row). Use `GetGuiStatus {status_name, function_codes, format: "compact"}` to narrow: compact gives one
 line per function with `code / text / linked / fkey / toolbar`.
- `GetGuiStatus` compact lists a status's functions from `SET`, plus **any `function_codes` the caller
 asked for** with `linked: false` — a code that exists in `FUN` but is not yet assigned to the status
 would otherwise read as "not written".
- `PatchGuiStatus {changes}` merges rows by natural key (`STA=CODE`, `FUN=CODE`, `PFK=CODE+PFNO`,
 `BUT=PFK_CODE+CODE+NO`, `SET=STATUS+FUNCTION`, …) and answers `{patched: ["<TABLE>"], activated: true,
 note: "CUA_WRITE has no inactive stage: the merged rows are written active."}`.
- `DeleteGuiStatus {program_name, status_name}` → `{deleted: true}`.
