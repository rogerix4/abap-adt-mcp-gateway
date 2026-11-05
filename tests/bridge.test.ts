/**
 * The RFC bridge and the object-type dispatcher.
 *
 * Both are shapes that fail quietly when they are wrong: a mistyped SOAP element
 * name still answers 200 with an empty payload, and a dispatcher that resolves
 * the wrong family still returns 200 — from the wrong object.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { RfcBridge, buildSoapEnvelope, parseSoapResult } from "../src/adt/rfc.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { registerFamilies } from "../src/families/index.js";
import { GatewayRuntime } from "../src/runtime.js";

// Lock handles are journalled on disk; keep the tests out of the real file.
process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-bridge-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "env:U", password: "env:P" },
  rfcBackend: "soap",
  env: {},
} as never;

/** A registry with every family, route and bridge registered; contacts nothing. */
function bootedRegistry() {
  const runtime = new GatewayRuntime([system], (target) => {
    return new AdtSession({
      url: target.endpoint.url,
      client: target.endpoint.client,
      language: target.endpoint.language,
      username: "u",
      password: "p",
    });
  });
  const registry = createRegistry();
  registerFamilies(registry, runtime);
  return registry;
}

describe("SOAP envelope", () => {
  it("names the function module and escapes the parameter values", () => {
    const envelope = buildSoapEnvelope("ZMCP_ADT_DISPATCH", {
      IV_ACTION: "DYNPRO_READ",
      IV_PARAMS: '{"program":"SAPLSPO1","dynpro":"0100"}',
    });

    expect(envelope).toContain("<urn:ZMCP_ADT_DISPATCH>");
    expect(envelope).toContain("<IV_ACTION>DYNPRO_READ</IV_ACTION>");
    // The JSON quotes must not terminate the XML text node.
    expect(envelope).toContain("&quot;program&quot;");
    expect(envelope).not.toContain('{"program"');
  });

  it("reads the flat EV_* exports back, and decodes entities", () => {
    const answer =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">' +
      "<soap-env:Body><urn:ZMCP_ADT_DISPATCH.Response>" +
      "<EV_RESULT>{&quot;HEADER&quot;:&quot;0100&quot;,&quot;note&quot;:&quot;a &amp; b&quot;}</EV_RESULT>" +
      "<EV_SUBRC>0</EV_SUBRC><EV_MESSAGE></EV_MESSAGE>" +
      "</urn:ZMCP_ADT_DISPATCH.Response></soap-env:Body></soap-env:Envelope>";

    const parsed = parseSoapResult(answer, "ZMCP_ADT_DISPATCH");

    expect(parsed.EV_SUBRC).toBe("0");
    expect(JSON.parse(parsed.EV_RESULT ?? "{}")).toEqual({ HEADER: "0100", note: "a & b" });
  });

  it("surfaces a SOAP fault instead of an empty result", () => {
    const answer =
      '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">' +
      "<soap-env:Body><soap-env:Fault><faultstring>RFC_ERROR</faultstring></soap-env:Fault>" +
      "</soap-env:Body></soap-env:Envelope>";

    expect(() => parseSoapResult(answer, "ZMCP_ADT_DISPATCH")).toThrow(/RFC_ERROR/);
  });

  it("sends the text-pool parameters flat, not wrapped in a JSON string", () => {
    // The text-pool function module reads IV_PROGRAM / IV_TEXTPOOL_JSON directly;
    // wrapping them the way the dispatcher wants fails with "IV_TEXTPOOL_JSON is
    // required for action WRITE".
    let sent = "";
    const session = new AdtSession({
      url: "https://sap.example.com:44300",
      client: "400",
      username: "u",
      password: "p",
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        sent = String(init?.body ?? "");
        return new Response(
          "<soap-env:Envelope><soap-env:Body><urn:ZMCP_ADT_TEXTPOOL.Response>" +
            '<EV_RESULT>[{&quot;ID&quot;:&quot;I&quot;,&quot;KEY&quot;:&quot;001&quot;,&quot;ENTRY&quot;:&quot;x&quot;}]</EV_RESULT>' +
            "<EV_SUBRC>0</EV_SUBRC></urn:ZMCP_ADT_TEXTPOOL.Response></soap-env:Body></soap-env:Envelope>",
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    return new RfcBridge(session)
      .textpool("WRITE", { program: "ZFOO", language: "E", textpool_json: '[{"ID":"I"}]' })
      .then((result) => {
        expect(sent).toContain("<IV_PROGRAM>ZFOO</IV_PROGRAM>");
        expect(sent).toContain("<IV_TEXTPOOL_JSON>");
        expect(sent).not.toContain("<IV_PARAMS>");
        expect(result.subrc).toBe(0);
      });
  });
});

describe("route table", () => {
  it("boots without a duplicate handler and covers every route it advertises", () => {
    // Registering twice throws by design; this catches a table row and a bridge
    // tool claiming the same name, which is how the CUA family is split.
    const registry = bootedRegistry();
    const coverage = registry.coverage();

    expect(coverage.total).toBe(335);
    expect(coverage.missing).toEqual([]);
    expect(coverage.missing).not.toContain("GetScreen");
    expect(coverage.missing).not.toContain("CreateGuiStatus");
    expect(coverage.missing).not.toContain("HandlerGet");
    expect(coverage.missing).not.toContain("UpdateLocalDefinitions");
  });

  it("keeps the caller's lock in the low-level GUI status delete", async () => {
    const registry = bootedRegistry();
    await expect(registry.call("DeleteGuiStatusLow", { program_name: "ZZ_PROBE", status_name: "S" }, { system: "probe" }))
      .rejects.toThrow(/lock_handle/);
  });
});

describe("class-local writes", () => {
  /** A session that answers the lock with a handle and records every request. */
  function lockedRegistry(): { call: (tool: string, args: Record<string, unknown>) => Promise<unknown>; requests: string[] } {
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(`${init?.method ?? "GET"} ${decodeURIComponent(url)}`);
      const body = /_action=LOCK/.test(url)
        ? '<asx:abap><asx:values><DATA><LOCK_HANDLE>ABC123</LOCK_HANDLE><CORRNR>DS4K900001</CORRNR></DATA></asx:values></asx:abap>'
        : "<ok/>";
      return new Response(body, { status: 200, headers: { "x-csrf-token": "token" } });
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
    return { requests, call: (tool, args) => registry.call(tool, args, { system: "probe" }) };
  }

  it("locks the include, writes it, and gives the lock back", async () => {
    const { call, requests } = lockedRegistry();
    await call("UpdateLocalDefinitions", {
      class_name: "ZCL_PROBE_ROUTE",
      definitions_code: "TYPES ty_count TYPE i.",
    });
    const writes = requests.filter((line) => !line.includes("/discovery"));
    const paths = writes.map((line) => line.split(" ")[1] ?? "");
    expect(paths[0]).toContain("/oo/classes/zcl_probe_route/includes/definitions?_action=LOCK");
    expect(writes[1]?.startsWith("PUT")).toBe(true);
    expect(paths[1]).toContain("/oo/classes/zcl_probe_route/includes/definitions?lockHandle=ABC123");
    expect(paths[2]).toContain("_action=UNLOCK&lockHandle=ABC123");
  });

  it("deletes the generated CDS test class through the lock-and-delete path", async () => {
    const { call, requests } = lockedRegistry();
    const answer = (await call("DeleteCdsUnitTest", { class_name: "ZCL_PROBE_ROUTE" })) as { deleted?: boolean };
    expect(answer.deleted).toBe(true);
    const paths = requests.filter((line) => !line.includes("/discovery")).map((line) => line.split(" ")[1] ?? "");
    expect(paths[0]).toContain("/oo/classes/zcl_probe_route?_action=LOCK");
    expect(requests.some((line) => line.startsWith("DELETE") && line.includes("lockHandle=ABC123"))).toBe(true);
  });
});
