/**
 * Exposure — what one client is shown, decided in one place.
 *
 * A client passes only a bounded number of tools to the model (some stop at 128), so a
 * 335-tool list quietly costs the agent whatever did not fit. `toolPolicy.expose` picks
 * one **level**, and `allow` / `deny` narrow it: keep only matches, then drop matches.
 *
 * Every named tool has exactly one kind, so the levels partition the contract:
 *
 *   kind        what it is                                        tools
 *   readonly    reads                                             115
 *   write       creates / updates / deletes / activates            86
 *   low         the `*Low` variants (the caller owns the lock)    134
 *
 * Levels are the menu; the three single-kind levels are the parts, the rest are
 * combinations:
 *
 *   none        nothing at all                                      0
 *   gateway     `full` as three tools — the whole contract reachable  3 advertised, 335 reachable
 *   readonly    the readonly kind                                  115
 *   write       the write kind                                      86
 *   low         the low kind                                       134
 *   high        readonly + write                                   201
 *   full        every named tool                                   335
 *   core        a curated subset for everyday ABAP work            124 (+3 facade = 127)
 *
 * `gateway` is `full` compressed: the same reach, advertised as three tools. `core` keeps
 * the facade because it narrows the list — without it, everything left out would be
 * unreachable. Levels that already advertise everything (`full`) or nothing but one kind
 * do not, so the facade never becomes a way around a narrow level.
 *
 * Visibility is not authorisation: a hidden tool can still be called by name, and the
 * write boundary is enforced per call from the system's `tier`.
 */

export type ToolKind = "readonly" | "write" | "low";

export type ExposeLevel = "none" | "gateway" | "readonly" | "write" | "low" | "high" | "full" | "core";

export const EXPOSE_LEVELS: readonly ExposeLevel[] = [
  "none",
  "gateway",
  "readonly",
  "write",
  "low",
  "high",
  "full",
  "core",
];

/** What a level is made of. */
interface LevelDefinition {
  /** Kinds of named tool this level advertises. */
  readonly kinds: readonly ToolKind[];
  /** Also advertise the three `Gateway*` tools. */
  readonly facade?: boolean;
  /** Patterns this level keeps to, applied before the caller's `allow`. */
  readonly keep?: readonly string[];
  /** Patterns this level drops, applied together with the caller's `deny`. */
  readonly drop?: readonly string[];
}

/** Object types an ABAP developer edits in a normal week. */
const CORE_SUBJECTS = [
  "Program",
  "Include",
  "Class",
  "Interface",
  "FunctionGroup",
  "FunctionModule",
  "Table",
  "Structure",
  "DataElement",
  "Domain",
  "View",
  "MetadataExtension",
  "BehaviorDefinition",
  "BehaviorImplementation",
  "ServiceDefinition",
  "ServiceBinding",
  "Screen",
  "GuiStatus",
  "TextElement",
];

/** Tools whose subject is not an object type but that the work needs. */
const CORE_EXTRAS = [
  "SearchObject",
  "GetObjectInfo",
  "GetObjectStructure",
  "GetTypeInfo",
  "GetPackageContents",
  "GetPackageTree",
  "GetWhereUsed",
  "GetProgFullCode",
  "GetInactiveObjects",
  "GetSqlQuery",
  "GetTableContents",
  "GetObjectsByType",
  "ActivateObjects",
  "GetTransport",
  "ListTransports",
  "CreateTransport",
  "GetSession",
  "RunUnitTest",
  "GetUnitTest",
  "GetUnitTestResult",
  "GetUnitTestStatus",
  "GetTcodeUsage",
  "GetJobUsage",
  "RuntimeListDumps",
  "RuntimeGetDumpById",
  "RuntimeAnalyzeDump",
];

const LEVEL_DEFINITIONS: Readonly<Record<ExposeLevel, LevelDefinition>> = {
  none: { kinds: [] },
  gateway: { kinds: [], facade: true },
  readonly: { kinds: ["readonly"] },
  write: { kinds: ["write"] },
  low: { kinds: ["low"] },
  high: { kinds: ["readonly", "write"] },
  full: { kinds: ["readonly", "write", "low"] },
  core: {
    kinds: ["readonly", "write"],
    facade: true,
    keep: [...CORE_EXTRAS, ...CORE_SUBJECTS.map((subject) => `*${subject}`)],
    // `*View` also catches the dump / profiler handler tools, which are not object views.
    drop: ["Handler*"],
  },
};

/** A level plus what the caller narrows it with. */
export interface Expose {
  readonly level: ExposeLevel;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/** Default when a caller does not care: three tools that reach the whole contract. */
export const DEFAULT_EXPOSE: Expose = { level: "gateway" };

/** What the compiler needs to know about a tool; kept minimal so tests need no registry. */
export interface ToolShape {
  readonly effect: "read" | "write";
}

export function advertisesFacade(level: ExposeLevel): boolean {
  return LEVEL_DEFINITIONS[level].facade === true;
}

/** The kind of one named tool, or `undefined` when the caller cannot classify it. */
export function kindOf(name: string, shape: ToolShape | undefined): ToolKind | undefined {
  if (/Low$/.test(name)) return "low";
  if (shape === undefined) return undefined;
  return shape.effect === "write" ? "write" : "readonly";
}

/** How many kinds a level names — used by tests and tooling to spot an empty level. */
export function levelKinds(level: ExposeLevel): readonly ToolKind[] {
  return LEVEL_DEFINITIONS[level].kinds;
}

const toPattern = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

/**
 * Compiles one `(name) => visible` decision: kind gate, the level's own curation, the
 * caller's `allow`, then all denies. Compiled once per process, called per tool.
 */
export function compileExpose(
  expose: Expose,
  shapeOf: (name: string) => ToolShape | undefined,
): (name: string) => boolean {
  const definition = LEVEL_DEFINITIONS[expose.level];
  const kinds = new Set<ToolKind>(definition.kinds);
  const keep = (definition.keep ?? []).map(toPattern);
  const allow = (expose.allow ?? []).map(toPattern);
  const deny = [...(definition.drop ?? []), ...(expose.deny ?? [])].map(toPattern);

  return (name) => {
    const kind = kindOf(name, shapeOf(name));
    // A tool this process cannot classify would slip past every kind gate; a level that
    // names no kind must not become a hole, so it stays hidden there.
    if (kind === undefined ? kinds.size === 0 : !kinds.has(kind)) return false;
    if (keep.length > 0 && !keep.some((pattern) => pattern.test(name))) return false;
    if (allow.length > 0 && !allow.some((pattern) => pattern.test(name))) return false;
    return !deny.some((pattern) => pattern.test(name));
  };
}
