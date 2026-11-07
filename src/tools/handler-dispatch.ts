/**
 * The `Handler*` family: one verb, dispatched by `object_type`.
 *
 * The contract's Handler tools take `object_type` plus a per-type argument
 * (`program_name`, `class_name`, `table_name`, …) and are meant to be a uniform front
 * end over the same operations the per-object tools expose.
 *
 * Measured: they were wired straight to ADT routes with `bodyFrom: "body"`,
 * an argument no schema declares — so every call posted an empty body and SAP answered
 * `the system expected element '{…}objectReferences'` (or `{…}abapProgram`, `{…}checkObjectList`).
 * Here each call is re-dispatched to the tool that already knows the payload, with the
 * argument renamed to that tool's own spelling.
 */

import type { ToolRegistry } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import { GatewayError } from "../engine/errors.js";
import { activate, deleteObject, runCheck } from "../adt/lifecycle.js";

type Args = Record<string, unknown>;

interface Target {
  /** Tool-name infix of the family, e.g. `Program` in `GetProgram`. */
  readonly family: string;
  /** How this object type names the object in the contract. */
  readonly arg: string;
  /** `adtcore:type` for the activation request. */
  readonly adtType: string;
  /** Family name argument that the update verb uses, when it differs from `arg`. */
  readonly updateArg?: string;
}

const TARGETS: Readonly<Record<string, Target>> = {
  PROGRAM: { family: "Program", arg: "program_name", adtType: "PROG/P" },
  CLASS: { family: "Class", arg: "class_name", adtType: "CLAS/OC" },
  INTERFACE: { family: "Interface", arg: "interface_name", adtType: "INTF/OI" },
  TABLE: { family: "Table", arg: "table_name", adtType: "TABL/DT" },
  STRUCTURE: { family: "Structure", arg: "structure_name", adtType: "TABL/DS" },
  DOMAIN: { family: "Domain", arg: "domain_name", adtType: "DOMA/DD" },
  DATA_ELEMENT: { family: "DataElement", arg: "data_element_name", adtType: "DTEL/DE" },
  VIEW: { family: "CdsView", arg: "view_name", adtType: "DDLS/DF", updateArg: "view_name" },
  BEHAVIOR_DEFINITION: { family: "BehaviorDefinition", arg: "behavior_definition_name", adtType: "BDEF/BDO" },
  BEHAVIOR_IMPLEMENTATION: { family: "BehaviorImplementation", arg: "behavior_implementation_name", adtType: "CLAS/OC" },
  SERVICE_DEFINITION: { family: "ServiceDefinition", arg: "service_definition_name", adtType: "SRVD/SRV" },
  SERVICE_BINDING: { family: "ServiceBinding", arg: "service_binding_name", adtType: "SRVB/SVB" },
  PACKAGE: { family: "Package", arg: "package_name", adtType: "DEVC/K" },
};

function targetOf(args: Args, tool: string, verb: string): { readonly target: Target; readonly name: string } {
  const type = String(args["object_type"] ?? "").trim().toUpperCase();
  const target = TARGETS[type];
  if (target === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: unsupported object_type "${type}".`, {
      accepted: Object.keys(TARGETS).join(", "),
    });
  }
  // Measured: the contract names the object per type on Get/Create/Update/
  // Delete (`table_name`, `program_name`, …) but always `object_name` on Lock/Unlock/
  // Activate/CheckRun/Validate.
  const perType = verb === "Get" || verb === "Create" || verb === "Update" || verb === "Delete";
  const key = perType ? target.arg : "object_name";
  const name = String(args[key] ?? (perType ? "" : args[target.arg]) ?? "").trim();
  if (name.length === 0) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: missing "${key}" for ${type}.`);
  }
  return { target, name };
}

/** Copies only the arguments the target tool declares (the registry rejects the rest). */
function projectArgs(registry: ToolRegistry, tool: string, args: Args): Args {
  const properties = registry.get(tool)?.definition.inputSchema.properties as Record<string, unknown> | null | undefined;
  if (properties === undefined || properties === null) return { ...args };
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (key in properties) out[key] = value;
  }
  return out;
}

export function registerHandlerTools(registry: ToolRegistry, runtime: GatewayRuntime): void {
  /** Forwards a Verb<Family> call, renaming the object argument. */
  const forward = (handler: string, verb: string) => {
    if (!registry.has(handler)) return;
    registry.register(handler, async (args, ctx) => {
      const { target, name } = targetOf(args, handler, verb);
      const tool = `${verb}${target.family}${verb === "Lock" || verb === "Unlock" || verb === "Activate" || verb === "Validate" || verb === "Check" ? "Low" : ""}`;
      if (!registry.has(tool)) {
        throw new GatewayError("NOT_IMPLEMENTED", `${handler}: ${tool} is not available in this build.`);
      }
      const forwarded = projectArgs(registry, tool, args);
      forwarded[verb === "Update" ? target.updateArg ?? target.arg : target.arg] = name;
      return registry.call(tool, forwarded, ctx);
    });
  };

  forward("HandlerGet", "Get");
  forward("HandlerCreate", "Create");
  forward("HandlerUpdate", "Update");
  forward("HandlerDelete", "Delete");
  forward("HandlerLock", "Lock");
  forward("HandlerUnlock", "Unlock");
  forward("HandlerValidate", "Validate");

  // `HandlerTransportCreate` had the same empty-body problem; the real implementation
  // lives in `read.ts` and already builds the `tm:root` document.
  if (registry.has("HandlerTransportCreate") && registry.has("CreateTransport")) {
    registry.register("HandlerTransportCreate", async (args, ctx) =>
      registry.call("CreateTransport", projectArgs(registry, "CreateTransport", args), ctx),
    );
  }

  // `CreateTransportLow` has no `target_system` in its contract, and the upstream server
  // sends `tm:target="LOCAL"` for exactly this tool (user ruling: "write that
  // target the way upstream does"). A LOCAL request is what the command-line flows expect:
  // it is the same request without a target system, and the transport organizer still
  // answers with its number.
  if (registry.has("CreateTransportLow") && registry.has("CreateTransport")) {
    registry.register("CreateTransportLow", async (args, ctx) =>
      registry.call(
        "CreateTransport",
        { ...projectArgs(registry, "CreateTransport", args), target_system: "LOCAL" },
        ctx,
      ),
    );
  }

  // `DeleteObjectLow` has no `lock_handle` in its contract, and the delete is the tool's
  // own business anyway: `deleteObject` takes the lock, deletes and gives it back.
  if (registry.has("DeleteObjectLow")) {
    registry.register("DeleteObjectLow", async (args, ctx) => {
      // The object-level verbs name the object `object_name` whatever the type, exactly
      // like Lock/Unlock; the per-type argument (`program_name`, `table_name`, …) belongs
      // to the `Handler*` family and is not part of `DeleteObjectLow`.
      const { target, name } = targetOf(args, "DeleteObjectLow", "Lock");
      const resolved = runtime.resolve(ctx.system, String(args["session_id"] ?? "") || undefined, true);
      const transport = typeof args["transport_request"] === "string" ? (args["transport_request"] as string) : undefined;
      const result = await deleteObject(resolved.session, familyPath(target.family, name), transport);
      return {
        success: result.deleted,
        name,
        status: result.status,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        lock_released: result.lock_released,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("HandlerActivate")) {
    registry.register("HandlerActivate", async (args, ctx) => {
      const { target, name } = targetOf(args, "HandlerActivate", "Activate");
      const resolved = runtime.resolve(ctx.system, String(args["session_id"] ?? "") || undefined, true);
      const report = await activate(resolved.session, [
        { uri: `/sap/bc/adt${familyPath(target.family, name)}`, name, adtType: target.adtType },
      ]);
      return {
        success: report.ok,
        name,
        status: report.status,
        errors: report.errors,
        warnings: report.warnings,
        ...(report.ok ? {} : { messages: report.raw.slice(0, 800) }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("HandlerCheckRun")) {
    registry.register("HandlerCheckRun", async (args, ctx) => {
      const { target, name } = targetOf(args, "HandlerCheckRun", "CheckRun");
      const resolved = runtime.resolve(ctx.system, String(args["session_id"] ?? "") || undefined, false);
      const version = String(args["version"] ?? "inactive") === "active" ? "active" : "inactive";
      const result = await runCheck(resolved.session, `/sap/bc/adt${familyPath(target.family, name)}`, version);
      return {
        success: result.errors === 0,
        name,
        errors: result.errors,
        warnings: result.warnings,
        messages: result.messages,
        ...(result.unavailable === undefined ? {} : { unavailable: result.unavailable }),
        session_id: resolved.sessionId,
      };
    });
  }
}

/** The object's ADT path, derived from the family infix. */
function familyPath(family: string, name: string): string {
  const lower = name.trim().toLowerCase();
  switch (family) {
    case "Program":
      return `/programs/programs/${lower}`;
    case "Class":
      return `/oo/classes/${lower}`;
    case "Interface":
      return `/oo/interfaces/${lower}`;
    case "Table":
      return `/ddic/tables/${lower}`;
    case "Structure":
      return `/ddic/structures/${lower}`;
    case "Domain":
      return `/ddic/domains/${lower}`;
    case "DataElement":
      return `/ddic/dataelements/${lower}`;
    case "CdsView":
      return `/ddic/ddl/sources/${lower}`;
    case "BehaviorDefinition":
      return `/bo/behaviordefinitions/${lower}`;
    case "BehaviorImplementation":
      return `/oo/classes/${lower}`;
    case "ServiceDefinition":
      return `/ddic/srvd/sources/${lower}`;
    case "ServiceBinding":
      return `/businessservices/bindings/${lower}`;
    case "Package":
      return `/packages/${lower}`;
    default:
      throw new GatewayError("NOT_IMPLEMENTED", `no ADT path known for family "${family}".`);
  }
}
