# Choosing a tool

The tool list says what exists. This document says which one answers your question, and which
SAP behaviour changes the call you have to make. Read it once; come back when a call answers
something other than what you expected.

Everything here is about the gateway and the system it talks to. Nothing here depends on a
particular client, project or naming convention.

## Three layers of capability

The question is never "is there a tool", it is "does this channel work on this system". Check the
contract first, then the system.

| Layer | Meaning | What to do |
|---|---|---|
| A — the contract has a tool | call it directly; arguments come from `docs/TOOLS.md` or the schema | normal path |
| B — ADT has the endpoint, the contract does not wrap it | call the endpoint yourself over HTTPS with the same credentials | see [USAGE.md](USAGE.md) for the request shapes; the endpoint list is whatever `/sap/bc/adt/discovery` returns |
| C — the system does not have it | no channel; say so and name the manual step | do not write a workaround program |

A capability that is missing from the tool list is not necessarily missing from the system, and a
capability that exists in the system is not necessarily reachable at the tier you are connected to.
Both of those have bitten people who assumed.

## Calling ADT yourself (layer B)

Use the same credentials as the configuration: the system's `url`, its `client`, and its `auth`.
No second connection is needed. Every path below is relative to `/sap/bc/adt/`, and `Accept`
defaults to `application/xml`.

Three rules that save the most time:

- Object names in the path are lower case: `programs/programs/<lowercase>/source/main` with
 `Accept: text/plain`.
- Do not copy `Accept` from discovery. When an endpoint answers `406`, read the response body's
 `Accepted content types:` and retry with one of those. If that list is empty (a function group
 asked for `application/xml` does this), `Accept: */*` answers `200`.
- Writes need a CSRF token: `GET discovery` with `x-csrf-token: fetch` and
 `Accept: application/atomsvc+xml`, then send the returned `x-csrf-token` together with the
 `set-cookie` value on every `POST`, plus your own `Content-Type`.

| You want | Request | Read in the answer |
|---|---|---|
| which endpoints exist | `GET discovery`, `Accept: application/atomsvc+xml` | each `app:collection`'s `href`, title and `app:accept`. The endpoint list is authoritative here, not the release number |
| find an object by name | `GET repository/informationsystem/search?operation=quickSearch&query=<pattern>&maxResults=<n>` | `adtcore:objectReference`: `name`, `type`, `uri` |
| inactive objects | `GET activation/inactiveobjects` | name, type, last-changed-by |
| run ATC | `GET atc/variants`, then `POST atc/worklists?checkVariant=<variant>` (empty body) and take `worklistId` from `Location`—a non-200 can still carry it, so continue whenever `Location` is present; then `POST atc/runs?worklistId=<id>` with an `atc:run` body carrying `objectSets` / `objectSet kind="inclusive"` / `adtcore:objectReference` (`adtcore:uri`, `adtcore:type` such as `PROG/P`, `adtcore:name`) | `GET atc/results?worklistId=<id>&createdBy=<user>` gives `displayId` and the counts; `GET atc/results/<displayId>` gives one `atcfinding:finding` per finding, whose attributes are the conclusion: `priority`, `messageId` + `messageTitle`, `checkTitle`, `location` (`…#start=<line>,<column>`). No per-finding document fetch is needed |
| transport requests | `GET cts/transportrequests`, `Accept: application/vnd.sap.adt.transportorganizertree.v1+xml` | number, description, object list. A just-created empty request may not be listed—confirm a number with `GET cts/transportrequests/<number>` instead of concluding it does not exist |
| release a request | first the task: `POST cts/transportrequests/<task>/newreleasejobs`, then the same call for the request number | `chkrun:status`: `released` on success; on `abortrelapifail` read `chkrun:shortText` (usually "task … is not released yet", i.e. the first step was skipped). Releasing is asynchronous: `TADIR` rows disappear only after the job runs |
| trace list, unit metadata | `runtime/traces/abaptraces/requests` (`application/atom+xml;type=feed`) · `abapunit/metadata` (`application/vnd.sap.adt.abapunit.metadata.result.v1+xml`) | the feed, or the metadata document |

Diagnosing a refused direct call: `401` / `403` credentials or authorization · `404` endpoint or
object does not exist (the text tells you which) · `405` wrong method · `406` wrong `Accept` (first
rule above) · `400` carrying `Parameter X could not be found` means a required parameter is missing.
Do not put `?sap-client=` on a CTS path: it becomes part of the request name and SAP answers that
the request `-client=400` does not exist. The client comes from the session.

## Choosing a tool

| You want | Use | Look at |
|---|---|---|
| whether an object is standard or custom | `GetObjectStructure` / object read | `System Type`: `STANDARD` or `CUSTOM` |
| an object's source or exact signature | `GetProgram`, `GetClass`, `GetInterface`, `GetCdsView` | read the signature before you write a call against it |
| a class's local members (types, macros, test class) | `GetLocal*` | these are separate from the class source; they have their own update tools |
| a program including its includes | `GetProgFullCode` | one call, whole program |
| a standard function module's parameters | `GetFunctionModule` plus data preview on `DD40L` | parameter names never guessed; `TFDIR` tells you whether the module exists at all |
| how some API is used on this system | `SearchSource` | two or three real call sites beat any documentation, including this one |
| which table or entity a name is | data preview on `DD02L`, `TADIR`, `DDDDLSRC` | see the note on `DD02L` below |
| a table's keys, field types, foreign keys | data preview on `DD03L`, `DD04L`, `DD07L`, `DD05S`, `DD08L` | keys and lengths are metadata; do not copy them from anywhere |
| whether data is right | data preview, table by table | the only channel that catches "compiles, passes checks, wrong result" |
| who uses an object | `GetWhereUsed` | zero rows does not mean nobody uses it, see below |
| what is in a package or function group | `GetObjectStructure` | better than the flat list tools |
| every object of one type | `GetObjectsByType`, in two steps | see the note below |
| a check result or ATC findings | `Check*Low`, `ValidateProgramLow`; ATC over HTTPS | see the note on checks below |
| a unit test run | `RunUnitTest` | `run_result`, not the status line |
| activation state | `GetInactiveObjects`, `ActivateObjects` | the response field is the start of the evidence, not the end |
| a dump | `RuntimeListDumps`, `RuntimeGetDumpById`, `RuntimeAnalyzeDump` | list first, then fetch the one you want |
| a transport request | `ListTransports`, `GetTransport`, `CreateTransport` | three checks before you ask for a new one—see [WORKFLOW.md](WORKFLOW.md) |
| text pool, screens, GUI status | text element tools, `ReadScreen` / `UpdateScreen`, `GetGuiStatus` / `UpdateGuiStatus` | whole-file replace for screens and statuses |
| the package an object lives in, its transport layer | `GetPackage` | read it off an existing sibling package; do not guess |

## SAP behaviour that changes the call

These are properties of SAP, not of the gateway. Each one has made a correct-looking call answer
something wrong.

**`GetObjectsByType` takes a node id, not zero.** Ask `GetNodeStructureLow` for the type list first
and use the `NODE_ID` of the type you want. Passing the root id answers zero rows, which looks like
"no such objects".

**`DD02L` does not contain CDS entities.** A view name missing from `DD02L` is not proof that the name
does not exist. Look in `TADIR` (`OBJECT = 'DDLS'`) or `DDDDLSRC`.

**Data preview is a data preview, not a database client.** The endpoint filters by the client of the
logged-on session, so `MANDT` is not selectable—asking for it answers `Unknown column name "MANDT"`.
Aggregates and `GROUP BY` are not accepted; only straightforward `SELECT`s with equality, `LIKE` and
`OR`. Expressions in the select list are rejected, and so are multi-line literals and long nested
`OR` / `IN` chains. Tables with `RAW` or long-text columns are refused as a whole. Fetch the detail
rows and summarise locally.

**`TYPE ANY` parameters on a standard function module accept flat character data only.** Handing one
a `string` raises `CX_SY_DYN_CALL_ILLEGAL_TYPE` at the call, not at the check.

**Internal tables passed to `TABLES` parameters must be declared `WITH DEFAULT KEY`.** A table with
`WITH EMPTY KEY` fails inside the callee with the same dyn-call error, pointing at a line you cannot
see.

**Function module existence is in `TFDIR`.** `PNAME` carries `SAPL<function group>`—not the function
group name. Check before retrying a call that answers "does not exist".

**`GetWhereUsed` answers within the scope the service allows.** On older BASIS releases the scope
resource is missing, so the request silently falls back to the server default. Zero rows means "not
found in that scope", not "unused".

**A check result with `executed: false` is not a pass.** Nothing was checked. Likewise a CDS syntax
check that answers `0 analyzed` has not looked at the source; on that surface activation is the
compile step.

**Text pool writes go to the active pool directly.** `activate: true` plus an explicit language, or
the write is staged and does not follow the main program's activation. Read back with the same
language you wrote.

**`UpdateScreen` and `UpdateGuiStatus` replace the whole document.** Fields you do not send fall back
to defaults, or are cleared. Read the current document, change it, send it whole. In a GUI status the
function-code text lives in `FUN_TEXT` together with `TEXT_TYPE: "S"` and `TEXTNO`; a `TEXT` field is
ignored for those entries.

**RAP implementation types are capitalised.** `Managed`, `Unmanaged`, `Abstract`, `Projection`. A
lowercase value is rejected by the schema, which surfaces as a parameter error rather than a type
error. Some releases do not accept `define view entity`; there the root view is
`define root view... as select from...` with `@AbapCatalog.preserveKey: true` (the annotation is
required or the behavior definition check complains about the BO structure).

**There is no unlock tool for behavior implementations.** The lock is a class lock—release it with
the class family.

## Answers that look like success

| Answer | What it actually means |
|---|---|
| `activated: false` with `errors: []` | the activation produced nothing—treat as not activated |
| `activated: false` with `unrecognized` set | the response had a shape the gateway could not read; report `status`, do not resend |
| `success: true` plus `source_code: null` on a read | the object is gone; this is not a successful read and not a delete proof either |
| `executed: false` on a check | nothing was checked |
| `isDeleted: "false"` inside a 200 | SAP accepted the request and kept the object |
| a write that answers `written: true, activated: false` | the source landed as an inactive version |

## What has no channel

| Capability | Situation | Workaround |
|---|---|---|
| BAdI implementation list | the bridge for it works on ECC only | search the source for implementation classes; preview `SXS_ATTR` / `SXC_EXIT` |
| creating a service binding | this ADT stack has no usable create entry | SE80 or the Eclipse wizard; publishing and reading work afterwards |
| profiler detail (hitlist, statement, DB access) | only the trace list is exposed | list with `RuntimeListProfilerTraceFiles`; detail in ST05 / ST12 |
| deleting a classic DDIC view (`VIEW/DV`) | the CDS delete tools only address the DDL path | SE11, or delete the CDS view that generated it |
| version history | no ADT endpoint | ADT or SAP GUI, by hand |
| interactive debugging | the endpoint needs a live debuggee and is stateful | SAP GUI debugger |

## Where the facts come from

Every behaviour statement in these documents was measured against a real system; the date and the
release are named where the detail matters. System identifiers are neutralised on purpose
(`$TMP`, `ZDEMO_*`, `DEVK…`) so that an example never looks like something you can copy literally
into your own system.

No endpoint is invented. If a surface is absent, the tool answers `NOT_IMPLEMENTED` with SAP's own
reason, or the capability goes into the ABAP bridge modules in `../abap/`.
