/**
 * Default configuration.
 *
 * The defaults must be usable with no config file at all: no systems, nothing
 * contacted. Anything that would make the gateway reach out to a network on its
 * own stays out of here.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { EffectiveConfig } from "./schema.js";

function configHome(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData.length > 0) return appData;
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.length > 0) return xdg;
  return join(homedir(), ".config");
}

/** Where the user-level config lives on this machine. */
export function userConfigPath(): string {
  return join(configHome(), "abap-adt-mcp-gateway", "config.jsonc");
}

export const defaultConfig = (): EffectiveConfig => ({
  server: {
    name: "abap-adt-mcp-gateway",
    logLevel: "info",
  },
  toolPolicy: {
    timeoutMs: 180_000,
    // One level picks the advertised set. `gateway` is the default because a client passes
    // a bounded list to the model (some stop at 128), and three tools that reach the whole
    // contract cost nothing: `full` is one argument away
    // (`src/engine/expose.ts` has every level and its count).
    expose: "gateway",
    allow: [],
    // Hidden, not deleted: ADT has no PUT and no DELETE on `/abapunit/runs/{id}` — measured
    //, both answer "405 Resource controller does not support method …" (the
    // discovery document lists no other run resource either). A tool that can only ever
    // fail is not worth a slot in the model's budget; it stays callable by name and answers
    // with that reason, so nothing is lost for a caller that insists.
    deny: ["UpdateUnitTest", "DeleteUnitTest"],
  },
  systems: [],
});
