# Configuration

> Editing the configuration should not require reading the source: schema completion, layered overrides, discoverable locations, and a hard line between settings and secrets.

## Five layers, low to high

| Layer | Location | Purpose | Committed? |
|---|---|---|---|
| Defaults | `src/config/defaults.ts` | Works with no file at all: zero systems, nothing contacted | — |
| User | Windows `%APPDATA%/abap-adt-mcp-gateway/config.jsonc` · macOS and Linux `$XDG_CONFIG_HOME/abap-adt-mcp-gateway/config.jsonc`, else `~/.config/abap-adt-mcp-gateway/config.jsonc` | Shared by every project on the machine: systems plus credential references | No |
| Workspace | `<cwd>/adt-mcp.config.jsonc` **or** `<cwd>/.adt-mcp/config.jsonc` | Narrowing for one project (for example two systems, both read-only) | Only fields without credentials |
| Installation | `<package>/adt-mcp.config.jsonc` **or** `<package>/.adt-mcp/config.jsonc` | The config that travels with the server itself | Yes if it holds no credentials |
| Environment | `ABAP_ADT_MCP_DEFAULT_SYSTEM`, `ABAP_ADT_MCP_LOG_LEVEL` | CI, temporary debugging | No |
| Command line | `--config <path>`, `--system <id>`, `--log-level <lvl>` | One-off override | — |

On macOS there is no `%APPDATA%`: the user layer is `$XDG_CONFIG_HOME`, and `~/.config` when that is unset — **not** `~/Library/Application Support`. Paths inside the file may use either separator on Windows; they are joined with `node:path`.

The **installation layer exists because MCP clients choose the working directory**: they spawn the server from the editor's workspace, not from the package. Without it a server configured only in its own folder starts with "no systems configured" and the full tool list — which is indistinguishable from a broken config, and is exactly what a stale-looking tool list turns out to be.

Both workspace file names are read; `.adt-mcp/config.jsonc` is applied after `adt-mcp.config.jsonc`, so it wins where they overlap.

Merge rules:

- Objects deep-merge; `systems` merges by `id`, so a workspace layer can override one field of a system without restating it.
- Arrays are replaced, never concatenated — otherwise a default entry cannot be removed.
- Each layer is validated on its own. An invalid field fails immediately with the layer name and the field path; nothing falls back silently.

## Why JSONC

- `//` and `/* */` are allowed, so a line can explain why a value is what it is.
- `adt-mcp.schema.json` is published alongside (generated from `src/config/schema.ts`), giving completion and hover text in VS Code.
- Same habits as `settings.json`; no new format to learn.

After changing the schema, run `npm run gen:schema`. `npm run verify` checks it with `--check` and fails when it is stale.

## Fields

```jsonc
{
 "$schema": "./adt-mcp.schema.json",

 "server": {
 "name": "abap-adt-mcp-gateway",
 "logLevel": "info" // error | warn | info | debug
 },

 "defaultSystem": "dev", // shown in tool descriptions; a single system needs no `system` argument

 "toolPolicy": {
 "timeoutMs": 180000, // per ADT request
 "expose": "gateway", // one level; see §5 for the eight and their sizes
 "allow": [], // keep only matching tools (globs), on top of the level
 "deny": ["UpdateUnitTest", "DeleteUnitTest"] // then remove matches (default shown)
 },

 "systems": [
 {
 "id": "dev", // lowercase alphanumeric plus. _ -, at most 32 characters
 "label": "development client 100", // display only
 "tier": "DEV", // dev is writable, qa and prd are read-only, omitted means prd

 "endpoint": {
 "url": "https://sap.example.com:44300",
 "client": "100",
 "language": "EN", // default EN
 "systemType": "onprem" // onprem | cloud
 },

 "auth": {
 "type": "basic",
 "username": "keychain:abap-adt-mcp-gateway/dev-user",
 "password": "keychain:abap-adt-mcp-gateway/dev"
 },

 "rfcBackend": "soap", // required by screens, CUA, text pools, usage queries
 "env": {} // extra variables passed to this system
 }
 ]
}
```

A system `id` is the value clients pass as `system`, and the value scripts take as `--profile`.

## Credentials: three reference forms, no plain text

| Form | Meaning | Use for |
|---|---|---|
| `env:ADT_PASSWORD` | Read an environment variable | CI, containers, an MCP client `env` block |
| `keychain:abap-adt-mcp-gateway/dev` | Read the system keychain (Windows Credential Manager, macOS Keychain, libsecret) | Day-to-day use |
| `file:~/.secrets/dev` | First line of a file | Machines without a keychain |

- A plain-text secret in the file fails validation at startup, and the error says how to change it.
- Resolved secrets live in process memory only: never written to disk, never logged, never included in an error payload.
- The keychain needs the optional dependency `@napi-rs/keyring`.
- A keychain that cannot be read does not stop the server: tools are registered and calls answer "credentials could not be resolved", which is easier to diagnose than a server that refuses to start.

## `toolPolicy.expose` and its patterns are not authorisation

`expose` / `allow` / `deny` only affect the tool list a client sees. They do not block calls. The real boundary is `tier`:

- Any write against a non-`dev` system is refused by `runtime.resolve(..., needsWrite)`, whether or not the tool is visible;
- "Write" is decided from the request semantics (method ≠ GET, write RFC action), not from how the tool name looks.

### The eight levels

Every named tool has exactly one kind, which is what makes the levels add up:

| Kind | What it is | Tools |
|---|---|---|
| `readonly` | only reads | 115 |
| `write` | create / update / delete / activate / release / patch | 86 |
| `low` | the `*Low` variants, where the caller owns the lock | 134 |

| Level | Made of | Advertised |
|---|---|---|
| `none` | nothing | 0 |
| `gateway` (default) | `full`, advertised as three tools instead of 335: everything stays reachable by name through `GatewayCallTool` | 3 |
| `readonly` | the `readonly` kind | 115 |
| `write` | the `write` kind | 86 |
| `low` | the `low` kind | 134 |
| `high` | `readonly` + `write` | 201 |
| `full` | every named tool | 335 |
| `core` | a curated subset for everyday ABAP work: full lifecycle for the object types people actually edit, plus search, activation, transports, data preview and runtime diagnostics — with the facade, because it narrows the list | 127 (124 + 3) |

`gateway` is `full` compressed — the same reach, three tools. `core` is the one that fits a 128-tool budget. `none` exists for diagnosing a client; it advertises nothing at all.

`allow` then `deny` apply on top: `allow` keeps only matches (so it can only narrow, never widen — including the curated set behind `core`), and `deny` removes matches last.

### The facade

`Gateway*` follows the level, not a switch of its own: `gateway` (three tools) and `core` (curated plus three) advertise it, every other level does not — a level that already advertises everything does not need a way around itself, and a narrow level should not get one either.

| Tool | Purpose |
|---|---|
| `GatewayListSystems` | configured systems and which one is the default |
| `GatewayListTools` | search the contract: `pattern`, `verb`, `query`, `layer`, `detail: "names" \| "descriptions" \| "schema"` |
| `GatewayCallTool` | `{ tool, arguments, system }` — runs any tool, advertised or not |

They exist because clients pass a bounded tool list to the model (some stop at 128), and a tool the client dropped is a tool the agent silently lost.

```bash
node tools/scripts/tool-presets.mjs # every level and its size
node tools/scripts/tool-presets.mjs --level core --check # 127 tools
node tools/scripts/tool-presets.mjs --level gateway --check # 3 tools
```

### The deprecated `layers` / `gateway`

Write-ups with `layers: [...]` and `gateway: true` still start: they are mapped onto the nearest level and a deprecation notice goes to stderr.

| `layers` | Level |
|---|---|
| `["readonly", "write", "low"]` (or omitted) | `full` |
| `["readonly", "write"]` | `high` |
| `["readonly"]` / `["write"]` / `["low"]` | the same name |
| `[]` | `gateway` when `gateway: true`, otherwise `none` |
| anything else (e.g. `["readonly", "low"]`) | `full`, and the warning says no level matched |

`allow` / `deny` keep their place; only the level is derived.

## A tier can only get stricter

`tier` is a safety boundary, so merging can only move it in the strict direction: a workspace layer can narrow `dev` to `qa`, and cannot widen a user-level `qa` to `dev`. The merged result is validated again.

## Not committed, not published

`.gitignore` always contains:

```text
node_modules/ dist/
adt-mcp.config.jsonc adt-mcp.config.local.jsonc.adt-mcp/ profiles/ *.local.jsonc
audit.jsonl *.log logs/
```

Only `adt-mcp.config.example.jsonc` is in the repository: every field present, every credential a reference. `npm run verify:private` scans for host names, IP addresses, user names, e-mail addresses, token shapes and absolute paths; any hit fails the build.

## Example: several systems, one project narrowed to two read-only

The user-level file (`%APPDATA%/abap-adt-mcp-gateway/config.jsonc` on Windows, `~/.config/abap-adt-mcp-gateway/config.jsonc` on macOS and Linux) lists all systems with credential references. The project adds `<ws>/adt-mcp.config.jsonc`:

```jsonc
{
 "systems": [
 { "id": "dev", "tier": "qa" },
 { "id": "qas", "tier": "qa" }
 ]
}
```

All systems remain configured (`system` still enumerates them), but `dev` and `qas` become read-only in this project. Removing a system from the list is a user-level decision; a workspace layer only narrows.
