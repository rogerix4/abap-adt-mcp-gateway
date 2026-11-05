/**
 * Wires the frozen contract and its derived metadata into a registry.
 *
 * Both files are generated and committed; loading them at startup keeps a bad
 * catalog from being discovered only when a client asks for the tool list.
 */

import { loadCatalog } from "../core/catalog.js";
import { loadLayerMap } from "../core/layer-map.js";
import { ToolRegistry, type RegistryOptions } from "./registry.js";

export function createRegistry(options: RegistryOptions = {}): ToolRegistry {
  const definitions = loadCatalog();
  const metas = loadLayerMap();
  return new ToolRegistry(definitions, metas, options);
}
