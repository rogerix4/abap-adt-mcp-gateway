/**
 * Loads the frozen tool contract from `tools/catalog.json`.
 *
 * The catalog is the single source of truth for tool names, descriptions and
 * input schemas. It is validated on load so a malformed catalog fails at
 * startup rather than producing a `tools/list` the client silently rejects.
 */

import { readFileSync } from "node:fs";

import type { ToolDefinition, ToolInputSchema } from "../engine/types.js";

export interface CatalogFile {
  readonly generatedFrom: string;
  readonly count: number;
  readonly tools: readonly ToolDefinition[];
}

/** Location of the catalog relative to this module (works from `src/` and `dist/`). */
export const CATALOG_URL = new URL("../../tools/catalog.json", import.meta.url);

export function loadCatalog(url: URL = CATALOG_URL): readonly ToolDefinition[] {
  const raw = JSON.parse(readFileSync(url, "utf8")) as CatalogFile;

  if (!Array.isArray(raw.tools)) {
    throw new Error(`catalog at ${url.pathname} has no "tools" array`);
  }
  if (typeof raw.count === "number" && raw.count !== raw.tools.length) {
    throw new Error(
      `catalog count mismatch: declared ${raw.count}, found ${raw.tools.length}`,
    );
  }

  const seen = new Set<string>();
  for (const tool of raw.tools) {
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error("catalog contains a tool without a name");
    }
    if (seen.has(tool.name)) {
      throw new Error(`catalog contains duplicate tool "${tool.name}"`);
    }
    seen.add(tool.name);
    assertObjectSchema(tool);
  }

  return raw.tools;
}

/**
 * MCP only accepts object schemas. A single non-object schema makes the whole
 * `tools/list` response invalid, which clients report as "no tools" — a failure
 * mode that is hard to trace back to one bad entry.
 */
function assertObjectSchema(tool: ToolDefinition): void {
  const schema = tool.inputSchema as ToolInputSchema | undefined;
  if (schema === undefined || schema === null || schema.type !== "object") {
    throw new Error(
      `tool "${tool.name}" has a non-object input schema; MCP requires type="object"`,
    );
  }
}
