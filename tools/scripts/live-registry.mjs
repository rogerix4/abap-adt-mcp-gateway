/**
 * One way for the live scripts to reach a system through the gateway's own tool layer.
 *
 * `live-families.mjs` and `live-tools.mjs` both need the same three things: a registry wired to
 * the profile's credentials, an argument filter that respects the declared schema, and a record of
 * which tools were really called. Keeping them here means the coverage report of one script can be
 * compared with the other's without either re-implementing the wiring.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The declared schema of a registered tool. */
export function schemaOf(registry, tool) {
  return registry.get(tool)?.definition?.inputSchema ?? { properties: {}, required: [] };
}

/**
 * Drops the keys a verb does not declare, and refuses a call whose required keys are absent.
 *
 * The families do not share one argument set — `UpdateTable` takes `ddl_code` where `UpdateProgram`
 * takes `source_code`, `UnlockClassLow` has no `session_id`, `ValidateFunctionModuleLow` has no
 * `package_name` — so one hand-written argument set per verb cannot be right for every family.
 * Filtering keeps the fixture readable; a missing required key fails loudly as a fixture bug
 * instead of hiding behind a generic 400 from SAP.
 */
export function conform(registry, tool, args) {
  const schema = schemaOf(registry, tool);
  const keys = new Set(Object.keys(schema.properties ?? {}));
  const kept = Object.fromEntries(Object.entries(args).filter(([key]) => keys.has(key)));
  const missing = (schema.required ?? []).filter((key) => kept[key] === undefined);
  if (missing.length > 0) throw new Error(`fixture is missing ${missing.join(", ")} for ${tool}`);
  return kept;
}

/**
 * Opens a registry for one system id (or `.env` path) and returns the call helper.
 *
 * @param {{ profile: string, root?: string }} options
 */
export async function openLive({ profile, root = process.cwd() }) {
  const load = (relative) => import(pathToFileURL(join(root, "dist", relative)).href);
  const { loadProfile } = await import(pathToFileURL(join(root, "tools", "scripts", "profile.mjs")).href);
  const { createRegistry } = await load("engine/create-registry.js");
  const { registerFamilies } = await load("families/index.js");
  const { GatewayRuntime } = await load("runtime.js");
  const { AdtSession } = await load("adt/session.js");

  const resolved = await loadProfile(profile, root);
  const system = {
    id: "live",
    tier: (resolved.tier ?? "DEV").toLowerCase(),
    endpoint: {
      url: resolved.url,
      client: resolved.client,
      language: resolved.language ?? "EN",
      systemType: "onprem",
    },
    auth: { type: "basic", username: resolved.username, password: resolved.password },
    rfcBackend: "soap",
    env: {},
  };
  const runtime = new GatewayRuntime([system], (entry) =>
    new AdtSession({
      url: entry.endpoint.url,
      client: entry.endpoint.client,
      language: entry.endpoint.language,
      username: resolved.username,
      password: resolved.password,
      timeoutMs: 180_000,
    }),
  );
  const registry = createRegistry();
  registerFamilies(registry, runtime);

  const attempted = new Set();
  const call = (tool, args = {}) => {
    attempted.add(tool);
    return registry.call(tool, conform(registry, tool, args), { system: "live" });
  };

  return {
    registry,
    call,
    attempted,
    has: (tool) => registry.has(tool),
    /** `write` for anything that changes the system, from the same metadata `tools/list` uses. */
    effectOf: (tool) => registry.get(tool)?.meta?.effect ?? "unknown",
    /**
     * Ends every ABAP session this run opened.
     *
     * Create/activate/delete of a Z object leaves SAP's generation enqueue (`E_ABAP_GENPH`) and
     * DDIC activation locks behind, and they belong to the *stateful session*, not to the request:
     * a client that just exits leaves them in SM12 until the session times out (measured
 *: one coverage run left thirty of them). The logoff is what releases them.
     */
    closeAll: () => runtime.closeAll(),
    profile: resolved,
    tier: system.tier,
  };
}
