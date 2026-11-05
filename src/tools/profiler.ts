/**
 * Profiler runs.
 *
 * "Run with profiling" is not a single request. Measured 2026-11-04 on DS4/100:
 *
 *   1. `POST /runtime/traces/abaptraces/parameters` creates the settings — the answer
 *      carries the profiler id in `Location`
 *      (`/sap/bc/adt/runtime/traces/abaptraces/parameters/02EF…`).
 *   2. `POST /programs/programrun/<NAME>?profilerId=<encoded>` (or `/oo/classrun/<NAME>`)
 *      executes the object; the trace is written asynchronously afterwards.
 *   3. `GET /runtime/traces/abaptraces` lists the finished trace files, each named by a
 *      32-hex id and carrying `<trc:objectName>`. That id is what the hit list and the
 *      analysis need.
 *
 * The routes header used to answer `POST …/abaptraces/requests?objectType=…`, which only
 * *registers* a trace request: it answered 200 with a feed whose `<trc:executions
 * completed="0"/>` said nothing had been recorded, and no trace id ever came out of it.
 */

import type { ToolRegistry, ToolContext } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import type { AdtSession } from "../adt/session.js";
import { GatewayError } from "../engine/errors.js";

type Args = Record<string, unknown>;

const TRACE_XML = "application/xml";
const TRACE_FEED = "application/atom+xml;type=feed";

/** The default settings SAP's own profiler dialog starts from. */
const DEFAULT_PARAMETERS: Readonly<Record<string, boolean | number>> = {
  allMiscAbapStatements: false,
  allProceduralUnits: true,
  allInternalTableEvents: false,
  allDynproEvents: false,
  aggregate: false,
  explicitOnOff: false,
  withRfcTracing: true,
  allSystemKernelEvents: false,
  sqlTrace: true,
  allDbEvents: true,
  maxSizeForTraceFile: 30720,
  amdpTrace: true,
  maxTimeForTracing: 1800,
};

/** Argument name (snake_case, as the tools document it) -> element name. */
const FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["all_misc_abap_statements", "allMiscAbapStatements"],
  ["all_procedural_units", "allProceduralUnits"],
  ["all_internal_table_events", "allInternalTableEvents"],
  ["all_dynpro_events", "allDynproEvents"],
  ["aggregate", "aggregate"],
  ["explicit_on_off", "explicitOnOff"],
  ["with_rfc_tracing", "withRfcTracing"],
  ["all_system_kernel_events", "allSystemKernelEvents"],
  ["sql_trace", "sqlTrace"],
  ["all_db_events", "allDbEvents"],
  ["max_size_for_trace_file", "maxSizeForTraceFile"],
  ["amdp_trace", "amdpTrace"],
  ["max_time_for_tracing", "maxTimeForTracing"],
];

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** The `trc:parameters` document, with SAP's defaults filled in for anything not passed. */
export function profilerParametersBody(args: Args): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<trc:parameters xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces">',
  ];
  for (const [argument, element] of FLAGS) {
    const given = args[argument];
    const fallback = DEFAULT_PARAMETERS[element];
    const value = typeof given === "boolean" || typeof given === "number" ? given : fallback;
    if (value === undefined) continue;
    const rendered = typeof value === "boolean" ? (value ? "true" : "false") : String(Math.trunc(value));
    lines.push(`  <trc:${element} value="${rendered}"/>`);
  }
  const description = typeof args["description"] === "string" ? (args["description"] as string) : "";
  if (description.length > 0) {
    lines.push(`  <trc:description value="${escapeAttribute(description)}"/>`);
  }
  lines.push("</trc:parameters>");
  return lines.join("\n");
}

/** Creates the settings and returns the profiler id (the `Location` SAP answers). */
async function createParameters(session: AdtSession, args: Args): Promise<string> {
  const response = await session.request({
    method: "POST",
    path: "/runtime/traces/abaptraces/parameters",
    accept: TRACE_XML,
    contentType: TRACE_XML,
    body: profilerParametersBody(args),
  });
  const location = String(response.headers["location"] ?? "");
  if (location.length === 0) {
    throw new GatewayError(
      "UPSTREAM_FAILED",
      "SAP accepted the profiler parameters but answered no Location, so there is no profiler id to run with.",
      { nextAction: "Read the raw answer with RuntimeCreateProfilerTraceParameters to see what this system sent." },
    );
  }
  return location;
}

interface TraceFile {
  readonly id: string;
  readonly objectName: string;
  readonly published: string;
}

/** The finished trace files, as `<atom:entry>` elements of the collection feed. */
async function traceFiles(session: AdtSession): Promise<TraceFile[]> {
  const response = await session.request({ path: "/runtime/traces/abaptraces", accept: TRACE_FEED });
  const body = String(response.body ?? "");
  return body
    .split("<atom:entry")
    .slice(1)
    .map((chunk) => ({
      id: /<atom:id>[^<]*\/abaptraces\/([0-9A-Fa-f]{32})<\/atom:id>/.exec(chunk)?.[1]?.toUpperCase() ?? "",
      objectName: /<trc:objectName>([^<]*)<\/trc:objectName>/.exec(chunk)?.[1] ?? "",
      published: /<atom:published>([^<]*)<\/atom:published>/.exec(chunk)?.[1] ?? "",
    }))
    .filter((entry) => entry.id.length > 0);
}

/**
 * The trace file this run produced. SAP writes it after the program has finished, so
 * the list is polled for a few seconds — an answer of "no trace id" would leave the
 * caller with an id-less run and a hit list it cannot reach.
 */
/**
 * Whether a trace file belongs to the object we ran.
 *
 * A program is named plainly (`ZMMR9020`), a class by the generated class pool name —
 * measured 2026-11-04: `ZCL_MCP9003===================CP`. Matching the name exactly left
 * every class run looking as if it had produced no trace at all.
 */
function isTraceOf(objectName: string, wanted: string): boolean {
  const normalize = (value: string): string => value.toUpperCase().replace(/=/g, "").replace(/CP$/, "");
  return objectName.toUpperCase() === wanted || normalize(objectName) === wanted;
}

async function waitForTrace(
  session: AdtSession,
  objectName: string,
  since: string,
): Promise<string | undefined> {
  const wanted = objectName.toUpperCase();
  let seen: TraceFile | undefined;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidates = (await traceFiles(session))
      .filter((entry) => isTraceOf(entry.objectName, wanted) && entry.published >= since)
      .sort((left, right) => (left.published < right.published ? 1 : -1));
    seen = candidates[0] ?? seen;
    if (seen !== undefined) return seen.id;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return seen?.id;
}

/** Runs one object with the settings just created, then waits for its trace file. */
async function runWithProfiling(
  session: AdtSession,
  runPath: string,
  objectName: string,
  args: Args,
): Promise<Record<string, unknown>> {
  const startedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const profilerId = await createParameters(session, args);
  const response = await session.request({
    method: "POST",
    path: `${runPath}?profilerId=${encodeURIComponent(profilerId)}`,
    accept: "text/plain",
    headers: { "X-sap-adt-profiling": "server-time" },
    timeoutMs: 300_000,
  });
  const traceId = await waitForTrace(session, objectName, startedAt);
  return {
    success: true,
    object_name: objectName,
    profiler_id: profilerId,
    run_status: response.status,
    ...(traceId === undefined
      ? {
          trace_id: "",
          trace_pending: true,
          nextAction:
            "The run finished but no trace file for this object appeared within ~8s. " +
            "List the trace files with RuntimeListProfilerTraceFiles and pass the 32-hex id to RuntimeGetProfilerTraceData.",
        }
      : { trace_id: traceId }),
    output: String(response.body ?? "").slice(0, 4_000),
    session_id: "", // filled in by the caller
  };
}

export function registerProfilerTools(registry: ToolRegistry, runtime: GatewayRuntime): void {
  const register = (name: string, handler: (args: Args, ctx: ToolContext) => Promise<unknown>): void => {
    if (registry.has(name)) registry.register(name, handler);
  };

  const run = async (args: Args, ctx: ToolContext, kind: "PROGRAM" | "CLASS"): Promise<unknown> => {
    const argument = kind === "PROGRAM" ? "program_name" : "class_name";
    const raw = typeof args[argument] === "string" ? (args[argument] as string).trim().toUpperCase() : "";
    if (raw.length === 0) {
      throw new GatewayError("INVALID_ARGUMENT", `Profiling a ${kind} needs "${argument}".`, {
        argument,
        nextAction: kind === "PROGRAM" ? 'Pass program_name: "ZMY_REPORT".' : 'Pass class_name: "ZCL_MY_CLASS".',
      });
    }
    const resolved = runtime.resolve(ctx.system, undefined, false);
    const runPath = kind === "PROGRAM" ? `/programs/programrun/${raw}` : `/oo/classrun/${raw}`;
    const result = await runWithProfiling(resolved.session, runPath, raw, args);
    return { ...result, session_id: resolved.sessionId };
  };

  register("RuntimeRunProgramWithProfiling", (args, ctx) => run(args, ctx, "PROGRAM"));
  register("RuntimeRunClassWithProfiling", (args, ctx) => run(args, ctx, "CLASS"));

  // `HandlerProfileRun` is the same run behind a `target_type` switch.
  register("HandlerProfileRun", (args, ctx) => {
    const target = typeof args["target_type"] === "string" ? (args["target_type"] as string).toUpperCase() : "";
    if (target !== "PROGRAM" && target !== "CLASS") {
      throw new GatewayError("INVALID_ARGUMENT", 'HandlerProfileRun needs target_type "PROGRAM" or "CLASS".', {
        argument: "target_type",
        nextAction: 'Pass target_type: "PROGRAM" with program_name, or "CLASS" with class_name.',
      });
    }
    return run(args, ctx, target);
  });
}
