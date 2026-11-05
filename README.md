# abap-adt-mcp-gateway

[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25%20%E2%80%A6%202024--10--07-blue)](https://modelcontextprotocol.io)
[![tools](https://img.shields.io/badge/tools-335-informational)](docs/TOOLS.md)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Model Context Protocol (MCP) server for SAP ABAP development** — one server in front of
many SAP systems, one fixed contract of **335 tools** over the ABAP Development Tools (ADT)
REST API, and an honest answer whenever a system cannot do what a tool promises.

Point an MCP client at it and an agent can read and rewrite ABAP source, run syntax checks,
activate objects, manage transport requests, drive dynpro screens and GUI statuses, read and
render SmartForms, and query system data — without SAP GUI.

## Acknowledgments

The tool contract in [`tools/catalog.json`](tools/catalog.json) follows
[babamba2/abap-mcp-adt-powerup](https://github.com/babamba2/abap-mcp-adt-powerup), so an agent
that knows that server finds the same 335 names, descriptions and JSON Schemas here. The
concept of an MCP server for ABAP ADT goes back to
[mario-andreschak/mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt) and
[fr0ster/mcp-abap-adt](https://github.com/fr0ster/mcp-abap-adt/tree/main/src). This project is
an independent implementation: same contract, different architecture, and a few things the
others leave to regular expressions are done properly here.

---

## Table of Contents

- [Why this gateway](#why-this-gateway)
- [Features](#features)
- [Supported SAP environments](#supported-sap-environments)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Client configuration](#client-configuration)
- [Available tools](#available-tools)
- [What ADT does not expose](#what-adt-does-not-expose)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License and notice](#license-and-notice)

---

## Why this gateway

| | |
|---|---|
| **A test proves the tool ran** | `activated: true` comes from comparing the active version of an object with the source that was just written — not from an HTTP status |
| **335 tools verified one by one** | every name in the contract was called against a real system; the ones whose server-side surface does not exist answer `NOT_IMPLEMENTED` with SAP's own reason instead of a plausible success |
| **Writes are guarded in one place** | only systems with `tier: "dev"` accept a write, the decision is made per call from the request semantics, and a missing tier counts as production |
| **Locks do not get lost** | every lock handle is journalled on disk; a stale handle is released before the next lock on the same object |
| **A real parser, not a keyword scan** | `GetAbapAST`, `GetAbapSemanticAnalysis` and `GetAbapSystemSymbols` parse with [`@abaplint/core`](https://github.com/abaplint/abaplint); the upstream server's implementations are hand-written regular expressions |
| **Surfaces ADT forgets** | dynpro screens, CUA GUI statuses, text pools, SmartForms (read / create / delete / render to PDF) run over small remote-enabled ABAP modules shipped in [`abap/`](abap/README.md) |
| **Small tool budgets** | `toolPolicy.expose` picks a whole level (`readonly` … `full`, plus the curated `core`), then `allow` / `deny` narrow it; `GatewayListSystems` / `GatewayListTools` / `GatewayCallTool` keep all 335 reachable for clients that can only pass a few dozen tools to the model |

## Features

- **335 tools, one contract** — names, descriptions and JSON Schemas live in
  [`tools/catalog.json`](tools/catalog.json); every tool is registered up front and the list
  does not change after `initialize`.
- **Multi-system by design** — each tool takes an extra `system` argument; one ADT session per
  system is kept alive so a lock handle stays valid across calls.
- **Full object lifecycle** — create / read / update / check / activate / delete for programs,
  includes, classes, interfaces, function groups and modules, tables, structures, data
  elements, domains, CDS views, metadata extensions, service definitions and bindings, behavior
  definitions, packages, message classes, search helps, lock objects and transport requests.
- **`*Low` variants** — one tool call maps to exactly one ADT request when you want to own the
  lock, the headers and the `corrNr` yourself.
- **Runtime diagnostics** — short dumps, ABAP profiler traces, ABAP Unit runs, syntax checks.
- **Data preview** — `GetSqlQuery` and `GetTableContents` read tables and views through ADT.
- **Activation you can trust, errors you can read** — SAP's message text is preserved (HTML
  error pages are stripped), and the `details` of an error name the next concrete step.
- **stdio only** — stdout carries the JSON-RPC stream, diagnostics go to stderr; there is no
  listener to expose.

## Supported SAP environments

| Environment | Auth | Notes |
|---|---|---|
| **On-premise / S/4HANA** | Basic auth | The full surface, verified against an S/4HANA system |
| **BTP ABAP Environment** | Basic auth | ADT-only tools; the bridges need `/sap/bc/soap/rfc`, which a BTP system does not offer |
| **ECC / BASIS < 7.50** | Basic auth | Classic tools; some RAP/CDS endpoints do not exist and answer `NOT_IMPLEMENTED` with the reason |

The gateway never assumes a capability: it calls, reads the answer, and reports what SAP said.

## Quick start

```bash
git clone https://github.com/rogerix4/abap-adt-mcp-gateway
cd abap-adt-mcp-gateway
npm install
npm run build

cp adt-mcp.config.example.jsonc adt-mcp.config.jsonc   # then edit url/client/credentials
node dist/bin.js --coverage                            # should print 335/335
```

Then register the server with your MCP client (see [Client configuration](#client-configuration)).

## Installation

| | |
|---|---|
| **Node.js** | `>= 20.11` (declared in `engines`); verified on Node 24.15 / npm 11.12 |
| **MCP protocol** | JSON-RPC 2.0 over **stdio**; version negotiated between `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` |
| **MCP capabilities** | `tools` only — `listChanged: false`. No resources, prompts, sampling or logging |
| **Runtime dependencies** | `@modelcontextprotocol/sdk`, `zod`, `@abaplint/core` |
| **Optional dependency** | `@napi-rs/keyring` — only needed for `keychain:` credential references |
| **Build** | TypeScript 5.7, ES2023, ESM (`"type": "module"`), output in `dist/` |
| **Platforms** | Windows, macOS, Linux (Node built-ins plus the optional keyring) |
| **SAP side** | ADT reachable at `<url>/sap/bc/adt` with basic authentication. Screens, CUA, text pools, SmartForms and usage queries additionally need `/sap/bc/soap/rfc` and the bridge modules from [`abap/`](abap/README.md) |

## Configuration

```jsonc
{
  "$schema": "./adt-mcp.schema.json",
  "defaultSystem": "dev",
  "systems": [
    {
      "id": "dev",
      "tier": "dev",                                  // dev is writable; qa and prd are read-only; omitted means prd
      "endpoint": { "url": "https://sap.example.com:44300", "client": "100", "language": "EN" },
      "auth": {
        "username": "keychain:abap-adt-mcp-gateway/dev-user",
        "password": "keychain:abap-adt-mcp-gateway/dev"
      }
    }
  ]
}
```

- Credentials are **references only** — `keychain:<service>/<account>`, `env:NAME` or
  `file:<path>`. A plain-text secret fails startup validation.
- Layers, lowest first: defaults → user (`%APPDATA%\abap-adt-mcp-gateway\config.jsonc`) →
  workspace → environment → command line. Every layer is validated on its own.
- `toolPolicy` decides what is *advertised* (visibility, not authorisation). One level, then
  two narrowings — the default `gateway` is `full` compressed to three tools:
  ```jsonc
  "toolPolicy": {
    "expose": "core",     // none | gateway | readonly | write | low | high | full | core
    "allow": [],          // keep only matches
    "deny": []            // then remove matches
  }
  ```
  ```bash
  node tools/scripts/tool-presets.mjs                 # every level and how many tools it advertises
  node tools/scripts/tool-presets.mjs --level core    # paste-ready fragment (127 tools)
  node tools/scripts/tool-presets.mjs --level full --check
  ```

Every field is documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Client configuration

VS Code (`mcp.json`, workspace or user level):

```json
{
  "servers": {
    "abap-adt-mcp-gateway": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\path\\to\\abap-adt-mcp-gateway\\dist\\bin.js"]
    }
  }
}
```

No environment variables are required: systems, tiers and credentials all come from
`adt-mcp.config.jsonc`. The startup banner reports the exposed tool count and the configured
systems, on stderr.

## Available tools

335 tools in 18 verb groups — `Get` (67), `Delete` (42), `Create` (41), `Update` (40),
`Read` (19), `Lock` (18), `Activate` (17), `Unlock` (17), `Validate` (16), `Check` (14),
`Run` (14), `List`, `Search`, `Patch`, `Describe`, `Handler*` and three `Gateway*` facades.

- Full reference with arguments and return shapes: [docs/TOOLS.md](docs/TOOLS.md)
- The machine-readable contract: [`tools/catalog.json`](tools/catalog.json)
- Coverage of the running build: `node dist/bin.js --coverage`

What `tools/list` returns is `toolPolicy.expose`. The default is **`gateway`** — three tools that
reach all 335 by name, because a client hands the model a bounded list. `"expose": "full"` makes
the contract itself the list; `"core"` gives 127 curated tools. Every level and its size:
`node tools/scripts/tool-presets.mjs`.

Two tools are deliberately **not advertised** (`UpdateUnitTest`, `DeleteUnitTest`): ADT has no
`PUT` and no `DELETE` on `/abapunit/runs/{id}` — both answer HTTP 405. They remain callable by
name and reply with that reason.

## What ADT does not expose

Some SAP surfaces have no ADT resource at all. Rather than pretending, the gateway ships small
remote-enabled ABAP modules and calls them over the system's own SOAP RFC endpoint:

| Surface | Module | Tools |
|---|---|---|
| Dynpro screens (create / read / delete) | `ZMCP_ADT_DISPATCH` | `GetScreen`, `ReadScreen`, `CreateScreen`, `UpdateScreen`, `DeleteScreen`, `GetScreensList` |
| GUI statuses (CUA) | `ZMCP_ADT_DISPATCH` | `GetGuiStatus`, `ReadGuiStatus`, `CreateGuiStatus`, `PatchGuiStatus`, `DeleteGuiStatus`, `UpdateGuiStatus` |
| Text pools | `ZMCP_ADT_TEXTPOOL` | `GetTextElement`, `ReadTextElementsBulk`, `WriteTextElementsBulk`, `CreateTextElement`, `UpdateTextElement`, `DeleteTextElement` |
| SmartForms | `ZMCP_SSF_CONTENT`, `ZMCP_SSF_UPLOAD`, `ZMCP_SSF_DELETE`, `ZMCP_SSF_RENDER` | `GetSmartFormLayout`, `GetSmartFormContent`, `CreateSmartForm`, `DeleteSmartForm`, `RenderSmartForm` |
| Job / transaction usage | `ZMCP_WL_JOB_USAGE`, `ZMCP_WL_TCODE_USAGE` | `GetJobUsage`, `GetTcodeUsage` |

Install them into a system with one re-runnable command:

```bash
node tools/scripts/import-abap-bridges.mjs --profile <system-id>
```

Details, module by module: [`abap/README.md`](abap/README.md).

## Architecture

```
MCP client ──stdio──▶ dist/bin.js ──┬──HTTPS──▶ "dev"  tier dev  · session sys:dev · writable
                                    ├──HTTPS──▶ "qa"   tier qa   · session sys:qa
                                    ├──HTTPS──▶ "prd"  tier prd  · session sys:prd
                                    └──SOAP───▶ <any of them>/sap/bc/soap/rfc   (bridge actions)
```

One process, one fixed contract, one write boundary, one lock journal on disk — and every
system in `systems[]` online **at the same time**. Three configured systems are three live ADT
sessions, not one session that gets re-pointed. There is no active system to switch: choosing
one is an argument on the next call, not a change of state.

**Concurrency is per system, not per process.** Calls to different systems overlap; only two
writes to the same system queue.

| Two calls in flight | Behaviour |
|---|---|
| read A · read B | concurrent — reads are never queued, on any system |
| read A · write A | concurrent |
| write A · write B | concurrent — each system has its own write queue |
| write A · write A | queued — two writes in one stateful session interleave LOCK / UNLOCK and one strands a lock |

A slow or failing system therefore slows **only its own writes**.

**Each system keeps its own session state.** Cookie jar, CSRF token, ABAP session id and the
pinned client belong to that system alone; using the next system neither resets them nor
re-points them. `session_id` names its owner (`sys:<id>`), so a `Lock*Low` / `Update*Low` pair
cannot drift into another system — the mismatch is rejected before SAP sees it.

**Routing is per call.** `system` selects the target of every tool call. With several systems
configured it is required — omitting it answers `SYSTEM_UNKNOWN` with the valid ids instead of
picking one silently; with exactly one it may be omitted. `defaultSystem` only shapes the tool
descriptions and the `GatewayListSystems` answer; it does not make `system` optional, and it
never redirects a call.

`ReloadProfile` is the one global operation: it re-reads the configuration and rebuilds every
session, and a file that no longer validates leaves the running sessions untouched. The
advertised system list itself is fixed at startup, so restart after adding or removing a system.
Everything else — an expired session, a missing bridge module, a read-only tier — stays inside
the system that hit it.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what is keyed per system (sessions, write
queues, lock journals, tiers), what stays shared, and the trade-offs;
[docs/OPERATIONS.md](docs/OPERATIONS.md) covers the operator view (sessions, locks, tiers,
configuration layers, onboarding a system).

## Development

```bash
npm run build                  # compile to dist/
npm run verify                 # contract, secret scan, deprecations, tsc, generated artefacts, tests
npm run test                   # vitest
node dist/bin.js --coverage    # implementation coverage (335/335)
node dist/bin.js --help        # CLI options
```

`dist/` is build output — never edit it. The contract is frozen: a new capability is a new tool,
and changing `tools/catalog.json` requires regenerating `adt-mcp.schema.json` and
`docs/TOOLS.md` (`npm run verify` fails on drift).

## Testing

| Layer | Command | What it proves |
|---|---|---|
| Unit and contract tests | `npm test` | 173 tests over 19 files: routing, tiers, locks, activation, the tools with no network round trip |
| Contract and generated artefacts | `npm run verify` | the 335 names, the JSON Schema, the tools doc and the source agree |
| Route probe | `node tools/scripts/probe-routes.mjs --profile <id>` | every ADT route answers on a real system |
| Bridge probe | `node tools/scripts/probe-bridge.mjs --profile <id>` | the 16 bridged tools work end to end |
| Live smoke | `npm run live:smoke` / `npm run live:families` | object families against a real system |

Everything that creates objects cleans up after itself, uses `$TMP` unless the object is a
deliverable, and returns every lock it took.

## Troubleshooting

Quick pointers, full table in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md):

| Symptom | Look at |
|---|---|
| The server does not start | startup diagnostics on stderr; credentials must be references, not literals |
| The client says it cannot pass all tools | use `toolPolicy.expose: "core"` (127 tools), or `"gateway"` for three |
| A write is refused | the target system's tier is not `dev` |
| An object stays locked | the lock journal under `%LOCALAPPDATA%\abap-adt-mcp-gateway\` |
| Activation reported, source unchanged | the tool reports `activated` only when the active version matches what was written |
| A bridge tool answers "module not found" | run `import-abap-bridges.mjs` for that system |
| SmartForm rendering fails with `SSFCOMPOSER/010` | the RFC user has no default output device (SU3 → Defaults → Output device) |

## FAQ

**Does it write to production?** Only if you label a system `tier: "dev"`. A missing or
misspelled tier counts as `prd`, and the refusal carries `SYSTEM_READ_ONLY` plus the tier.

**Why a fixed 335-tool contract?** So an agent can rely on a name. An unimplemented capability
answers `NOT_IMPLEMENTED` with the SAP reason; it never invents a success.

**Do I need the ABAP modules?** Only for surfaces ADT does not expose (screens, CUA, text pools,
SmartForms, usage queries). Everything else is pure ADT.

**Why does `RenderSmartForm` need a printer?** SmartForms formats output through a device type;
`GETOTF` takes that device from the RFC user's master data. Set one in SU3 (Defaults → Output
device) — the gateway then renders to PDF without printing.

**Can one server work on several systems at once?** Yes. Every system in `systems[]` is online
at the same time, each with its own ADT session, and `system` picks the target per call — reads
anywhere and writes to different systems run concurrently, only two writes to the same system
queue. With several systems configured, `system` is required.

**Can I use it from HTTP?** No. The transport is stdio on purpose: a smaller attack surface and
nothing to expose by accident.

## Documentation

| Document | Contents |
|---|---|
| [docs/README.md](docs/README.md) | index of all documents |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | call path, tool contract, sessions, locks, activation |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | process model, write boundary, configuration layers, onboarding |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | every configuration field and layer |
| [docs/USAGE.md](docs/USAGE.md) | how to call the tools, with examples |
| [docs/TOOLS.md](docs/TOOLS.md) | the 335 tools by verb |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | symptom → cause → fix |
| [abap/README.md](abap/README.md) | the ABAP bridge modules and how to install them |
| [CHANGELOG.md](CHANGELOG.md) | release history |
| [AGENTS.md](AGENTS.md) | notes for AI agents working on this repository |

## Contributing

Issues and pull requests are welcome. Please keep the following invariants:

1. **The contract stays compatible.** Tool names, descriptions and schemas come from
   `tools/catalog.json`; a new capability is a new tool.
2. **No invented endpoints.** If ADT does not offer something, the tool says so — or the
   capability goes into a bridge module with a test that proves it.
3. **`npm run verify` must pass**, and anything that changes behaviour needs a test that fails
   without the change.
4. **English** for code, comments and documentation.

## License and notice

MIT — see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE); the tool contract is
derived from `@babamba2/abap-mcp-adt-powerup`, and the ABAP parser is
[`@abaplint/core`](https://github.com/abaplint/abaplint) (MIT).
