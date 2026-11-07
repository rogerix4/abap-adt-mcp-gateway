/**
 * `GetTypeInfo` promises domain / data-element / structure / table-type definitions.
 *
 * Measured live on DS4/100: `GetTypeInfo {type_name: "BAPIRET2"}` answered
 * `{kind: "structure", count: 0, fields: [], raw_xml: "<blue:blueSource …>"}` — the structures
 * endpoint returns the object header with a `sourceUri` and no `<field>` elements, so the field
 * list came from DD03L instead. A table type names its row type (DD40L), a domain its own type
 * and fixed values (DD07L).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-typeinfo-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "100", language: "EN", systemType: "onprem" },
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

/** Everything except the DDIC resources answers 404, so the fallback chain is exercised. */
function harness() {
  const queries: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/datapreview/freestyle")) {
      const sql = String(init?.body ?? "");
      queries.push(sql);
      if (sql.includes("FROM DD03L")) {
        if (sql.includes("'T000'")) {
          return new Response(
            TABLE_DATA(
              COLUMN("FIELDNAME", ["MANDT", "MTEXT"]),
              COLUMN("POSITION", ["0001", "0002"]),
              COLUMN("KEYFLAG", ["X", ""]),
              COLUMN("ROLLNAME", ["MANDT", "MTEXT_D"]),
              COLUMN("DATATYPE", ["CLNT", "CHAR"]),
              COLUMN("LENG", ["000003", "000025"]),
              COLUMN("DECIMALS", ["000000", "000000"]),
            ),
            { status: 200, headers: { "content-type": "application/xml" } },
          );
        }
        if (!sql.includes("'BAPIRET2'")) {
          return new Response(TABLE_DATA(), { status: 200, headers: { "content-type": "application/xml" } });
        }
        return new Response(
          TABLE_DATA(
            COLUMN("FIELDNAME", ["TYPE", "NUMBER"]),
            COLUMN("POSITION", ["0001", "0003"]),
            COLUMN("KEYFLAG", ["", ""]),
            COLUMN("ROLLNAME", ["BAPI_MTYPE", "SYMSGNO"]),
            COLUMN("DATATYPE", ["CHAR", "NUMC"]),
            COLUMN("LENG", ["000001", "000003"]),
            COLUMN("DECIMALS", ["000000", "000000"]),
          ),
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      if (sql.includes("FROM DD02L")) {
        const name = /TABNAME = '([^']+)'/.exec(sql)?.[1] ?? "";
        const tableClass = name === "BAPIRET2" ? "INTTAB" : name === "T000" ? "TRANSP" : "";
        return new Response(
          tableClass === ""
            ? TABLE_DATA()
            : TABLE_DATA(COLUMN("TABNAME", [name]), COLUMN("TABCLASS", [tableClass])),
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      if (sql.includes("FROM DD40L")) {
        if (!sql.includes("'BAPIRET2_T'")) {
          return new Response(TABLE_DATA(), { status: 200, headers: { "content-type": "application/xml" } });
        }
        return new Response(
          TABLE_DATA(
            COLUMN("TYPENAME", ["BAPIRET2_T"]),
            COLUMN("ROWTYPE", ["BAPIRET2"]),
            COLUMN("DATATYPE", ["STRU"]),
            COLUMN("LENG", ["000000"]),
            COLUMN("DECIMALS", ["000000"]),
          ),
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      return new Response(TABLE_DATA(), { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname.includes("/ddic/structures/")) {
      return new Response(
        '<?xml version="1.0" encoding="utf-8"?><blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" ' +
          'xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" ' +
          'adtcore:name="BAPIRET2" adtcore:type="TABL/DS" adtcore:description="Returnparameter" ' +
          'abapsource:sourceUri="./bapiret2/source/main"/>',
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (url.pathname.includes("/ddic/domains/") && url.pathname.endsWith("/zd_mcp_dom_t01")) {
      // Trimmed from the live answer of a `$TMP` probe domain.
      return new Response(
        '<?xml version="1.0" encoding="utf-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ' +
          'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZD_MCP_DOM_T01" adtcore:type="DOMA/DD" ' +
          'adtcore:description="MCP type-info probe"><doma:content><doma:typeInformation>' +
          '<doma:datatype>CHAR</doma:datatype><doma:length>000010</doma:length><doma:decimals>000000</doma:decimals>' +
          '</doma:typeInformation><doma:outputInformation><doma:length>000010</doma:length><doma:conversionExit/>' +
          '<doma:signExists>false</doma:signExists><doma:lowercase>true</doma:lowercase></doma:outputInformation>' +
          '<doma:valueInformation><doma:fixValues><doma:fixValue><doma:position>0001</doma:position>' +
          '<doma:low>A</doma:low><doma:high/><doma:text>Alpha</doma:text></doma:fixValue></doma:fixValues>' +
          '</doma:valueInformation></doma:content></doma:domain>',
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    return new Response("<error/>", { status: 404 });
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

describe("GetTypeInfo", () => {
  it("lists a structure's fields from DD03L when the structures endpoint carries none", async () => {
    const { call, queries } = harness();
    const answer = await call("GetTypeInfo", { type_name: "BAPIRET2" });

    expect(answer["kind"]).toBe("structure");
    expect(answer["count"]).toBe(2);
    const fields = answer["fields"] as Array<Record<string, unknown>>;
    expect(fields[0]).toMatchObject({ name: "TYPE", data_element: "BAPI_MTYPE", type: "CHAR", length: 1 });
    expect(answer["raw_xml"]).toBeUndefined();
    expect(queries.some((sql) => sql.includes("FROM DD03L"))).toBe(true);
  });

  it("answers a table type with its row type", async () => {
    const { call } = harness();
    const answer = await call("GetTypeInfo", { type_name: "BAPIRET2_T" });

    expect(answer).toMatchObject({ kind: "table_type", row_type: "BAPIRET2", row_kind: "STRU" });
  });

  it("calls a transparent table a table, and keeps its key flags", async () => {
    const { call } = harness();
    const answer = await call("GetTypeInfo", { type_name: "T000" });

    expect(answer).toMatchObject({ kind: "table", table_class: "TRANSP", count: 2 });
    const fields = answer["fields"] as Array<Record<string, unknown>>;
    expect(fields[0]).toMatchObject({ name: "MANDT", key: true, type: "CLNT", length: 3 });
  });

  it("answers a domain with its type, flags and fixed values", async () => {
    const { call } = harness();
    const answer = await call("GetTypeInfo", { type_name: "ZD_MCP_DOM_T01" });

    expect(answer).toMatchObject({
      kind: "domain",
      description: "MCP type-info probe",
      data_type: "CHAR",
      length: 10,
      lowercase: true,
      sign_exists: false,
    });
    expect(answer["fixed_values"]).toEqual([{ low: "A", text: "Alpha" }]);
  });

  it("says so when the name is not a type at all", async () => {
    const { call } = harness();
    const answer = await call("GetTypeInfo", { type_name: "ZMM_MCP_TYPE9" });

    expect(answer).toMatchObject({ kind: "unknown", count: 0 });
    expect(String(answer["detail"] ?? "")).toContain("no data element");
  });
});
