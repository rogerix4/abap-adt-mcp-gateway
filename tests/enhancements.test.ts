/**
 * `GetEnhancements` / `GetEnhancementSpot` answered the raw ADT document.
 *
 * Measured live on DS4/100: `GetEnhancements {object_name: "SAPMV45A", object_type:
 * "PROG/P"}` came back as `raw_xml` with four `<enh:enhancementImplementations>` blocks, each
 * carrying its code as **base64** inside `<enh:source>` — the caller had to decode it and match
 * `<enh:enhancedObject>` by hand. `GetEnhancementSpot` likewise returned only `raw_xml`.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-enhancements-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "100", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const code = Buffer.from("ENHANCEMENT 1 probe.\n  WRITE / 'x'.\nENDENHANCEMENT.", "utf8").toString("base64");

/** Trimmed from the live answer for SAPMV45A. */
const ENHANCEMENTS =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<enh:enhancements xmlns:enh="http://www.sap.com/adt/abapsource/enhancements" ' +
  'xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<enh:enhancementImplementations adtcore:name="FSH_DET_PROCESS" adtcore:type="ENHO/XHH" adtcore:version="active">' +
  `<enh:elements><enh:sourceCodePlugin enh:uri="/sap/bc/adt/enhancements/enhoxhh/fsh_det_process/source/main#start=1,0" ` +
  `enh:id="1 " enh:full_name="\\PR:SAPMV45A\\EX:SAPMV45A_04\\EI" enh:mode="static" enh:replacing="false">` +
  `<enh:source>${code}</enh:source><enh:option><enh:sourceCodePluginOption />` +
  '<enh:position adtcore:uri="/sap/bc/adt/programs/programs/sapmv45a/source/main#start=89,0"/></enh:option>' +
  "</enh:sourceCodePlugin></enh:elements>" +
  '<enh:switch enh:state="off"><enh:ref adtcore:type="SFSW/6S" adtcore:name="SFSW_FASHION"/></enh:switch>' +
  '<enh:enhancedObject adtcore:uri="/sap/bc/adt/programs/programs/sapmv45a" adtcore:type="PROG/P" adtcore:name="SAPMV45A"/>' +
  "</enh:enhancementImplementations></enh:enhancements>";

/** Trimmed from the live answer for ES_BADI_ME_PIC_DFPS_SPECIAL. */
const SPOT =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<enhs:objectData xmlns:enhs="http://www.sap.com/adt/enhancements/enhs" xmlns:adtcore="http://www.sap.com/adt/core" ' +
  'xmlns:enhcore="http://www.sap.com/abapsource/enhancementscore" adtcore:name="ES_BADI_ME_PIC_DFPS_SPECIAL" ' +
  'adtcore:type="ENHS/XSB" adtcore:description="Special DFPS Settings" adtcore:responsible="SAP" adtcore:version="active">' +
  '<adtcore:packageRef adtcore:name="ME" adtcore:type="DEVC/K"/>' +
  '<enhs:contentCommon enhs:toolType="BADI_DEF">' +
  '<enhs:usages><enhcore:referencedObject enhcore:element_usage="USEO">' +
  '<enhcore:objectReference adtcore:uri="/sap/bc/adt/oo/interfaces/if_badi_me_pic_modify_dfps" ' +
  'adtcore:type="INTF/OI" adtcore:name="IF_BADI_ME_PIC_MODIFY_DFPS"/>' +
  "</enhcore:referencedObject></enhs:usages></enhs:contentCommon>" +
  '<enhs:contentSpecific><enhs:badiTechnology><enhs:badiDefinitions>' +
  '<enhs:badiDefinition enhs:name="ME_PIC_MODIFY_DFPS" enhs:shorttext="Changing of Data" enhs:singleUse="true" ' +
  'enhs:useFallbackClass="false">' +
  '<enhs:interface adtcore:uri="/sap/bc/adt/oo/interfaces/if_badi_me_pic_modify_dfps" adtcore:type="INTF/OI" ' +
  'adtcore:name="IF_BADI_ME_PIC_MODIFY_DFPS"/>' +
  "</enhs:badiDefinition></enhs:badiDefinitions></enhs:badiTechnology></enhs:contentSpecific></enhs:objectData>";

function harness() {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/enhancements/enhsxsb/") || url.pathname.includes("/enhancements/enhsxs/")) {
      return new Response(SPOT, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname.endsWith("/enhancements/elements")) {
      if (url.pathname.includes("/zmmr_mcp_ltprog/")) {
        return new Response(
          '<?xml version="1.0" encoding="utf-8"?><enh:enhancements xmlns:enh="http://www.sap.com/adt/abapsource/enhancements"/>',
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      return new Response(ENHANCEMENTS, { status: 200, headers: { "content-type": "application/xml" } });
    }
    return new Response("<ok/>", { status: 200 });
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
  return { call };
}

describe("GetEnhancements", () => {
  it("decodes the base64 source and names the enhanced object", async () => {
    const { call } = harness();
    const answer = await call("GetEnhancements", { object_name: "SAPMV45A", object_type: "PROG/P" });

    expect(answer["count"]).toBe(1);
    const [implementation] = answer["enhancements"] as Array<Record<string, unknown>>;
    expect(implementation).toMatchObject({
      name: "FSH_DET_PROCESS",
      type: "ENHO/XHH",
      enhanced_object: { name: "SAPMV45A", type: "PROG/P" },
      switch: { state: "off", name: "SFSW_FASHION" },
      element_count: 1,
    });
    const [element] = implementation?.["elements"] as Array<Record<string, unknown>>;
    // `row` is the line inside the enhancement, `object_row` the line in the enhanced program.
    expect(element).toMatchObject({ id: "1", mode: "static", replacing: false, row: 1, column: 0, object_row: 89 });
    expect(element?.["first_line"]).toBe("ENHANCEMENT 1 probe.");
    expect(answer["raw_xml"]).toBeUndefined();
  });

  it("says so when the object carries no enhancement", async () => {
    const { call } = harness();
    const answer = await call("GetEnhancements", { object_name: "ZMMR_MCP_LTPROG", object_type: "PROG/P" });

    expect(answer["count"]).toBe(0);
    expect(String(answer["note"] ?? "")).toContain("no enhancement");
  });
});

describe("GetEnhancementSpot", () => {
  it("answers package, tool type, usages and BAdI definitions", async () => {
    const { call } = harness();
    const answer = await call("GetEnhancementSpot", { enhancement_spot: "ES_BADI_ME_PIC_DFPS_SPECIAL" });

    expect(answer).toMatchObject({
      enhancement_spot: "ES_BADI_ME_PIC_DFPS_SPECIAL",
      name: "ES_BADI_ME_PIC_DFPS_SPECIAL",
      type: "ENHS/XSB",
      description: "Special DFPS Settings",
      package_name: "ME",
      tool_type: "BADI_DEF",
      usage_count: 1,
      badi_definition_count: 1,
    });
    expect((answer["badi_definitions"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "ME_PIC_MODIFY_DFPS",
      single_use: true,
      interface: "IF_BADI_ME_PIC_MODIFY_DFPS",
    });
    expect(answer["raw_xml"]).toBeUndefined();
  });
});

describe("GetEnhancementImpl", () => {
  it("answers not-found when neither the resource nor a candidate class has source", async () => {
    // Measured: this answered `UPSTREAM_FAILED` for an enhancement that does not exist.
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
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
    await expect(
      registry.call("GetEnhancementImpl", { enhancement_spot: "ES_SD_SALES", enhancement_name: "PROBE" }, { system: "probe" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});
