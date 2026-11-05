# AGENTS.md

Notes for an AI agent that works **on this repository** (not with it). Using the server from a
client is covered by the [README](README.md) and [docs/USAGE.md](docs/USAGE.md).

## Ground rules

1. **`src/` is the only source of truth.** `dist/` is `npm run build` output — never edit it.
2. **Build and verify before you claim anything.** `npm run build`, then
   `node dist/bin.js --coverage` (335/335), then `npm run verify`.
3. **The contract is frozen.** The 335 tool names, descriptions and schemas live in
   `tools/catalog.json`. A new capability is a new tool; changing the catalog means regenerating
   `adt-mcp.schema.json` and `docs/TOOLS.md`, and `npm run verify` will tell you if you forgot.
4. **No invented ADT endpoints.** If a surface does not exist in ADT, the tool answers
   `NOT_IMPLEMENTED` with SAP's own reason, or the capability goes into an ABAP bridge module in
   `abap/` with a test that proves it works on a real system.
5. **English** in code, comments, commit messages and documentation.

## Where to look

| Question | File |
|---|---|
| How a call travels, why locks are journalled, how activation is verified | `docs/ARCHITECTURE.md` |
| Write boundary, tiers, configuration layers, onboarding a system | `docs/OPERATIONS.md` |
| A tool's arguments | `docs/TOOLS.md` (generated) |
| The ABAP side | `abap/README.md` |
| Why something answers oddly | `docs/TROUBLESHOOTING.md` |

## Working on a change

1. Change `src/**` (and `tests/**` for anything that can be tested without a system).
2. `npm run build` → `npm test` → `npm run verify`.
3. If the change touches a live system: install bridges with
   `node tools/scripts/import-abap-bridges.mjs --profile <id>`, probe with
   `node tools/scripts/probe-routes.mjs --profile <id>`, and read back what you wrote.
4. Anything that creates objects cleans up after itself: run-scoped names, `$TMP` unless it is a
   deliverable, read-back after delete, every lock returned.

## What not to do

- Do not hand-edit `dist/`, `adt-mcp.schema.json` or `docs/TOOLS.md` — they are generated.
- Do not widen the write boundary. `tier: "dev"` is the only writable tier, by design.
- Do not "fix" a refusal by retrying: the message names the reason, and the next step is to read
  it (`SYSTEM_READ_ONLY`, `NOT_IMPLEMENTED`, `UPSTREAM_FAILED` with `details`).
