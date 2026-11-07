/**
 * `CreateTransport` reports whether the new number is readable right now.
 *
 * Measured live on DS4/100: creations answered `201` with a fresh number and read back
 * `404` minutes later — because the probe requests had been deleted in SE09. The same tool's next
 * creation (`<sid>K900513`, with one object recorded into it) stayed readable. So a number in a 201
 * body proves nothing on its own, and a read-back is a snapshot: it catches "not there now" without
 * claiming whom to blame.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-createtr-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "100", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const CREATED =
  '<?xml version="1.0" encoding="utf-8"?><tm:root tm:useraction="newrequest" ' +
  'xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:request tm:number="DEVK900999" tm:desc="probe" ' +
  'tm:type="K" tm:target="QS4" tm:uri="/sap/bc/adt/vit/wb/object_type/%20%20%20%20rq/object_name/DEVK900999"/>' +
  "</tm:root>";

function harness(readable: boolean) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (method === "POST") return new Response(CREATED, { status: 201 });
    if (!readable) return new Response("<error/>", { status: 404 });
    return new Response(CREATED.replace("newrequest", "reading"), { status: 200 });
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
  return { call, calls };
}

describe("CreateTransport", () => {
  it("confirms the new request by reading it back", async () => {
    const { call, calls } = harness(true);
    const answer = await call("CreateTransport", { description: "probe", target_system: "QS4" });

    expect(answer).toMatchObject({ success: true, transport_number: "DEVK900999", verified: true });
    // The read-back is the proof: the number alone says nothing (see the phantom case below).
    expect(calls.some((entry) => /^GET .*\/cts\/transportrequests\//i.test(entry))).toBe(true);
  });

  it("keeps the answer honest when the number cannot be read back yet", async () => {
    const { call } = harness(false);
    const answer = await call("CreateTransport", { description: "probe", target_system: "QS4" });

    // The creation did happen (SAP answered with a number) — the read-back is only a snapshot, so a
    // missing read must not be turned into "the creation failed".
    expect(answer).toMatchObject({ success: true, verified: false, transport_number: "DEVK900999" });
    expect(String(answer["note"] ?? "")).toContain("SE09");
  });

  it("still refuses a call without target_system, as the user ruling requires", async () => {
    const { call } = harness(true);
    await expect(call("CreateTransport", { description: "probe" })).rejects.toThrow(/target_system/);
  });
});
