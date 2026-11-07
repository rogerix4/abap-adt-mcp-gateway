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

  /**
   * Swaps the contract definitions in place, keeping handlers and metadata.
   *
   * Used to pick up an edited `tools/catalog.json` on the next `tools/list` without
 * restarting the process (: the client had no restart action for this
   * server, so a schema extension needed a window reload). Only names the process
   * already registered are updated — the advertised surface never grows or shrinks
   * at runtime, it only re-describes itself.
   */
  reloadDefinitions(definitions: readonly ToolDefinition[]): number {
    let updated = 0;
    for (const definition of definitions) {
      const existing = this.#entries.get(definition.name);
      if (existing === undefined) continue;
      this.#entries.set(definition.name, { definition, meta: existing.meta });
      updated += 1;
    }
    return updated;
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

    // Stray arguments first: `UpdateTable {table_name, source_code}` is a caller that used
    // the wrong *spelling*, and "does not take source_code" says that; answering "missing
    // ddl_code" instead would describe the same mistake as if an argument were forgotten.
    const stray = unknownArguments(entry, args);
    if (stray.length > 0) {
      throw new GatewayError(
        "INVALID_ARGUMENT",
        `${name} does not take ${stray.map((key) => `"${key}"`).join(", ")}.`,
        {
          // Measured on the reference system: `CreateProgram` was called with a
          // `source_code` it does not declare. The argument was dropped on the floor,
          // SAP created the object with its own template, and the empty result looked
          // like "the source was written". Silence is the bug; say what is accepted.
          unknown: stray.join(", "),
          accepted: Object.keys(entry.definition.inputSchema.properties ?? {}).join(", "),
          nextAction: "Re-send the call with declared arguments only; see `accepted`.",
        },
      );
    }

    const missing = missingArguments(entry, args);
    if (missing.length > 0) {
      throw new GatewayError(
        "INVALID_ARGUMENT",
        `${name}: missing ${missing.map((key) => `"${key}"`).join(", ")}.`,
        {
          // Two live measurements, one class of bug: `CreateProgram {program_name}` created
          // the object in `$TMP` although the schema requires `package_name`, and
          // `CreateProgramLow {program_name, package_name}` defaulted a
          // missing `description` to the object name (same run). Both were listed under
          // `required` and enforced nowhere, so the contract promised a check that no code
          // performed — and the caller got an object it never described.
          missing: missing.join(", "),
          accepted: Object.keys(entry.definition.inputSchema.properties ?? {}).join(", "),
          nextAction: "Send every argument the contract lists under `required`; see `accepted` for the names this tool declares.",
        },
      );
    }

    const outside = outsideEnum(entry, args);
    if (outside !== undefined) {
      throw new GatewayError(
        "INVALID_ARGUMENT",
        `${name}: "${outside.argument}" must be one of ${outside.allowed.map((v) => JSON.stringify(v)).join(", ")}; got ${JSON.stringify(outside.value)}.`,
        {
          // Measured on the reference system: `CreateProgram` with
          // `program_type: "report"` was accepted although the schema lists only
          // `executable | include | module_pool | function_group | class_pool | interface_pool`.
          // The object was created with the *default* type, so the caller's word was
          // ignored — the same silence the stray-argument check above exists to end.
          // An enum is a promise the schema makes to the caller; nothing else enforces it.
          argument: outside.argument,
          value: outside.value,
          allowed: outside.allowed,
          nextAction: "Send one of the listed values — the contract's enum is the whole set.",
        },
      );
    }

    return handler(args, ctx);
  }
}

/** The `system` argument is transport-level: every tool receives it, none declares it. */
const TRANSPORT_ARGUMENTS: ReadonlySet<string> = new Set(["system"]);

/**
 * Contract-required arguments a tool implements as "absent means partial, and says so".
 *
 * `CreateInclude` is the only such case: without `main_program` the include is still
 * created, and the answer carries `insert_note: "main_program is required to register
 * the include"` — the argument is not dropped silently, it is reported, so refusing the
 * call would remove a working two-step path (create now, wire the main program later).
 * Everything else the contract lists under `required` is enforced above.
 */
const PARTIAL_WHEN_ABSENT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["CreateInclude", new Set(["main_program"])],
]);

/**
 * Declared-as-required but absent from the call.
 *
 * Only `undefined` / `null` count. An empty string is a value the caller chose to send,
 * and turning it into "missing" would reject calls the schema allows.
 */
function missingArguments(entry: ToolEntry, args: Record<string, unknown>): readonly string[] {
  const required = entry.definition.inputSchema.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  const partial = PARTIAL_WHEN_ABSENT.get(entry.meta.name) ?? new Set<string>();
  return required.filter(
    (key) =>
      !TRANSPORT_ARGUMENTS.has(key) &&
      !partial.has(key) &&
      (args[key] === undefined || args[key] === null),
  );
}

/**
 * Arguments whose handler deliberately accepts more words than the schema's enum.
 *
 * `object_type` has aliases (`FUGR` → `FUNCTION_GROUP`, and the shorthand names in
 * `HANDLER_TYPE_ALIASES` / `WHERE_USED_PATHS`), and its resolver already refuses an
 * unknown value with a message that lists what it knows. Checking the enum first would
 * reject a working alias and replace a better message with a worse one.
 */
const ENUM_EXEMPT: ReadonlySet<string> = new Set(["object_type"]);

/**
 * The first declared-but-out-of-enum argument, if any.
 *
 * Only `enum` is checked here. `required` needs a message that says what the value is
 * for (a package is `$TMP` or a real package *plus* a transport request), and that lives
 * with the family that owns the argument; `type` is deliberately loose because families
 * normalise numbers to strings.
 *
 * Matching is case-insensitive: `binding_type: "odatav2"` used to work because the family
 * upper-cases it, and an enum check must not take that away.
 */
function outsideEnum(
  entry: ToolEntry,
  args: Record<string, unknown>,
): { readonly argument: string; readonly value: unknown; readonly allowed: readonly unknown[] } | undefined {
  const properties = entry.definition.inputSchema.properties as
    | Record<string, { readonly enum?: readonly unknown[] }>
    | null
    | undefined;
  if (properties === undefined || properties === null) return undefined;
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (ENUM_EXEMPT.has(key)) continue;
    const allowed = spec?.enum;
    if (!Array.isArray(allowed) || allowed.length === 0) continue;
    const matched = allowed.some((candidate) =>
      typeof candidate === "string" && typeof value === "string"
        ? candidate.toLowerCase() === value.toLowerCase()
        : candidate === value,
    );
    if (matched) continue;
    return { argument: key, value, allowed };
  }
  return undefined;
}

/** Declared-but-unsupported keys are a caller bug, not something to ignore. */
function unknownArguments(entry: ToolEntry, args: Record<string, unknown>): readonly string[] {
  const schema = entry.definition.inputSchema;
  const properties = schema.properties as Record<string, unknown> | null | undefined;
  // A tool that says "anything goes" gets anything.
  if (properties === undefined || properties === null || schema.additionalProperties === true) return [];
  return Object.keys(args).filter((key) => !TRANSPORT_ARGUMENTS.has(key) && !(key in properties));
}
