/**
 * Loads derived tool metadata from `tools/layer-map.json`.
 *
 * The generated file answers questions the tool *names* cannot: whether a tool
 * is high or low level, whether it writes, and whether the caller must supply a
 * lock handle or session. 89 of the 134 `*Low` tools have no high-level
 * sibling, so the suffix alone is not a reliable signal.
 */

import { readFileSync } from "node:fs";

import type { ToolMeta } from "../engine/types.js";

export interface LayerMapFile {
  readonly generatedFrom: string;
  readonly summary: Record<string, number>;
  readonly problems: readonly unknown[];
  readonly tools: readonly ToolMeta[];
}

export const LAYER_MAP_URL = new URL("../../tools/layer-map.json", import.meta.url);

export function loadLayerMap(url: URL = LAYER_MAP_URL): ReadonlyMap<string, ToolMeta> {
  const raw = JSON.parse(readFileSync(url, "utf8")) as LayerMapFile;

  if (!Array.isArray(raw.tools)) {
    throw new Error(`layer map at ${url.pathname} has no "tools" array`);
  }

  const map = new Map<string, ToolMeta>();
  for (const meta of raw.tools) {
    if (map.has(meta.name)) {
      throw new Error(`layer map contains duplicate entry "${meta.name}"`);
    }
    map.set(meta.name, meta);
  }
  return map;
}
