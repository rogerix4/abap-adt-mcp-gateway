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

function validateLayer(name: string, data: unknown): Layer {
  const parsed = ConfigPatchSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(name, describeIssues(parsed.error));
  }
  return { name, data: parsed.data as Record<string, unknown> };
}

function fileLayer(
  name: string,
  path: string,
  readFile: (path: string) => string | undefined,
): Layer | undefined {
  const text = readFile(path);
  if (text === undefined) return undefined;
  const parsed = parseJsonc(text, `${name} config (${path})`);
  return validateLayer(`${name} config (${path})`, parsed);
}

export function loadConfig(options: LoadConfigOptions = {}): EffectiveConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const cli = options.cli ?? {};
  const readFile = options.readFile ?? defaultReadFile;

  const layers: Layer[] = [validateLayer("defaults", defaultConfig() as unknown)];

  const userLayer = fileLayer("user", options.userPath ?? userConfigPath(), readFile);
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
    const layer = fileLayer("workspace", absolute, readFile);
    if (layer !== undefined) layers.push(layer);
  }

  const envLayer = environmentLayer(env);
  if (envLayer !== undefined) layers.push(envLayer);

  const cliLayer = commandLineLayer(cli);
  if (cliLayer !== undefined) layers.push(cliLayer);

  if (cli.configPath !== undefined) {
    const explicit = fileLayer("--config", resolve(cwd, cli.configPath), readFile);
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
  return validateLayer("environment", patch);
}

function commandLineLayer(cli: CliOverrides): Layer | undefined {
  const patch: Record<string, unknown> = {};

  if (cli.system !== undefined && cli.system.length > 0) patch["defaultSystem"] = cli.system;
  if (cli.logLevel !== undefined && cli.logLevel.length > 0) patch["server"] = { logLevel: cli.logLevel };

  if (Object.keys(patch).length === 0) return undefined;
  return validateLayer("command line", patch);
}
