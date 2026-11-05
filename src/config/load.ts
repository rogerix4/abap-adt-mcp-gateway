/**
 * Configuration loading.
 *
 * Layers, lowest priority first:
 *   defaults -> user config -> workspace config -> environment -> command line
 *
 * Every layer is validated on its own, so a mistake is reported with the layer
 * name and field path rather than silently disappearing during the merge.
 * Nothing is resolved to a real secret here — this module only produces the
 * effective configuration, with credentials still as references.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ZodError } from "zod";

import { defaultConfig, userConfigPath } from "./defaults.js";
import { advertisesFacade, EXPOSE_LEVELS, type ExposeLevel } from "../engine/expose.js";
import { parseJsonc } from "./jsonc.js";
import { mergeLayer } from "./merge.js";
import { ConfigPatchSchema, EffectiveConfigSchema, type EffectiveConfig, type Tier } from "./schema.js";

export class ConfigError extends Error {
  readonly layer: string;
  readonly issues: readonly string[];

  constructor(layer: string, issues: readonly string[]) {
    super(`${layer}: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.layer = layer;
    this.issues = issues;
  }
}

export interface CliOverrides {
  readonly configPath?: string;
  readonly system?: string;
  readonly logLevel?: string;
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cli?: CliOverrides;
  /** Overrides the user-level config location (tests, portable installs). */
  readonly userPath?: string;
  readonly readFile?: (path: string) => string | undefined;
  /** Receives deprecation notices; the server prints them on stderr at startup. */
  readonly onWarning?: (message: string) => void;
}

interface Layer {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

/** Environment variables that map onto config fields. */
const ENV_DEFAULT_SYSTEM = "ABAP_ADT_MCP_DEFAULT_SYSTEM";
const ENV_LOG_LEVEL = "ABAP_ADT_MCP_LOG_LEVEL";

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Directory the package is installed in: `dist/config/load.js` → two levels up.
 *
 * Used to find the config when the server is spawned by an MCP client, which sets the
 * working directory to the editor's workspace rather than to the package.
 */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function describeIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The layer sets a level stands for; everything else becomes `full`. */
const LEGACY_LEVELS: Readonly<Record<string, ExposeLevel>> = {
  "": "none",
  readonly: "readonly",
  write: "write",
  low: "low",
  "readonly+write": "high",
  "readonly+write+low": "full",
};

/**
 * Maps the deprecated `toolPolicy.layers` / `toolPolicy.gateway` onto `toolPolicy.expose`.
 *
 * Done per layer, before the merge, so the merge only ever sees one shape. `allow` and
 * `deny` keep their place, so only the level has to be derived. A combination with no
 * exact level becomes `full` — a superset, because silently dropping tools is the worse
 * failure — and the warning names what changed.
 */
function normaliseToolPolicy(layerName: string, data: Record<string, unknown>, warn: (message: string) => void): void {
  const policy = data["toolPolicy"];
  if (!isPlainObject(policy)) return;

  const legacyLayers = policy["layers"];
  const legacyGateway = policy["gateway"];
  if (legacyLayers === undefined && legacyGateway === undefined) return;

  const kinds = new Set<string>(
    Array.isArray(legacyLayers) ? (legacyLayers as string[]) : ["readonly", "write", "low"],
  );
  const key = ["readonly", "write", "low"].filter((kind) => kinds.has(kind)).join("+");
  const level: ExposeLevel =
    key.length === 0 ? (legacyGateway === true ? "gateway" : "none") : (LEGACY_LEVELS[key] ?? "full");

  policy["expose"] = level;
  delete policy["layers"];
  delete policy["gateway"];

  const legacyName = [
    legacyLayers === undefined ? "" : "toolPolicy.layers",
    legacyGateway === undefined ? "" : "toolPolicy.gateway",
  ]
    .filter((name) => name.length > 0)
    .join(" / ");

  let note = `"${level}" was used`;
  if (key.length > 0 && LEGACY_LEVELS[key] === undefined) {
    note = `no level matches ${key}; "${level}" was used instead (a superset)`;
  } else if (legacyGateway === false && advertisesFacade(level)) {
    note = `"${level}" was used; it also advertises the three Gateway* tools, which gateway: false removed`;
  } else if (legacyGateway === true && !advertisesFacade(level)) {
    note = `"${level}" was used; it does not advertise the three Gateway* tools (pick "core" or "gateway" for those)`;
  }

  warn(
    `${layerName}: ${legacyName} is deprecated and was applied as toolPolicy.expose: ${note}. ` +
      `Move the setting to toolPolicy.expose (levels: ${EXPOSE_LEVELS.join(", ")}).`,
  );
}

function validateLayer(name: string, data: unknown, warn: (message: string) => void): Layer {
  const parsed = ConfigPatchSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(name, describeIssues(parsed.error));
  }
  const patch = parsed.data as Record<string, unknown>;
  normaliseToolPolicy(name, patch, warn);
  return { name, data: patch };
}

function fileLayer(
  name: string,
  path: string,
  readFile: (path: string) => string | undefined,
  warn: (message: string) => void,
): Layer | undefined {
  const text = readFile(path);
  if (text === undefined) return undefined;
  const parsed = parseJsonc(text, `${name} config (${path})`);
  return validateLayer(`${name} config (${path})`, parsed, warn);
}

export function loadConfig(options: LoadConfigOptions = {}): EffectiveConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const cli = options.cli ?? {};
  const readFile = options.readFile ?? defaultReadFile;
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };

  const layers: Layer[] = [validateLayer("defaults", defaultConfig() as unknown, warn)];

  const userLayer = fileLayer("user", options.userPath ?? userConfigPath(), readFile, warn);
  if (userLayer !== undefined) layers.push(userLayer);

  // Both names are read: the README tells people to create `adt-mcp.config.jsonc` in the
  // project, while `--config`-less runs of a shared setup put it in `.adt-mcp/config.jsonc`.
  // Reading only one of them is how a configured server starts with "no systems configured".
  //
  // The installation directory is searched too. An MCP client spawns the server with its
  // own working directory (the editor's workspace, not the package), so a config that only
  // exists next to the package would otherwise be invisible: the server would start with no
  // systems and the full tool list, which is exactly what "why is it all 335 tools again"
  // looks like from the outside.
  const candidates = [
    join(cwd, "adt-mcp.config.jsonc"),
    join(cwd, ".adt-mcp", "config.jsonc"),
    join(packageRoot(), "adt-mcp.config.jsonc"),
    join(packageRoot(), ".adt-mcp", "config.jsonc"),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const layer = fileLayer("workspace", absolute, readFile, warn);
    if (layer !== undefined) layers.push(layer);
  }

  const envLayer = environmentLayer(env);
  if (envLayer !== undefined) layers.push(envLayer);

  const cliLayer = commandLineLayer(cli);
  if (cliLayer !== undefined) layers.push(cliLayer);

  if (cli.configPath !== undefined) {
    const explicit = fileLayer("--config", resolve(cwd, cli.configPath), readFile, warn);
    if (explicit === undefined) {
      throw new ConfigError("--config", [`file not found: ${resolve(cwd, cli.configPath)}`]);
    }
    layers.push(explicit);
  }

  const merged = layers.reduce<Record<string, unknown>>(
    (accumulator, layer) => mergeLayer(accumulator, layer.data),
    {},
  );

  applyTierDefaults(merged);

  const effective = EffectiveConfigSchema.safeParse(merged);
  if (!effective.success) {
    throw new ConfigError("merged configuration", describeIssues(effective.error));
  }

  assertDefaultSystemExists(effective.data);

  for (const warning of warnings) options.onWarning?.(warning);

  return effective.data;
}

/** Missing tier means "treat as production": the safe side of a typo. */
function applyTierDefaults(merged: Record<string, unknown>): void {
  const systems = merged["systems"];
  if (!Array.isArray(systems)) return;
  for (const system of systems as Record<string, unknown>[]) {
    if (system["tier"] === undefined) system["tier"] = "prd" satisfies Tier;
  }
}

function assertDefaultSystemExists(config: EffectiveConfig): void {
  if (config.defaultSystem === undefined) return;
  const known = config.systems.some((system) => system.id === config.defaultSystem);
  if (!known) {
    throw new ConfigError("merged configuration", [
      `defaultSystem: "${config.defaultSystem}" is not one of the configured systems (${config.systems
        .map((system) => system.id)
        .join(", ") || "none"})`,
    ]);
  }
}

function environmentLayer(env: NodeJS.ProcessEnv): Layer | undefined {
  const patch: Record<string, unknown> = {};

  const defaultSystem = env[ENV_DEFAULT_SYSTEM];
  if (defaultSystem !== undefined && defaultSystem.length > 0) patch["defaultSystem"] = defaultSystem;

  const logLevel = env[ENV_LOG_LEVEL];
  if (logLevel !== undefined && logLevel.length > 0) patch["server"] = { logLevel };

  if (Object.keys(patch).length === 0) return undefined;
  return validateLayer("environment", patch, () => {});
}

function commandLineLayer(cli: CliOverrides): Layer | undefined {
  const patch: Record<string, unknown> = {};

  if (cli.system !== undefined && cli.system.length > 0) patch["defaultSystem"] = cli.system;
  if (cli.logLevel !== undefined && cli.logLevel.length > 0) patch["server"] = { logLevel: cli.logLevel };

  if (Object.keys(patch).length === 0) return undefined;
  return validateLayer("command line", patch, () => {});
}
