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
import { parseChecklist, routeTable, traceIdOf } from "../src/tools/routes.js";
import { BRIDGE_TOOL_NAMES } from "../src/tools/bridges.js";

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
  const fetchImpl = (async (input: string | URL | Request) => {
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
      await call("RuntimeGetProfilerTraceData", { trace_id_or_uri: value, view: "hitlist" });
      expect(lastUrl(urls)).toContain("/runtime/traces/abaptraces/56%2C20261103215552/hitlist");
    });
  }
});

describe("identifiers keep their case", () => {
  it("does not fold a lock handle", async () => {
    const { call, urls } = bootedRegistry();
    await call("UnlockScreenLow", { program_name: "zmmr_mcp_route", lock_handle: "AB12cd34EF56" });
    expect(lastUrl(urls)).toContain("lockHandle=AB12cd34EF56");
  });

  it("does not fold a dump id", async () => {
    const { call, urls } = bootedRegistry();
    await call("RuntimeGetDumpById", { dump_id: "20261103234908vhfjeds4ci_DS4_00" });
    // The default view reads the structured dump resource (facts + chapter index), not the
    // `/formatted` long text — see `readDump` in `src/tools/read.ts`.
    expect(lastUrl(urls)).toContain("/runtime/dump/20261103234908vhfjeds4ci_DS4_00");
    expect(urls.some((url) => url.includes("/formatted"))).toBe(false);
  });
});

/**
 * `object_type` is exempt from the registry's enum check (the generic `*ObjectLow` routes take
 * many more ADT type ids than their enum). `GetIncludesList` is not generic, so it has to check
 * the enum itself — otherwise ADT answers an empty node structure and the caller reads that as
 * "this object has no includes".
 */
describe("GetIncludesList refuses an object type outside its enum", () => {
  it("answers INVALID_ARGUMENT with the allowed values, without calling ADT", async () => {
    const { call, urls } = bootedRegistry();
    await expect(
      call("GetIncludesList", { object_name: "ZMMR_MCP_ROUTE", object_type: "__NOT_A_CONTRACT_VALUE__" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ argument: "object_type", allowed: ["PROG/P", "PROG/I", "FUGR", "CLAS/OC"] }),
    });
    expect(urls).toHaveLength(0);
  });

  it("still accepts a declared type, case-insensitively", async () => {
    const { call, urls } = bootedRegistry();
    await call("GetIncludesList", { object_name: "ZMMR_MCP_ROUTE", object_type: "prog/p" });
    // The check is case-insensitive, and the call really goes out (the node structure is read).
    expect(urls.some((url) => /\/repository\/nodestructure/.test(url))).toBe(true);
  });
});

describe("the object verbs resolve their resource from object_type", () => {
  it("locks the program resource, not a made-up /object path", async () => {
    const { call, urls } = bootedRegistry();
    await call("LockObjectLow", { object_name: "ZMMR_MCP_ROUTE", object_type: "program" });
    expect(lastUrl(urls)).toContain("/programs/programs/zmmr_mcp_route?_action=LOCK");
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
    await expect(call("LockObjectLow", { object_name: "ZMMR_MCP_ROUTE", object_type: "something" })).rejects.toThrow(
      /Unsupported object_type/,
    );
  });
});

describe("a route-backed tool keeps the ADT classification", () => {
  it("answers not-found for a 404 instead of upstream", async () => {
    // Measured: `GetEnhancementSpot {enhancement_spot: "ES_SD_SALES"}` answered
    // `UPSTREAM_FAILED` for a plain 404, because the route layer wrapped every ADT error.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/sap/bc/adt/enhancements/")) {
        return new Response("Object directory entry was not found", { status: 404 });
      }
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

    await expect(
      registry.call("GetEnhancementSpot", { enhancement_spot: "ES_SD_SALES" }, { system: "probe" }),
    ).rejects.toMatchObject({ code: "not-found" });
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

describe("traceIdOf", () => {
  it("reads the request id out of the feed and decodes the comma", () => {
    const body =
      '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">' +
      "<atom:entry><atom:id>/sap/bc/adt/runtime/traces/abaptraces/requests/90%2c20261104114752</atom:id>" +
      "</atom:entry></atom:feed>";

    expect(traceIdOf(body)).toBe("90,20261104114752");
  });

  it("answers an empty string for an answer without an id", () => {
    expect(traceIdOf("<atom:feed xmlns:atom=\"http://www.w3.org/2005/Atom\"/>")).toBe("");
    expect(traceIdOf("not xml")).toBe("");
  });
});

describe("parseChecklist", () => {
  it("finds the message text one level deeper than the check report", () => {
    // `<msg><shortText><txt>` is the shape the activation answer uses; a regex over
    // `<msg><txt>` saw the element and reported an empty text.
    const body =
      '<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">' +
      '<msg type="E"><shortText><txt>Field ZF1 does not exist</txt></shortText></msg>' +
      '<msg type="W" shortText="Field is unused"/>' +
      "</chkl:messages>";

    const checklist = parseChecklist(body);
    expect(checklist?.messages).toEqual([
      { severity: "e", text: "Field ZF1 does not exist" },
      { severity: "w", text: "Field is unused" },
    ]);
    expect(checklist?.errors).toBe(1);
    expect(checklist?.warnings).toBe(1);
  });

  it("reads activationExecuted, so a cancelled activation is not success", () => {
    const body =
      '<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">' +
      '<chkl:properties activationExecuted="false" generationExecuted="false"/>' +
      "</chkl:messages>";

    expect(parseChecklist(body)).toMatchObject({ activation_executed: false, errors: 0 });
  });

  it("stays out of the way of an answer that is not a checklist", () => {
    expect(parseChecklist("<dataPreview:tableData/>")).toBeUndefined();
  });
});

/**
 * Every route names arguments the contract actually has.
 *
 * Measured live: `UpdateClassTestClassesLow` built its body from
 * `test_class_code` while the contract calls that argument `test_class_source`, so the PUT
 * went out empty and SAP answered `Not found: Resource CLASS_INCLUDE ZCL_MCP_T01 does not
 * exist` — a message about the object, not about the missing argument. One pass over the
 * table finds that class of mistake without a live system.
 */
describe("route arguments exist in the contract", () => {
  /** Filled in by the dispatcher itself, so they need no contract entry. */
  const internal = new Set([
    "session_id",
    "validation_path",
    "object_uri",
    "object_uri_encoded",
    "object_path",
    "node_id",
    "resource",
    "lock_handle",
    "max_results",
  ]);

  const registry = createRegistry();
  const declared = (tool: string): ReadonlySet<string> => {
    const properties = registry.get(tool)?.definition.inputSchema.properties as Record<string, unknown> | undefined;
    return new Set(Object.keys(properties ?? {}));
  };

  // A route another module already implements is never registered, so its placeholders are moot.
  const implementedElsewhere = new Set([
    "CreateTransport",
    "CreateTransportLow",
    "CreateCdsUnitTest",
    "UpdateUnitTest",
    "DescribeByList",
  ]);
  const routes = Object.entries(routeTable()).filter(
    ([tool]) => !BRIDGE_TOOL_NAMES.has(tool) && !implementedElsewhere.has(tool),
  );

  it("has routes to check", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  for (const [tool, route] of routes) {
    it(`${tool} only references declared arguments`, () => {
      const properties = declared(tool);
      if (properties.size === 0) return; // not in this contract build

      // `bodyFrom: "body"` is the passthrough shape (the caller sends the document).
      if (route.bodyFrom !== undefined && route.bodyFrom !== "body") {
        expect(properties.has(route.bodyFrom), `bodyFrom "${route.bodyFrom}" is not a declared argument`).toBe(true);
      }

      for (const text of [route.path ?? "", route.body ?? ""]) {
        for (const match of text.matchAll(/\{(\w+)\}/g)) {
          const name = match[1] ?? "";
          if (internal.has(name)) continue;
          expect(properties.has(name), `{${name}} is not a declared argument`).toBe(true);
        }
      }
    });
  }
});
