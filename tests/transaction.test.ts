/**
 * `GetTransaction` promised program / screen / kind, and answered only the object header.
 *
 * Measured live on DS4/100: `GetTransaction {transaction_names: ["SE38","SM30","VA01"]}`
 * returned `{transaction, type, state, description, raw_xml}` — no `program_name`, no
 * `screen_number`, no `kind`, although the description offers all three from TSTC / TSTCP.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-transaction-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "ZH", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const COLUMN = (name: string, values: readonly string[]): string =>
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" ` +
  `dataPreview:colType="CHAR" dataPreview:length="20"/>` +
  `<dataPreview:dataSet>${values.map((value) => `<dataPreview:data>${value}</dataPreview:data>`).join("")}` +
  "</dataPreview:dataSet></dataPreview:columns>";

const TABLE_DATA = (...columns: readonly string[]): string =>
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData ' +
  'xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  `<dataPreview:name>X</dataPreview:name>${columns.join("")}</dataPreview:tableData>`;

const HEADER = (name: string, type: string, version: string, description: string): string =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  `<adtcore:mainObject xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name.toLowerCase()}" ` +
  `adtcore:type="${type}" adtcore:version="${version}" adtcore:description="${description}" ` +
  'adtcore:language="ZH"/>';

/** TSTC / TSTCP answers keyed by table name; everything else is the object header. */
function harness() {
  const queries: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/datapreview/freestyle")) {
      const sql = String(init?.body ?? "");
      queries.push(sql);
      const body = sql.includes("FROM TSTCP")
        ? TABLE_DATA(COLUMN("TCODE", ["SM30"]), COLUMN("PARAM", ["VIEWNAME=&amp;VIEWNAME"]))
        : TABLE_DATA(
            COLUMN("TCODE", ["SE38", "SM30"]),
            COLUMN("PGMNA", ["RSABAPPROGRAM", "SAPMSVMA"]),
            COLUMN("DYPNO", ["1000", "0100"]),
          );
      return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
    }
    const name = url.pathname.split("/").pop() ?? "";
    if (name === "se38") return new Response(HEADER("se38", "TRAN/T", "active", "ABAP 编辑器"), { status: 200 });
    if (name === "sm30") return new Response(HEADER("sm30", "TRAN/T", "active", "调用视图维护"), { status: 200 });
    return new Response("error", { status: 404 });
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
  return { call, queries };
}

describe("GetTransaction", () => {
  it("merges TSTC / TSTCP into the transaction entry", async () => {
    const { call, queries } = harness();
    const answer = await call("GetTransaction", { transaction_names: ["SE38", "SM30"] });
    const transactions = answer["transactions"] as Array<Record<string, unknown>>;

    expect(transactions[0]).toMatchObject({
      transaction: "SE38",
      description: "ABAP 编辑器",
      kind: "program",
      program_name: "RSABAPPROGRAM",
      screen_number: "1000",
    });
    expect(transactions[1]).toMatchObject({
      transaction: "SM30",
      kind: "parameter",
      parameters: "VIEWNAME=&VIEWNAME",
      program_name: "SAPMSVMA",
    });
    // One batched read per table, not one per transaction.
    expect(queries).toHaveLength(2);
  });

  it("reports a transaction SAP does not know instead of inventing a program", async () => {
    const { call } = harness();
    const answer = await call("GetTransaction", { transaction_name: "ZMM_MCP_TCODE9" });
    const transactions = answer["transactions"] as Array<Record<string, unknown>>;

    expect(answer["success"]).toBe(false);
    expect(transactions[0]).toMatchObject({
      transaction: "ZMM_MCP_TCODE9",
      kind: "unknown",
      found: false,
    });
    expect(transactions[0]?.["program_name"]).toBeUndefined();
    expect(String(transactions[0]?.["error"] ?? "")).not.toHaveLength(0);
  });
});
