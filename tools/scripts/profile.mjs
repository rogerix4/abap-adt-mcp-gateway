/**
 * One way for the scripts to find a system's logon, the same one the server uses.
 *
 * The tools and the offline scripts must not drift to different sources of truth: the
 * server reads `adt-mcp.config.jsonc` and resolves `keychain:`/`env:`/`file:` references,
 * so a script that reads a `.env` file instead can be pointed at a different host than the
 * server it is testing. This helper resolves through the config first and only falls back
 * to a `.env` file when the argument is a path.
 *
 * Usage in a script:
 *   const profile = await loadProfile(arg("--profile"));   // a system id, or a path to .env
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const parseEnvFile = (path) => {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].split(/\s+#/)[0].replace(/^["']|["']$/g, "").trim();
  }
  return out;
};

/**
 * Resolves a profile.
 *
 * @param nameOrPath a system id from `adt-mcp.config.jsonc`, or the path of a `.env` file
 * @param root repository root (where the built code lives)
 */
export async function loadProfile(nameOrPath, root = process.cwd()) {
  if (typeof nameOrPath !== "string" || nameOrPath.length === 0) {
    throw new Error("profile: pass a system id (from adt-mcp.config.jsonc) or the path of a .env file");
  }

  if (existsSync(nameOrPath)) {
    const env = parseEnvFile(nameOrPath);
    for (const key of ["SAP_URL", "SAP_CLIENT", "SAP_USERNAME", "SAP_PASSWORD"]) {
      if (env[key] === undefined || env[key].length === 0) {
        throw new Error(`profile: ${nameOrPath} is missing ${key}`);
      }
    }
    return {
      id: nameOrPath,
      url: env.SAP_URL,
      client: env.SAP_CLIENT,
      language: env.SAP_LANGUAGE ?? "EN",
      username: env.SAP_USERNAME,
      password: env.SAP_PASSWORD,
      tier: (env.SAP_TIER ?? "DEV").toUpperCase(),
      source: "env-file",
    };
  }

  const load = (relative) => import(pathToFileURL(join(root, "dist", relative)).href);
  const { loadConfig } = await load("config/load.js");
  const { resolveSystemSecrets } = await load("config/secrets.js");

  const config = loadConfig({});
  const system = config.systems.find((entry) => entry.id === nameOrPath);
  if (system === undefined) {
    throw new Error(
      `profile: "${nameOrPath}" is not a system id in the config (have: ${config.systems
        .map((entry) => entry.id)
        .join(", ")})`,
    );
  }
  const resolved = (await resolveSystemSecrets(config)).find((entry) => entry.id === nameOrPath) ?? undefined;
  if (resolved === undefined) {
    throw new Error(`profile: credentials for "${nameOrPath}" could not be resolved`);
  }
  return {
    id: system.id,
    url: system.endpoint.url,
    client: system.endpoint.client,
    language: system.endpoint.language ?? "EN",
    username: resolved.auth.username,
    password: resolved.auth.password,
    tier: String(system.tier).toUpperCase(),
    source: "config",
  };
}
