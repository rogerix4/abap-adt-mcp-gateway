/**
 * The tool registry.
 *
 * Every tool in the frozen contract is registered here, whether or not it has
 * an implementation yet. That is deliberate: `tools/list` must always return
 * the full 335-tool surface, and calling an unimplemented tool must produce a
 * clear error instead of "unknown tool" (which would look like a client bug).
 */

import { GatewayError, notImplemented, unknownTool } from "./errors.js";
import type { ToolEntry, ToolDefinition, ToolMeta } from "./types.js";

/** Per-call context. Planning and policy live here so handlers stay pure-ish. */
export interface ToolContext {
  /** System id from the `system` argument, resolved by the caller. */
  readonly system?: string | undefined;
  /** Abort signal, so long requests can be cancelled by the client. */
  readonly signal?: AbortSignal | undefined;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

export interface CoverageReport {
  readonly total: number;
  readonly implemented: number;
  readonly missing: readonly string[];
}

/** Used to tell the caller which phase will bring an unimplemented tool. */
export type PlannedPhaseResolver = (meta: ToolMeta) => string;

export interface RegistryOptions {
  /** Family → phase, so error messages can say "planned in P2" instead of "later". */
  readonly phaseOf?: PlannedPhaseResolver;
}

const DEFAULT_PHASE: PlannedPhaseResolver = () => "an unimplemented tool (run `node dist/bin.js --coverage`)";

export class ToolRegistry {
  readonly #entries = new Map<string, ToolEntry>();
  readonly #handlers = new Map<string, ToolHandler>();
  readonly #phaseOf: PlannedPhaseResolver;

  constructor(
    definitions: readonly ToolDefinition[],
    metas: ReadonlyMap<string, ToolMeta>,
    options: RegistryOptions = {},
  ) {
    this.#phaseOf = options.phaseOf ?? DEFAULT_PHASE;

    for (const definition of definitions) {
      const meta = metas.get(definition.name);
      if (meta === undefined) {
        throw new Error(
          `tool "${definition.name}" has no metadata; run "npm run gen:layer-map"`,
        );
      }
      this.#entries.set(definition.name, { definition, meta });
    }
  }

  /** All entries, in catalog order — the order clients see in `tools/list`. */
  list(): ToolEntry[] {
    return [...this.#entries.values()];
  }

  get(name: string): ToolEntry | undefined {
    return this.#entries.get(name);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /**
   * True when a handler is already registered for this tool. The route table uses it to
   * leave a tool alone when a family or the read module owns it.
   */
  hasHandler(name: string): boolean {
    return this.#handlers.has(name);
  }

  /** Registers an implementation. Registering twice is a programming error. */
  register(name: string, handler: ToolHandler): void {
    if (!this.#entries.has(name)) {
      throw new Error(`cannot register handler for unknown tool "${name}"`);
    }
    if (this.#handlers.has(name)) {
      throw new Error(`duplicate handler registration for tool "${name}"`);
    }
    this.#handlers.set(name, handler);
  }

  coverage(): CoverageReport {
    const missing = [...this.#entries.keys()].filter((name) => !this.#handlers.has(name));
    return {
      total: this.#entries.size,
      implemented: this.#entries.size - missing.length,
      missing,
    };
  }

  /**
   * Runs a tool. Policy checks (system allow-list, read-only tiers, visibility)
   * run before this point; by the time we get here the call is permitted.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw unknownTool(name, "The tool contract is fixed at 335 tools; check the name.");
    }

    const handler = this.#handlers.get(name);
    if (handler === undefined) {
      throw notImplemented(name, this.#phaseOf(entry.meta));
    }

    const stray = unknownArguments(entry, args);
    if (stray.length > 0) {
      throw new GatewayError(
        "INVALID_ARGUMENT",
        `${name} does not take ${stray.map((key) => `"${key}"`).join(", ")}.`,
        {
          // Measured on the reference system (2026-11-04): `CreateProgram` was called with a
          // `source_code` it does not declare. The argument was dropped on the floor,
          // SAP created the object with its own template, and the empty result looked
          // like "the source was written". Silence is the bug; say what is accepted.
          unknown: stray.join(", "),
          accepted: Object.keys(entry.definition.inputSchema.properties ?? {}).join(", "),
          nextAction: "Re-send the call with declared arguments only; see `accepted`.",
        },
      );
    }

    return handler(args, ctx);
  }
}

/** The `system` argument is transport-level: every tool receives it, none declares it. */
const TRANSPORT_ARGUMENTS: ReadonlySet<string> = new Set(["system"]);

/** Declared-but-unsupported keys are a caller bug, not something to ignore. */
function unknownArguments(entry: ToolEntry, args: Record<string, unknown>): readonly string[] {
  const schema = entry.definition.inputSchema;
  const properties = schema.properties as Record<string, unknown> | null | undefined;
  // A tool that says "anything goes" gets anything.
  if (properties === undefined || properties === null || schema.additionalProperties === true) return [];
  return Object.keys(args).filter((key) => !TRANSPORT_ARGUMENTS.has(key) && !(key in properties));
}
