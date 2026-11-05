#!/usr/bin/env node
/**
 * Generates `adt-mcp.schema.json` from the zod configuration schema.
 *
 * Editors use it for completion and hover text in `adt-mcp.config.jsonc`, so it
 * must stay in step with the code. Requires a build first (`npm run build`).
 * Pass `--check` to fail when the committed file is stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "adt-mcp.schema.json");

async function loadSchemaModules() {
  const schemaPath = join(ROOT, "dist", "config", "schema.js");
  try {
    return await import(new URL(`file://${schemaPath.replace(/\\/g, "/")}`).href);
  } catch (error) {
    process.stderr.write(
      `gen-schema: cannot load ${schemaPath}\n  ${error.message}\n  run "npm run build" first\n`,
    );
    process.exit(2);
  }
}

async function main() {
  const check = process.argv.includes("--check");
  const { ConfigPatchSchema } = await loadSchemaModules();
  const { zodToJsonSchema } = await import("zod-to-json-schema");

  const jsonSchema = zodToJsonSchema(ConfigPatchSchema, {
    name: "AbapAdtMcpConfig",
    $refStrategy: "root",
    errorMessages: true,
  });

  const document = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "ABAP ADT MCP gateway configuration",
    description:
      "Configuration for the abap-adt-mcp-gateway server. Credentials must be references " +
      "(env:, file:, keychain:) — plain-text secrets are rejected at startup.",
    ...jsonSchema,
  };

  const text = `${JSON.stringify(document, null, 2)}\n`;

  if (check) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      current = "";
    }
    if (current !== text) {
      process.stderr.write("gen-schema: adt-mcp.schema.json is out of date, regenerate it\n");
      process.exit(1);
    }
    process.stdout.write("gen-schema: up to date\n");
    return;
  }

  writeFileSync(OUT, text, "utf8");
  process.stdout.write(`gen-schema: wrote ${OUT}\n`);
}

await main();
