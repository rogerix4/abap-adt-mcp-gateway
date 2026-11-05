/**
 * The route table's path building.
 *
 * These are the mistakes that answer 200 from the wrong place or 404 with no
 * explanation: an id folded to lower case, a comma left raw in a path segment, a
 * resource guessed instead of resolved from `object_type`, and a tool that has no
 * endpoint at all pretending it has one.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { registerFamilies } from "../src/families/index.js";
import { GatewayRuntime } from "../src/runtime.js";

// Lock handles are journalled on disk; keep the tests out of the real file.
process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-routes-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

/** Records every URL the session asks for and answers 200 without touching SAP. */
function bootedRegistry(): { call: (tool: string, args: Record<string, unknown>) => Promise<unknown>; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "token" } });
  }) as typeof fetch;
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
  registerFamilies(registry, runtime);
  return {
    urls,
    call: (tool, args) => registry.call(tool, args, { system: "probe" }),
  };
}

const lastUrl = (urls: string[]): string => urls[urls.length - 1] ?? "";

describe("opaque ids travel as one encoded path segment", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["the raw id", "56,20261103215552"],
    ["the encoded form the feed returns", "56%2c20261103215552"],
    ["the full resource URI", "/sap/bc/adt/runtime/traces/abaptraces/requests/56%2c20261103215552"],
  ];

  for (const [label, value] of cases) {
    it(`accepts ${label}`, async () => {
      const { call, urls } = bootedRegistry();
      await call("RuntimeGetProfilerTraceData", { trace_id_or_uri: value });
      expect(lastUrl(urls)).toContain("/runtime/traces/abaptraces/56%2C20261103215552/hitlist");
    });
  }
});

describe("identifiers keep their case", () => {
  it("does not fold a lock handle", async () => {
    const { call, urls } = bootedRegistry();
    await call("UnlockScreenLow", { program_name: "zz_probe_route", lock_handle: "AB12cd34EF56" });
    expect(lastUrl(urls)).toContain("lockHandle=AB12cd34EF56");
  });

  it("does not fold a dump id", async () => {
    const { call, urls } = bootedRegistry();
    await call("RuntimeGetDumpById", { dump_id: "20261103234908vhfjeds4ci_DS4_00" });
    expect(lastUrl(urls)).toContain("/runtime/dump/20261103234908vhfjeds4ci_DS4_00/formatted");
  });
});

describe("the object verbs resolve their resource from object_type", () => {
  it("locks the program resource, not a made-up /object path", async () => {
    const { call, urls } = bootedRegistry();
    await call("LockObjectLow", { object_name: "ZZ_PROBE_ROUTE", object_type: "program" });
    expect(lastUrl(urls)).toContain("/programs/programs/zz_probe_route?_action=LOCK");
  });

  it("locks the class resource for a class", async () => {
    const { call, urls } = bootedRegistry();
    await call("LockObjectLow", { object_name: "ZCL_PROBE_ROUTE", object_type: "class" });
    expect(lastUrl(urls)).toContain("/oo/classes/zcl_probe_route?_action=LOCK");
  });

  it("checks through /checkruns with the object URI in the body", async () => {
    const { call, urls } = bootedRegistry();
    await call("CheckObjectLow", { object_name: "ZCL_PROBE_ROUTE", object_type: "class" });
    expect(lastUrl(urls)).toContain("/checkruns?reporters=abapCheckRun");
  });

  it("validates a name through the family's own check resource", async () => {
    const { call, urls } = bootedRegistry();
    await call("ValidateObjectLow", {
      object_name: "ZCL_PROBE_ROUTE",
      object_type: "class",
      package_name: "$TMP",
    });
    const url = decodeURIComponent(lastUrl(urls));
    expect(url).toContain("/oo/validation/objectname?objname=ZCL_PROBE_ROUTE");
    expect(url).toContain("packagename=$TMP");
  });

  it("says which types it knows instead of guessing a path", async () => {
    const { call } = bootedRegistry();
    await expect(call("LockObjectLow", { object_name: "ZZ_PROBE_ROUTE", object_type: "something" })).rejects.toThrow(
      /Unsupported object_type/,
    );
  });
});

describe("a tool with no endpoint says so", () => {
  it("answers NOT_IMPLEMENTED with the reason, not a 404 from a guessed path", async () => {
    const { call, urls } = bootedRegistry();
    // The analysis tools parse the source locally now, and every SmartForm tool runs through
    // the ZMCP_SSF_* bridge. What is left without a server-side action are the ABAP Unit run
    // update/delete: ADT answers 405 on PUT and DELETE, so the tool says so instead of
    // inventing a path.
    await expect(call("UpdateUnitTest", { run_id: "00D3E5F6" })).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    expect(urls).toHaveLength(0);
  });
});
