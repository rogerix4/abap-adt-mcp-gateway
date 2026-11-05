/**
 * Merging rules.
 *
 * - objects merge field by field;
 * - arrays are replaced wholesale, so a workspace cannot end up with defaults
 *   it never asked for and cannot delete;
 * - systems merge by `id`;
 * - `tier` is the one field that cannot be relaxed: the stricter value wins,
 *   whichever layer it came from.
 */

import { TIER_ORDER, type Tier } from "./schema.js";

type Dict = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stricterTier(a: Tier | undefined, b: Tier | undefined): Tier | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

/** Deep merge two configuration layers. Arrays and scalars from `override` win. */
export function mergeLayer(base: Dict, override: Dict): Dict {
  const result: Dict = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (key === "systems" && Array.isArray(value)) {
      result.systems = mergeSystems(
        Array.isArray(base.systems) ? (base.systems as Dict[]) : [],
        value as Dict[],
      );
      continue;
    }

    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeLayer(current, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

/** Merges two `systems` arrays by id; order is base order, then new ids. */
export function mergeSystems(base: Dict[], override: Dict[]): Dict[] {
  const byId = new Map<string, Dict>();
  for (const system of base) {
    if (typeof system.id === "string") byId.set(system.id, { ...system });
  }

  for (const patch of override) {
    const id = patch.id;
    if (typeof id !== "string") continue;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, { ...patch });
      continue;
    }

    const merged = mergeWithoutSystems(existing, patch);
    merged.tier = stricterTier(existing.tier as Tier | undefined, patch.tier as Tier | undefined);
    byId.set(id, merged);
  }

  return [...byId.values()];
}

/** Field merge that never recurses into `systems` (nested system lists are not a thing). */
function mergeWithoutSystems(base: Dict, override: Dict): Dict {
  const result: Dict = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeWithoutSystems(current, value);
      continue;
    }
    if (value !== undefined) result[key] = value;
  }
  return result;
}
