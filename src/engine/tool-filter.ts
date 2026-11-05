/**
 * Tool visibility filter.
 *
 * Clients hand the model a tool list, and models have a budget (some as low as 128
 * tools). With 335 tools on offer, everything the client cannot pass on is a tool the
 * agent silently loses. Two coarse knobs and two precise ones decide what is advertised:
 *
 *   layers  which kinds of tool exist for this client: `readonly` (reads), `write`
 *           (creates/updates/deletes/activates), `low` (the `*Low` variants that make the
 *           caller own the lock). All three by default.
 *   allow   glob patterns; when non-empty, only matching tools survive.
 *   deny    glob patterns; removed after `allow`.
 *
 * Visibility is not authorisation: a hidden tool can still be called by name, and the
 * write boundary is enforced per call.
 */

export type ToolLayer = "readonly" | "write" | "low";

export const ALL_LAYERS: readonly ToolLayer[] = ["readonly", "write", "low"];

export interface ToolFilter {
  readonly layers?: readonly ToolLayer[];
  /** When non-empty, only matching tools are listed. */
  readonly allow?: readonly string[];
  /** Removes matches after `allow` has been applied. */
  readonly deny?: readonly string[];
}

/** What the filter needs to know about a tool; kept minimal so tests need no registry. */
export interface ToolShape {
  readonly effect: "read" | "write";
}

const toPattern = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
};

/** Compiles once per config load rather than per tool. */
export function compileToolFilter(
  filter: ToolFilter,
  shapeOf: (name: string) => ToolShape | undefined,
): (name: string) => boolean {
  const layers = new Set<ToolLayer>(filter.layers ?? ALL_LAYERS);
  const allow = (filter.allow ?? []).map(toPattern);
  const deny = (filter.deny ?? []).map(toPattern);

  return (name) => {
    if (/Low$/.test(name) && !layers.has("low")) return false;

    const shape = shapeOf(name);
    // A name the filter cannot classify is left to `allow`/`deny` rather than dropped:
    // silently hiding a tool because the metadata lookup failed is the worse failure.
    if (shape !== undefined) {
      if (shape.effect === "write" && !layers.has("write")) return false;
      if (shape.effect === "read" && !layers.has("readonly")) return false;
    }

    if (allow.length > 0 && !allow.some((pattern) => pattern.test(name))) return false;
    return !deny.some((pattern) => pattern.test(name));
  };
}

/** `true` when the filter exposes everything, so callers can skip the work. */
export function isPermissive(filter: ToolFilter): boolean {
  const layers = filter.layers ?? ALL_LAYERS;
  return (
    (filter.allow ?? []).length === 0 &&
    (filter.deny ?? []).length === 0 &&
    layers.length >= ALL_LAYERS.length
  );
}
