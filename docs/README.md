# Documentation

Everything about the gateway, grouped the way it is used: what it is, how to run it, how to
call it, and what to do when something does not work.

| Document | Read it when |
|---|---|
| [../README.md](../README.md) | you want the overview, the feature list and a quick start |
| [ARCHITECTURE.md](ARCHITECTURE.md) | you need the call path, multi-system concurrency, the tool contract, sessions and locks, or how activation is verified |
| [OPERATIONS.md](OPERATIONS.md) | you run the server: process model, write boundary, configuration layers, advertised surface, onboarding a new SAP system, build rules |
| [CONFIGURATION.md](CONFIGURATION.md) | you write or debug `adt-mcp.config.jsonc` |
| [CHOOSING.md](CHOOSING.md) | you know what you want to find out and need the tool, the capability layer, or the SAP behaviour that changes the call |
| [WORKFLOW.md](WORKFLOW.md) | you are about to create, change, activate or delete an object, and want the order plus the evidence to collect |
| [USAGE.md](USAGE.md) | you call the tools and want the shapes, the lock dance and the error codes |
| [TOOLS.md](TOOLS.md) | you need a tool's arguments; generated from `tools/catalog.json` |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | something answers strangely, a write does not land, or an object stays locked |
| [../abap/README.md](../abap/README.md) | the surface is not ADT (screens, CUA, text pools, SmartForms) and you need the bridge modules |
| [../AGENTS.md](../AGENTS.md) | you are an AI agent working *on* this repository |
| [../CHANGELOG.md](../CHANGELOG.md) | you want to know what changed and when |
| [../SECURITY.md](../SECURITY.md) | you want to report a vulnerability, or understand what the gateway can do with its credentials |

**Starting fresh — an AI agent or a new colleague?** Read [USAGE.md](USAGE.md) first: call
shape, how a call reaches a system, the write sequence with its fingerprints, how activation is
judged, the error codes and the shapes that look successful without being so. Then
[OPERATIONS.md](OPERATIONS.md#the-write-boundary) for what may be written at all. Argument names
are never guessed: they are in [TOOLS.md](TOOLS.md) and in the tool schema.

**Installing it for the first time?** The [README](../README.md) walks the whole path in order:
before you start → install → configure (required) → register in your client → verify → use. The
client blocks and the platform-specific file locations are in the register and configure
sections.

## The four documents that answer most questions

1. **How does a call travel, and can several systems be used at once?**
 [ARCHITECTURE.md](ARCHITECTURE.md#call-path) and
 [ARCHITECTURE.md](ARCHITECTURE.md#multi-system-concurrency).
2. **Why was my write refused?** [OPERATIONS.md](OPERATIONS.md#the-write-boundary) — only
 `tier: "dev"` systems are writable.
3. **Which shape does this tool take?** [TOOLS.md](TOOLS.md).
4. **Why does this system answer differently?** [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Keeping the documents true

- **Examples carry placeholder names only**: `ZDEMO_*` for objects, `DEVK…` for transport
 numbers, `$TMP` for packages. A real customer object or transport number in a document is a
 defect: `npm run verify:private` fails on any transport number that is not `DEVK…`, and a
 reviewer should reject a real object name the same way.
- **Prose names no system**: a measurement is dated and qualified by release and client
 (`measured on a test system, client 100`), never by the system id. Captured answers
 kept as test fixtures are the one exception — they are byte-for-byte what SAP sent, and
 assertions are written against them.
- `docs/TOOLS.md` and `adt-mcp.schema.json` are generated from `tools/catalog.json`;
 `npm run verify` fails when they drift, so edit the catalog and regenerate, never the output.
- A behaviour claim in a document needs a probe or a test behind it. If you find one that does
 not match the code, that is a bug in the document — please open an issue.
