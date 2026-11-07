/**
 * Service binding types are a `namedItemList`, not a list of plain names.
 *
 * Measured live on DS4/100: `ListServiceBindingTypes {}` answered the raw
 * named-item document, in which `nameditem:description` is the version index (0 / 1) and
 * `nameditem:data` is the label ("ODATA V4") — the value `CreateServiceBinding` takes as
 * `binding_type`. `response_format` was ignored because the tool was a fixed route.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-srvb-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "ZH", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const BINDING_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<nameditem:namedItemList xmlns:nameditem="http://www.sap.com/adt/nameditem">
  <nameditem:totalItemCount>6</nameditem:totalItemCount>
  <nameditem:namedItem><nameditem:name>INA</nameditem:name><nameditem:description>0</nameditem:description><nameditem:data>INA</nameditem:data></nameditem:namedItem>
  <nameditem:namedItem><nameditem:name>ODATA</nameditem:name><nameditem:description>0</nameditem:description><nameditem:data>ODATA V2</nameditem:data></nameditem:namedItem>
  <nameditem:namedItem><nameditem:name>ODATA</nameditem:name><nameditem:description>1</nameditem:description><nameditem:data>ODATA V2</nameditem:data></nameditem:namedItem>
  <nameditem:namedItem><nameditem:name>ODATA</nameditem:name><nameditem:description>0</nameditem:description><nameditem:data>ODATA V4</nameditem:data></nameditem:namedItem>
  <nameditem:namedItem><nameditem:name>ODATA</nameditem:name><nameditem:description>1</nameditem:description><nameditem:data>ODATA V4</nameditem:data></nameditem:namedItem>
  <nameditem:namedItem><nameditem:name>SQL</nameditem:name><nameditem:description>1</nameditem:description><nameditem:data>SQL</nameditem:data></nameditem:namedItem>
</nameditem:namedItemList>`;

function harness() {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url.pathname);
    return new Response(BINDING_TYPES, { status: 200, headers: { "content-type": "application/xml" } });
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
  registerReadTools(registry, runtime);
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await registry.call(tool, args, { system: "probe" } as never)) as Record<string, unknown>;
  return { call, urls };
}

describe("ListServiceBindingTypes", () => {
  it("parses the named-item list, keeping the version that tells V2 from V4", async () => {
    const { call } = harness();
    const answer = await call("ListServiceBindingTypes", {});

    expect(answer["count"]).toBe(6);
    const types = answer["types"] as Array<Record<string, unknown>>;
    expect(types[3]).toEqual({ name: "ODATA", version: 0, label: "ODATA V4" });
    expect(types[4]).toEqual({ name: "ODATA", version: 1, label: "ODATA V4" });
    expect(answer["binding_types"]).toEqual(["INA", "ODATA V2", "ODATA V4", "SQL"]);
    expect(answer["raw_xml"]).toBeTypeOf("string");
  });

  it("keeps the raw document only for response_format=xml", async () => {
    const { call } = harness();
    const json = await call("ListServiceBindingTypes", { response_format: "json" });
    expect(json["raw_xml"]).toBeUndefined();
    expect(json["count"]).toBe(6);

    const plain = await call("HandlerServiceBindingListTypes", { response_format: "plain" });
    expect(plain["raw_xml"]).toBeUndefined();
    expect(String(plain["text"])).toContain("ODATA V4  (ODATA, v0)");
  });
});
