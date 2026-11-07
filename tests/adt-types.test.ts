/**
 * `GetAdtTypes` promised "all valid ADT object types" and `validate_type`; it answered the raw
 * discovery document.
 *
 * Measured live on DS4/100: `GetAdtTypes {}` came back as a 400 KB
 * `app:service` document (126 workspaces, 833 collections) with no parsed list, and
 * `validate_type` was never read — the tool was a fixed route to `/discovery`.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-adttypes-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "ZH", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const DISCOVERY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<app:service xmlns:app="http://www.w3.org/2007/app" xmlns:atom="http://www.w3.org/2005/Atom">' +
  "<app:workspace><atom:title>ABAP Repository</atom:title>" +
  '<app:collection href="/sap/bc/adt/oo/classes"><atom:title>Classes</atom:title>' +
  "<app:accept>application/vnd.sap.adt.oo.classes.v4+xml</app:accept></app:collection>" +
  '<app:collection href="/sap/bc/adt/ddic/tables"><atom:title>Tables</atom:title></app:collection>' +
  "</app:workspace>" +
  "<app:workspace><atom:title>BOPF</atom:title>" +
  '<app:collection href="/sap/bc/adt/bopf/businessobjects"><atom:title>Business Objects</atom:title></app:collection>' +
  "</app:workspace></app:service>";

function harness() {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/discovery")) {
      return new Response(DISCOVERY, { status: 200, headers: { "content-type": "application/atomsvc+xml" } });
    }
    if (url.searchParams.get("objectType") === "XXXX") {
      return new Response("<error>Value XXXX for property TYPE is invalid</error>", { status: 400 });
    }
    return new Response("<app:feed/>", { status: 200 });
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
  return { call, seen };
}

describe("GetAdtTypes", () => {
  it("parses the service catalogue into workspaces and collections", async () => {
    const { call } = harness();
    const answer = await call("GetAdtTypes", {});

    expect(answer["workspace_count"]).toBe(2);
    expect(answer["collection_count"]).toBe(3);
    const workspaces = answer["workspaces"] as Array<Record<string, unknown>>;
    expect(workspaces[0]).toMatchObject({ title: "ABAP Repository" });
    expect((workspaces[0]?.["collections"] as unknown[])[0]).toEqual({
      href: "/sap/bc/adt/oo/classes",
      title: "Classes",
    });
    expect(answer["raw_xml"]).toBeUndefined();
  });

  it("validates a type code through SAP's own objectType filter", async () => {
    const { call, seen } = harness();
    expect(await call("GetAdtTypes", { validate_type: "prog" })).toMatchObject({
      valid: true,
      validate_type: "PROG",
    });
    expect(seen.some((entry) => entry.includes("objectType=PROG"))).toBe(true);

    expect(await call("GetAdtTypes", { validate_type: "XXXX" })).toMatchObject({
      success: false,
      valid: false,
    });
  });
});
