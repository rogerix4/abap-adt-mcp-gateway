/**
 * `activate_on_update` on the local-include writes.
 *
 * Measured live: `UpdateLocalTestClass {activate_on_update: true}` answered
 * `{success: true, activated: false}` and left the test class in the inactive version — the
 * flag was read through a string-only helper, so a JSON `true` never matched. The tests it
 * wrote were therefore not what `RunClassUnitTestsLow` would run.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { registerBridgeTools } from "../src/tools/bridges.js";
import { GatewayRuntime } from "../src/runtime.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-local-include-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

function scripted(script: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const urls: string[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const step = script[index] ?? script.at(-1) ?? { status: 500 };
    index += 1;
    const headers = new Headers();
    for (const [key, value] of Object.entries(step.headers ?? {})) headers.set(key, value);
    return new Response(step.body ?? "", { status: step.status, headers });
  }) as typeof fetch;
  return { impl, urls };
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
  registerBridgeTools(registry, runtime);
  return registry;
}

const CSRF = { status: 200, headers: { "x-csrf-token": "t" }, body: "<d/>" };
const LOCK = { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" };
const PUT = { status: 200, body: "" };
const UNLOCK = { status: 200, body: "" };
const ACTIVATE = { status: 200, body: "" };
// The activation is verified against the class's active source afterwards.
const CLASS_SOURCE = {
  status: 200,
  body: "CLASS ltcl_greet DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.\nENDCLASS.",
};

describe("UpdateLocalTestClass", () => {
  it("activates the parent class when activate_on_update is the JSON boolean true", async () => {
    const { impl, urls } = scripted([CSRF, LOCK, PUT, UNLOCK, ACTIVATE, CLASS_SOURCE]);
    const registry = registryWith(impl);

    const result = (await registry.call(
      "UpdateLocalTestClass",
      {
        class_name: "ZCL_MCP_T01",
        test_class_code: "CLASS ltcl_greet DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.\nENDCLASS.",
        activate_on_update: true,
      },
      { system: "probe" },
    )) as { activated: boolean };

    expect(result.activated).toBe(true);
    expect(urls.some((url) => url.includes("/activation"))).toBe(true);
  });

  it("writes without activating when the flag is absent", async () => {
    const { impl, urls } = scripted([CSRF, LOCK, PUT, UNLOCK]);
    const registry = registryWith(impl);

    const result = (await registry.call(
      "UpdateLocalTestClass",
      { class_name: "ZCL_MCP_T01", test_class_code: "* empty\n" },
      { system: "probe" },
    )) as { activated: boolean };

    expect(result.activated).toBe(false);
    expect(urls.some((url) => url.includes("/activation"))).toBe(false);
  });
});
