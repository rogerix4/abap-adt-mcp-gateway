/**
 * Profiling a program that does not exist.
 *
 * Measured live on a test system (client 100): `RuntimeRunProgramWithProfiling
 * {program_name: "ZMMR_MCP_NEVER9"}` answered
 *
 * {success: true, run_status: 200, output: "Error: Program does not exist!", trace_id: ""}
 *
 * the run endpoint puts the failure in the **body** of a 200, so `success` told the
 * caller the opposite of `output` and the trace wait ran its full eight seconds.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerProfilerTools } from "../src/tools/profiler.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-profiler-${process.pid}.json`);

const system = {
 id: "probe",
 tier: "dev",
 endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
 auth: { type: "basic", username: "u", password: "p" },
 rfcBackend: "soap",
 env: {},
} as never;

/** Answers in order; `CSRF` first, then parameters, run, and the trace feed. */
function scripted(script: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
 let index = 0;
 const impl = (async () => {
 const step = script[index] ?? script.at(-1) ?? { status: 500 };
 index += 1;
 const headers = new Headers;
 for (const [key, value] of Object.entries(step.headers ?? {})) headers.set(key, value);
 return new Response(step.body ?? "", { status: step.status, headers });
 }) as typeof fetch;
 return impl;
}

function registryWith(fetchImpl: typeof fetch) {
 const runtime = new GatewayRuntime([system], (target) =>
 new AdtSession({
 url: target.endpoint.url,
 client: target.endpoint.client,
 language: target.endpoint.language,
 username: "u",
 password: "p",
 fetchImpl,
 }),
);
 const registry = createRegistry();
 registerProfilerTools(registry, runtime);
 return registry;
}

const CSRF = { status: 200, headers: { "x-csrf-token": "t" }, body: "<d/>" };
const PARAMETERS = {
 status: 201,
 headers: { location: "/sap/bc/adt/runtime/traces/abaptraces/parameters/02EF" },
 body: "",
};
const EMPTY_FEED = {
 status: 200,
 body: '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces"/>',
};

describe("RuntimeRunProgramWithProfiling", () => {
 it("answers not-found when SAP says the program does not exist in a 200 body", async () => {
 const registry = registryWith(
 scripted([CSRF, PARAMETERS, { status: 200, body: "Error: Program does not exist!" }, EMPTY_FEED]),
);

 await expect(
 registry.call("RuntimeRunProgramWithProfiling", { program_name: "ZMMR_MCP_NEVER9" }, { system: "probe" }),
).rejects.toMatchObject({ code: "not-found", sapText: "Error: Program does not exist!" });
 });

 it("still answers the ids when the object really ran", async () => {
 const registry = registryWith(scripted([CSRF, PARAMETERS, { status: 200, body: "" }, EMPTY_FEED]));

 const result = (await registry.call(
 "RuntimeRunProgramWithProfiling",
 { program_name: "ZMMR_MCP_T10", description: "regression" },
 { system: "probe" },
)) as { success: boolean; profiler_id: string; trace_pending?: boolean };

 expect(result.success).toBe(true);
 expect(result.profiler_id).toContain("/parameters/");
 // No trace file appeared in the scripted feed: say so instead of failing the run.
 expect(result.trace_pending).toBe(true);
 // The trace poll runs ~8 s by design (six attempts, 1.5 s apart).
 }, 20_000);
});

 it("refuses a class that cannot run as a console app, instead of waiting for a trace", async () => {
 // Measured live: `{success: true, trace_pending: true}` with this body.
 const registry = registryWith(
 scripted([
 CSRF,
 PARAMETERS,
 {
 status: 200,
 body:
 "\nFor console output, a class must implement IF_OO_ADT_CLASSRUN \n" +
 "either directly or by inheriting from an appropriate class such as \n" +
 "CL_XCO_CP_ADT_SIMPLE_CLASSRUN.",
 },
 EMPTY_FEED,
 ]),
);

 await expect(
 registry.call("RuntimeRunClassWithProfiling", { class_name: "ZCL_MCP_T02" }, { system: "probe" }),
).rejects.toMatchObject({ code: "UPSTREAM_FAILED", details: expect.objectContaining({ kind: "classrun-not-supported" }) });
 });

/**
 * Measured live: `RuntimeListProfilerTraceFiles` answered the whole Atom feed —
 * 564 KB of `raw_xml` — under a description that promises "parsed JSON payload". The entries
 * are parsed now, newest first, and capped.
 */
describe("RuntimeListProfilerTraceFiles", () => {
 const FEED = `<?xml version="1.0" encoding="utf-8"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces">
 <atom:entry><atom:id>/sap/bc/adt/runtime/traces/abaptraces/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</atom:id><atom:published>T06:00:00Z</atom:published><atom:title>$TMP</atom:title><trc:extendedData><trc:size>2048</trc:size><trc:runtime>500</trc:runtime></trc:extendedData></atom:entry>
 <atom:entry><atom:id>/sap/bc/adt/runtime/traces/abaptraces/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB</atom:id><atom:published>T09:00:00Z</atom:published><atom:title>ZMMR_MCP_T10</atom:title><trc:extendedData><trc:size>4096</trc:size><trc:runtime>1200</trc:runtime></trc:extendedData></atom:entry>
 </atom:feed>`;

 it("answers parsed entries, newest first, with size and runtime", async () => {
 const registry = registryWith(scripted([{ status: 200, body: FEED }]));
 const answer = (await registry.call("RuntimeListProfilerTraceFiles", {}, { system: "probe" })) as {
 count: number;
 truncated: boolean;
 traces: Array<{ id: string; objectName: string; published: string; size_kb?: number; runtime_ms?: number }>;
 };

 expect(answer.count).toBe(2);
 expect(answer.truncated).toBe(false);
 expect(answer.traces[0]).toMatchObject({
 id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
 objectName: "ZMMR_MCP_T10",
 size_kb: 4,
 runtime_ms: 1200,
 });
 expect(answer.traces[1]?.objectName).toBe("$TMP");
 });
});
