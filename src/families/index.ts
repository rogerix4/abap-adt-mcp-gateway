/**
 * Session tool and family registration.
 *
 * `GetSession` exists in the contract because the low-level verbs take a
 * `session_id`. Here a session id identifies the system's session rather than
 * creating a new one — that is what makes `Lock*Low` + `Update*Low` work as a
 * pair, since a lock handle is only valid in the session that created it.
 */

import type { ToolRegistry } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import { registerFamily } from "./handlers.js";
import { textFamilies, xmlFamilies } from "./descriptors.js";
import { programFamily } from "./program.js";
import { registerReadTools } from "../tools/read.js";
import { registerHandlerTools } from "../tools/handler-dispatch.js";
import { registerTableToolRoutes } from "../tools/routes.js";
import { registerBridgeTools } from "../tools/bridges.js";
import { registerSmartFormTools } from "../tools/smartforms.js";
import { registerAbapAnalysisTools } from "../tools/abap-analysis.js";
import type { ObjectFamily } from "./types.js";

/** Families whose descriptors are complete and measured. */
export const implementedFamilies: readonly ObjectFamily[] = [programFamily, ...textFamilies, ...xmlFamilies];

export function registerFamilies(registry: ToolRegistry, runtime: GatewayRuntime): void {
  for (const family of implementedFamilies) {
    registerFamily({ registry, runtime, family });
  }
  registerSessionTool(registry, runtime);
  registerReadTools(registry, runtime);
  registerHandlerTools(registry, runtime);
  registerBridgeTools(registry, runtime);
  registerSmartFormTools(registry, runtime);
  registerAbapAnalysisTools(registry, runtime);
  registerTableToolRoutes(registry, runtime);
}

export function registerSessionTool(registry: ToolRegistry, runtime: GatewayRuntime): void {
  if (!registry.has("GetSession")) return;

  registry.register("GetSession", async (args, ctx) => {
    const forceNew = args["force_new"] === true;
    const system = runtime.resolve(ctx.system, undefined, false).system;

    if (forceNew) runtime.resetSession(system);

    const resolved = runtime.resolve(system, undefined, false);

    // Report the session as it actually is: connection id, CSRF token, cookies and
    // the number of locks still held. This contacts SAP once (the CSRF fetch is the
    // logon), which is the point — an empty snapshot told the caller nothing.
    let state: { connection_id: string; csrf_token: string; cookies: string; open_locks: number } | undefined;
    let loggedOn = false;
    let error: string | undefined;
    try {
      state = await resolved.session.describe();
      loggedOn = true;
    } catch (failure) {
      error = String((failure as Error).message ?? failure);
    }

    return {
      success: error === undefined,
      session_id: resolved.sessionId,
      session_state: state ?? { connection_id: "", csrf_token: "", cookies: "", open_locks: 0 },
      logged_on: loggedOn,
      ...(error === undefined ? {} : { error }),
      system,
      force_new: forceNew,
    };
  });
}
