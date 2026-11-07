/**
 * Profiler runs.
 *
 * "Run with profiling" is not a single request. Measured on DS4/100:
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
import { AdtError } from "../adt/errors.js";
import { hasSignal } from "../adt/signals.js";
import { childTextOf, findElements, nodeTextOf, parseXml } from "../adt/xml.js";

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
  readonly size_kb?: number;
  readonly runtime_ms?: number;
}

/**
 * The finished trace files, as `<atom:entry>` elements of the collection feed.
 *
 * `RuntimeListProfilerTraceFiles` used to answer the feed itself: 564 KB of `raw_xml` on the
 * reference system (measured ), which floods a caller's context and makes the one
 * field it wants (`atom:id`) hard to find. The entries are parsed here, newest first, and
 * capped — `truncated` says whether anything was left out.
 */
async function traceFiles(session: AdtSession, limit = 100): Promise<TraceFile[]> {
  const response = await session.request({ path: "/runtime/traces/abaptraces", accept: TRACE_FEED });
  const body = String(response.body ?? "");
  const parsed = parseXml(body);
  if (parsed === undefined) return [];
  // Structural: `split("<atom:entry")` cut the feed at a string that also appears inside
  // escaped text, and the per-chunk regexes needed the namespace prefix spelled exactly.
  const entries = findElements(parsed, "entry")
    .map((entry) => {
      const published = childTextOf(entry, "published") ?? "";
      const objectName = findElements(entry, "objectName")[0];
      const size = findElements(entry, "size")[0];
      const runtime = findElements(entry, "runtime")[0];
      const sizeBytes = size === undefined ? Number.NaN : Number(nodeTextOf(size));
      const runtimeMs = runtime === undefined ? Number.NaN : Number(nodeTextOf(runtime));
      return {
        id: /([0-9A-Fa-f]{32})$/.exec(childTextOf(entry, "id") ?? "")?.[1]?.toUpperCase() ?? "",
        // The `title` of an entry is the package (`$TMP`) or the object it belongs to.
        objectName: objectName === undefined ? (childTextOf(entry, "title") ?? "") : nodeTextOf(objectName),
        published,
        ...(Number.isFinite(sizeBytes) ? { size_kb: Math.round((sizeBytes / 1024) * 10) / 10 } : {}),
        ...(Number.isFinite(runtimeMs) ? { runtime_ms: runtimeMs } : {}),
      };
    })
    .filter((entry) => entry.id.length > 0);
  entries.sort((left, right) => (left.published < right.published ? 1 : -1));
  return entries.slice(0, limit);
}

/**
 * The trace file this run produced. SAP writes it after the program has finished, so
 * the list is polled for a few seconds — an answer of "no trace id" would leave the
 * caller with an id-less run and a hit list it cannot reach.
 */
/**
 * Whether a trace file belongs to the object we ran.
 *
 * A program is named plainly (`ZDEMO_REPORT`), a class by the generated class pool name —
 * measured: `ZCL_DEMO_REPORT================CP`. Matching the name exactly left
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
  const output = String(response.body ?? "").slice(0, 4_000);
  // Measured live: profiling a program that does not exist answered
  // `{success: true, run_status: 200, output: "Error: Program does not exist!",
  // trace_id: "", trace_pending: true}` — the run endpoint reports the failure in the
  // body with a 200, so `success` said the opposite of `output`, and the eight-second
  // trace wait ran for a trace that could never appear. Checked before the wait, so a
  // failed run answers at once.
  if (/does not exist|cannot be executed/i.test(output)) {
    throw new AdtError({
      code: "not-found",
      message: `Not found: ${objectName} — the profiled run answered "${output.trim()}".`,
      nextAction: `Check the name with SearchObject; a class runs as <NAME>================CP, and the object must exist and be active before it can be profiled.`,
      status: response.status,
      method: "POST",
      path: runPath,
      sapText: output.trim(),
    });
  }
  // Measured live: `RuntimeRunClassWithProfiling ZCL_MCP_T02` answered
  // `{success: true, trace_pending: true}` while `output` said "For console output, a class
  // must implement IF_OO_ADT_CLASSRUN" — the run never happened, so no trace could appear.
  // Checked before the wait: a run that already said why it failed does not need eight
  // seconds of polling to prove it.
  if (hasSignal(output, "classrun-not-supported")) {
    throw new GatewayError("UPSTREAM_FAILED", `${objectName} cannot be run as a console app: ${output.trim()}`, {
      kind: "classrun-not-supported",
      nextAction:
        "Implement IF_OO_ADT_CLASSRUN on the class (directly or through CL_XCO_CP_ADT_SIMPLE_CLASSRUN / CL_XCO_ADT_CR_SIMPLE_ABSTR / CL_DEMO_CLASSRUN), or profile a program instead.",
    });
  }
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
    output,
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

  // The route for this one answered the whole Atom feed (564 KB measured ) under a
  // description that promises "parsed JSON payload". Registered here so it answers entries.
  register("RuntimeListProfilerTraceFiles", async (_args, ctx) => {
    const resolved = runtime.resolve(ctx.system, undefined, false);
    const limit = 100;
    const traces = await traceFiles(resolved.session, limit);
    return {
      success: true,
      path: "/runtime/traces/abaptraces",
      count: traces.length,
      truncated: traces.length === limit,
      traces,
      session_id: resolved.sessionId,
    };
  });

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
