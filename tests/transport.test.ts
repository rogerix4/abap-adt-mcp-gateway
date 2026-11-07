/**
 * `GetTransport` promised metadata, included objects and status, and answered 123 KB of raw XML.
 *
 * Measured live on DS4/100: `GetTransport {transport_number: "DEVK900419"}` answered
 * `{success, transport_number, raw_xml}` — the request header, its task and its 110 objects were
 * inside the document but nothing was parsed, and `include_objects` / `include_tasks` were ignored.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-transport-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "100", language: "ZH", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const REQUEST = `<?xml version="1.0" encoding="utf-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="DEVK900419">
  <tm:request tm:number="DEVK900419" tm:parent="" tm:owner="CON_DP" tm:desc="MCP RAP smoke 20261104"
    tm:type="K" tm:status="D" tm:status_text="可修改的" tm:target="QS4" tm:source_client="100"
    tm:lastchanged_timestamp="20261104190344" tm:uri="/sap/bc/adt/cts/transportrequests/DEVK900419">
    <tm:task tm:number="DEVK900420" tm:parent="DEVK900419" tm:owner="CON_DP" tm:desc="MCP RAP smoke 20261104"
      tm:type="Development/Correction" tm:status="D" tm:status_text="可修改的" tm:uri="/sap/bc/adt/cts/transportrequests/DEVK900420"/>
    <tm:abap_object tm:pgmid="R3TR" tm:type="DDLS" tm:name="ZV_MCP_T03" tm:wbtype="DDLS/DF"
      tm:obj_info="Data Definition" tm:obj_desc="Z V MCP" tm:position="000001" tm:lock_status="X"/>
    <tm:abap_object tm:pgmid="R3TR" tm:type="SRVB" tm:name="ZUI_MCP_T03_O4" tm:wbtype="SRVB/SVB"
      tm:obj_info="Service Binding" tm:obj_desc="ZUI" tm:position="000002" tm:lock_status=""/>
  </tm:request>
</tm:root>`;

function harness() {
  const fetchImpl = (async () =>
    new Response(REQUEST, { status: 200, headers: { "content-type": "application/xml" } })) as typeof fetch;
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
  return { call };
}

describe("GetTransport", () => {
  it("parses the header, the task and the objects", async () => {
    const { call } = harness();
    const answer = await call("GetTransport", { transport_number: "DEVK900419" });

    expect(answer["header"]).toMatchObject({
      number: "DEVK900419",
      owner: "CON_DP",
      description: "MCP RAP smoke 20261104",
      status: "D",
      status_text: "可修改的",
      target: "QS4",
    });
    expect(answer["task_count"]).toBe(1);
    expect((answer["tasks"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      number: "DEVK900420",
      parent: "DEVK900419",
      type: "Development/Correction",
    });
    expect(answer["object_count"]).toBe(2);
    expect((answer["objects"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      pgmid: "R3TR",
      type: "DDLS",
      name: "ZV_MCP_T03",
      locked: true,
    });
    expect(answer["raw_xml"]).toBeUndefined();
  });

  it("honours include_objects / include_tasks", async () => {
    const { call } = harness();
    const answer = await call("GetTransport", {
      transport_number: "DEVK900419",
      include_objects: false,
      include_tasks: false,
    });

    expect(answer["objects"]).toBeUndefined();
    expect(answer["tasks"]).toBeUndefined();
    expect(answer["object_count"]).toBe(0);
  });
});
