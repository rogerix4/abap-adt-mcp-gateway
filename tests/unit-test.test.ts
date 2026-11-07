/**
 * ABAP Unit routes across releases.
 *
 * The run endpoint moved (`/abapunit/runs` now, `/abapunit/testruns` before) and the
 * older one runs synchronously, so it has no run id to poll. Both facts have to show
 * up as an answer a caller can act on, not as a 404 that reads like a typo.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayError } from "../src/engine/errors.js";
import { registerFamilies } from "../src/families/index.js";
import { GatewayRuntime } from "../src/runtime.js";
import { legacyUnitTestBody, modernUnitTestBody } from "../src/tools/unit-test.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-unit-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

interface Call {
  readonly url: string;
  readonly body: string;
}

/** Answers with whatever the caller says is served on this system. */
function bootedRegistry(served: (url: string) => { status: number; body: string }): {
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: String(init?.body ?? "") });
    // The session asks for a CSRF token first; that request has to succeed or nothing else runs.
    const answer = url.includes("/sap/bc/adt/discovery")
      ? { status: 200, body: "<ok/>" }
      : served(url);
    return new Response(answer.body, { status: answer.status, headers: { "x-csrf-token": "token" } });
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
  return { calls, call: (tool, args) => registry.call(tool, args, { system: "probe" }) };
}

/** Anything that is not the run call gets a token so the session stays usable. */
const tokenOnly = { status: 200, body: "<ok/>" };

const pathOf = (url: string): string => {
  const match = /^https?:\/\/[^/]+(\/[^?#]*)/.exec(url);
  return match?.[1] ?? url;
};

const modernSystem = (url: string) =>
  pathOf(url) === "/sap/bc/adt/abapunit/runs"
    ? { status: 200, body: '<aunit:run id="1234" xmlns:aunit="http://www.sap.com/adt/api/aunit"/>' }
    : tokenOnly;

const legacySystem = (url: string) =>
  pathOf(url) === "/sap/bc/adt/abapunit/testruns"
    ? { status: 200, body: '<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"/>' }
    : { status: 404, body: "<exc:exception><message>未找到合适资源</message></exc:exception>" };

const tests = [{ container_class: "cl_abap_typedescr", test_class: "ltcl_probe" }];

describe("ABAP Unit run", () => {
  it("uses the current endpoint when the system has it", async () => {
    const { call, calls } = bootedRegistry(modernSystem);
    const result = (await call("RunUnitTest", { tests })) as { path: string; status: number };

    expect(result.path).toBe("/abapunit/runs");
    expect(result.status).toBe(200);
    expect(calls[calls.length - 1]?.url).toContain("/sap/bc/adt/abapunit/runs");
    expect(calls[calls.length - 1]?.body).toContain("<aunit:run ");
    expect(calls[calls.length - 1]?.body).toContain('containerClass="CL_ABAP_TYPEDESCR"');
  });

  it("falls back to the older endpoint, with the body that endpoint takes", async () => {
    const { call, calls } = bootedRegistry(legacySystem);
    const result = (await call("RunClassUnitTestsLow", { tests })) as { path: string };

    expect(result.path).toBe("/abapunit/testruns");
    const last = calls[calls.length - 1];
    expect(last?.url).toContain("/sap/bc/adt/abapunit/testruns");
    expect(last?.body).toContain("runConfiguration");
    expect(last?.body).toContain('adtcore:uri="/sap/bc/adt/oo/classes/cl_abap_typedescr"');
  });

  it("refuses a run without a container", async () => {
    const { call } = bootedRegistry(modernSystem);
    await expect(call("RunUnitTest", { tests: [] })).rejects.toThrow(GatewayError);
    await expect(call("RunUnitTest", { tests: [] })).rejects.toThrow(/tests: \[\{ container_class/);
  });
});

describe("polling a run on a system without run ids", () => {
  it("says why instead of answering 404", async () => {
    const { call } = bootedRegistry(legacySystem);
    const attempt = call("GetUnitTestStatus", { run_id: "1234" });

    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toThrow(/runs ABAP Unit synchronously/);
  });
});

describe("request bodies", () => {
  it("keeps the documented defaults when only tests are given", () => {
    const body = modernUnitTestBody({ tests });

    expect(body).toContain('ownTests="true"');
    expect(body).toContain('foreignTests="false"');
    expect(body).toContain('addForeignTestsAsPreview="true"');
    expect(body).toContain('short="true"');
  });

  it("honours the arguments the tools document", () => {
    const body = modernUnitTestBody({
      tests,
      scope: { own_tests: false, foreign_tests: true },
      duration: { long: false },
      title: "T",
      context: "C",
    });

    expect(body).toContain('ownTests="false"');
    expect(body).toContain('foreignTests="true"');
    expect(body).toContain('long="false"');
    expect(body).toContain('title="T"');
    expect(body).toContain('context="C"');
  });

  it("asks the older endpoint once per container, whatever the test classes", () => {
    const body = legacyUnitTestBody({
      tests: [
        { container_class: "zcl_one", test_class: "ltcl_a" },
        { container_class: "ZCL_ONE", test_class: "ltcl_b" },
        { container_class: "zcl_two", test_class: "ltcl_c", container_type: "PROG" },
      ],
    });

    expect(body.match(/adtcore:uri=/g)).toHaveLength(2);
    expect(body).toContain("/sap/bc/adt/oo/classes/zcl_one");
    expect(body).toContain("/sap/bc/adt/programs/programs/zcl_two");
  });
});
