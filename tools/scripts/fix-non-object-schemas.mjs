// Repair tool schemas that the catalog generator emitted as raw Zod shapes.
//
// Four tools (CreatePackage, GetInclude, GetPackageContents, GetTableContents)
// came through as `{ fieldName: { def: {...}, type: "..." } }` maps instead of
// JSON Schema. That is not valid JSON Schema, and MCP rejects any tool whose
// `inputSchema.type` is not "object" -- one of them is enough to break the whole
// `tools/list` response.
//
// This script converts those Zod definitions into the JSON Schema they describe.
// It is idempotent: once a tool is a valid object schema it is left untouched.
//
//   node tools/scripts/fix-non-object-schemas.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const catalogPath = path.join(root, "tools", "catalog.json");

/** True when the value is a Zod internal shape dump rather than a JSON Schema. */
function isZodShape(node) {
  if (!node || typeof node !== "object") return false;
  const keys = Object.keys(node);
  if (keys.length === 0) return false;
  return keys.every((k) => node[k] && typeof node[k] === "object" && typeof node[k].type === "string");
}

/** Convert one Zod node into a JSON Schema, marking optionality for the caller. */
function convert(node) {
  const def = node?.def ?? {};
  const type = def.type ?? node?.type;
  const describe = (schema) => {
    const text = def.description ?? node?.description;
    if (typeof text === "string" && text.length > 0) schema.description = text;
    return schema;
  };

  switch (type) {
    case "string":
      return { required: true, schema: describe({ type: "string" }) };
    case "number":
      return { required: true, schema: describe({ type: "number" }) };
    case "boolean":
      return { required: true, schema: describe({ type: "boolean" }) };
    case "literal":
      return { required: true, schema: describe({ const: def.value }) };
    case "enum": {
      const values = Object.values(def.entries ?? node?.enum ?? {});
      return { required: true, schema: describe({ type: "string", enum: values }) };
    }
    case "array": {
      const inner = convert(def.element ?? node?.element ?? {});
      return { required: true, schema: describe({ type: "array", items: inner.schema }) };
    }
    case "object": {
      const shape = def.shape ?? {};
      const { schema } = convertShape(shape);
      return { required: true, schema: describe(schema) };
    }
    case "optional":
    case "default":
    case "nullable": {
      const inner = convert(def.innerType ?? {});
      if (type === "default" && def.defaultValue !== undefined) inner.schema.default = def.defaultValue;
      return { required: false, schema: inner.schema };
    }
    default:
      // Unknown Zod node: keep the parameter, describe it as a free-form value
      // rather than dropping it (dropping would change the tool contract).
      return { required: false, schema: { description: `type: ${String(type)}` } };
  }
}

/** Convert a Zod object shape into a JSON Schema object. */
function convertShape(shape) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(shape)) {
    const converted = convert(value);
    properties[key] = converted.schema;
    if (converted.required) required.push(key);
  }
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return { schema, required };
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const repaired = [];

for (const tool of catalog.tools) {
  const schema = tool.inputSchema;
  if (schema?.type === "object") continue;
  if (!isZodShape(schema)) continue;
  const { schema: converted } = convertShape(schema);
  tool.inputSchema = converted;
  repaired.push(tool.name);
}

if (process.argv.includes("--check")) {
  if (repaired.length === 0) {
    console.log("all schemas are JSON Schema objects");
    process.exit(0);
  }
  console.log(`would repair ${repaired.length}: ${repaired.join(", ")}`);
  process.exit(1);
}

if (repaired.length === 0) {
  console.log("nothing to repair");
} else {
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
  console.log(`repaired ${repaired.length}: ${repaired.join(", ")}`);
}
