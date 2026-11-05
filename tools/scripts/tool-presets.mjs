#!/usr/bin/env node
/**
 * Prints a curated `toolPolicy` fragment for a bounded tool budget.
 *
 * Clients hand the model a bounded tool list (some stop at 128), so a 335-tool server
 * costs the agent whatever did not fit. `core` is a practical subset for everyday ABAP
 * work: full create/read/update/delete/check for the object types people actually edit,
 * plus search, activation, transports, data preview and runtime diagnostics. `*Low`
 * tools are left out — they exist for callers that drive the lock themselves.
 *
 * Usage:
 *   node tools/scripts/tool-presets.mjs                        list presets
 *   node tools/scripts/tool-presets.mjs --preset core          JSON fragment for toolPolicy
 *   node tools/scripts/tool-presets.mjs --preset core --check  count what it exposes
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const catalog = JSON.parse(readFileSync(join(ROOT, "tools", "catalog.json"), "utf8"));
const names = new Set(catalog.tools.map((tool) => tool.name));

/** Object types an ABAP developer edits in a normal week. */
const CORE_SUBJECTS = [
  "Program",
  "Include",
  "Class",
  "Interface",
  "FunctionGroup",
  "FunctionModule",
  "Table",
  "Structure",
  "DataElement",
  "Domain",
  "View",
  "MetadataExtension",
  "BehaviorDefinition",
  "BehaviorImplementation",
  "ServiceDefinition",
  "ServiceBinding",
  "Screen",
  "GuiStatus",
  "TextElement",
];

/** Tools whose subject is not an object type but that the work needs. */
const CORE_EXTRAS = [
  "SearchObject",
  "GetObjectInfo",
  "GetObjectStructure",
  "GetTypeInfo",
  "GetPackageContents",
  "GetPackageTree",
  "GetWhereUsed",
  "GetProgFullCode",
  "GetInactiveObjects",
  "GetSqlQuery",
  "GetTableContents",
  "GetObjectsByType",
  "ActivateObjects",
  "GetTransport",
  "ListTransports",
  "CreateTransport",
  "GetSession",
  "RunUnitTest",
  "GetUnitTest",
  "GetUnitTestResult",
  "GetUnitTestStatus",
  "GetTcodeUsage",
  "GetJobUsage",
  "RuntimeListDumps",
  "RuntimeGetDumpById",
  "RuntimeAnalyzeDump",
];

const PRESETS = {
  full: () => ({ gateway: false, layers: ["readonly", "write", "low"], allow: [], deny: [] }),
  /** Three tools, the whole contract reachable: the compact shape for a small budget. */
  gateway: () => ({ gateway: true, layers: [], allow: [], deny: [] }),
  /** Reads only, named: safe to hand to an agent that should never touch a system. */
  readonly: () => ({ gateway: false, layers: ["readonly"], allow: [], deny: [] }),
  /** Everything a caller needs without owning locks: reads and writes, no `*Low`. */
  high: () => ({ gateway: false, layers: ["readonly", "write"], allow: [], deny: [] }),
  core: () => ({
    gateway: true,
    layers: ["readonly", "write"],
    allow: [
      ...CORE_EXTRAS.filter((name) => names.has(name)),
      ...CORE_SUBJECTS.map((subject) => `*${subject}`),
    ],
    // `*View` also catches the dump / profiler handler tools, which are not object views.
    deny: ["Handler*"],
  }),
};

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const toRegex = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

const preset = arg("--preset", undefined);
if (preset === undefined) {
  console.log("presets:");
  console.log("  full       all 335 tools, named (readonly + write + low)");
  console.log("  gateway    three facade tools; the whole contract stays reachable by name");
  console.log("  readonly   reads only, named");
  console.log("  high       reads and writes, no *Low tools");
  console.log("  core       curated subset plus the facade (fits a 128-tool budget)");
  process.exit(0);
}

const build = PRESETS[preset];
if (build === undefined) {
  process.stderr.write(`tool-presets: unknown preset "${preset}" (have: ${Object.keys(PRESETS).join(", ")})\n`);
  process.exit(2);
}

const { gateway, layers, allow, deny } = build();
const allowers = allow.map(toRegex);
const denyers = deny.map(toRegex);
// Effect is not in the catalog; layer filtering by `write` is approximated by the verb,
// which is what the registry derives its effect from as well.
const WRITE_VERBS = /^(Create|Update|Delete|Activate|Release|Patch)/;
const exposed = catalog.tools
  .map((tool) => tool.name)
  .filter((name) => {
    if (/Low$/.test(name) && !layers.includes("low")) return false;
    const writes = WRITE_VERBS.test(name);
    if (writes && !layers.includes("write")) return false;
    if (!writes && !layers.includes("readonly")) return false;
    if (allowers.length > 0 && !allowers.some((pattern) => pattern.test(name))) return false;
    return !denyers.some((pattern) => pattern.test(name));
  });

if (process.argv.includes("--check")) {
  const low = exposed.filter((name) => /Low$/.test(name));
  const writes = exposed.filter((name) => WRITE_VERBS.test(name));
  const advertised = exposed.length + (gateway ? 3 : 0);
  console.log(`preset ${preset}: ${advertised} tools advertised, ${catalog.count} in the contract`);
  console.log(`  named: ${exposed.length}${gateway ? " + 3 facade tools (Gateway*)" : ""}`);
  console.log(`  layers: ${layers.join("+") || "none"}${gateway ? ", gateway" : ""}`);
  console.log(`  write tools: ${writes.length}, low-level tools: ${low.length}`);
  console.log(`  fits a 128-tool budget: ${advertised <= 128}`);
} else {
  console.log(JSON.stringify({ gateway, layers, allow, deny }, null, 2));
}
