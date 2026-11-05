// Gate for the frozen tool contract.
//
// Fails when:
//   - the tool count drifts from the documented number,
//   - two tools share a name,
//   - a tool is missing name / description / inputSchema.properties,
//   - a new tool appears whose schema is not `type: "object"` (the MCP wire
//     format rejects those, and one bad schema breaks the whole tools/list),
//   - catalog.json and layer-map.json disagree in either direction.
//
//   node tools/scripts/verify-catalog.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const EXPECTED_TOOL_COUNT = 335;

// Schemas that are not `type: "object"` after repair. This must stay empty: the
// MCP wire format rejects such tools, and one is enough to break `tools/list`.
// Four tools once landed here as raw Zod shapes; tools/scripts/fix-non-object-schemas.mjs
// converted them. Anything new that shows up is a defect, not a waiver.
const KNOWN_NON_OBJECT = new Set();

const errors = [];
const warn = [];

const catalog = JSON.parse(fs.readFileSync(path.join(root, "tools", "catalog.json"), "utf8"));
const tools = catalog.tools ?? [];

if (tools.length !== EXPECTED_TOOL_COUNT) {
  errors.push(`tool count is ${tools.length}, expected ${EXPECTED_TOOL_COUNT}`);
}

const names = tools.map((t) => t.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) errors.push(`duplicate tool names: ${[...new Set(dupes)].join(", ")}`);

const nonObject = [];
for (const tool of tools) {
  if (!tool.name || typeof tool.name !== "string") {
    errors.push("a tool has no name");
    continue;
  }
  if (!tool.description || typeof tool.description !== "string") {
    errors.push(`${tool.name}: missing description`);
  }
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object") {
    errors.push(`${tool.name}: missing inputSchema`);
    continue;
  }
  if (!schema.properties || typeof schema.properties !== "object") {
    errors.push(`${tool.name}: inputSchema has no properties object`);
  }
  if (schema.type !== "object") nonObject.push(tool.name);
}

for (const name of nonObject) {
  if (!KNOWN_NON_OBJECT.has(name)) {
    errors.push(`${name}: inputSchema.type is not "object" and is not in the known list`);
  }
}
for (const name of KNOWN_NON_OBJECT) {
  if (!nonObject.includes(name)) {
    warn.push(`${name}: no longer non-object, remove it from KNOWN_NON_OBJECT`);
  }
}

// catalog <-> layer-map must agree in both directions.
const mapPath = path.join(root, "tools", "layer-map.json");
if (!fs.existsSync(mapPath)) {
  errors.push("tools/layer-map.json is missing -- run tools/scripts/gen-layer-map.mjs");
} else {
  const layerMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const mapped = (layerMap.tools ?? []).map((t) => t.name);
  const missing = names.filter((n) => !mapped.includes(n));
  const extra = mapped.filter((n) => !names.includes(n));
  if (missing.length) errors.push(`layer-map missing: ${missing.join(", ")}`);
  if (extra.length) errors.push(`layer-map has unknown tools: ${extra.join(", ")}`);
  const unclassified = (layerMap.tools ?? []).filter((t) => t.effect === "unknown").map((t) => t.name);
  if (unclassified.length) errors.push(`unclassified side effects: ${unclassified.join(", ")}`);
  if ((layerMap.problems ?? []).length) {
    errors.push(`layer-map reports ${layerMap.problems.length} problem(s)`);
  }
}

console.log(`tools      : ${tools.length}`);
console.log(`non-object : ${nonObject.length}${nonObject.length ? " -> " + nonObject.join(", ") : ""}`);
for (const w of warn) console.log(`  ~ ${w}`);
for (const e of errors) console.log(`  ! ${e}`);
console.log(errors.length ? "FAIL" : "OK");
process.exit(errors.length ? 1 : 0);
