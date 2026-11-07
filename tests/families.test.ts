/**
 * Family handler tests.
 *
 * The order inside `Update<Family>` is the part that was wrong for a long time
 * (activation while the lock is held answers 403 "currently editing"), so it is
 * asserted here rather than trusted.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.ts";
import { implementedFamilies, registerFamilies } from "../src/families/index.ts";
import { GatewayRuntime } from "../src/runtime.ts";

const CSRF = { status: 200, headers: { "x-csrf-token": "t" }, body: "<d/>" };

// Every file that locks needs its own journal: a shared one makes LOCK release a stale
// entry first, which shifts each scripted response by one request.
process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-families-${process.pid}.json`);

function system(tier = "dev") {
  return {
    id: "probe",
    tier,
    endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
    auth: { type: "basic", username: "env:U", password: "env:P" },
    rfcBackend: "soap",
    env: {},
  } as never;
}

function scriptedFetch(script: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: { method: string; url: string; body: string | undefined; headers: Record<string, string> }[] = [];
  let index = 0;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: typeof init?.body === "string" ? init.body : undefined,
      headers,
    });
    const step = script[index] ?? script.at(-1) ?? { status: 500 };
    index += 1;
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(step.headers ?? {})) responseHeaders.append(key, value);
    return { status: step.status, headers: responseHeaders, text: async () => step.body ?? "" } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function build(fetchImpl: typeof fetch, tier = "dev") {
  const runtime = new GatewayRuntime([system(tier)], (s) =>
    new AdtSession({
      url: s.endpoint.url,
      client: s.endpoint.client,
      language: s.endpoint.language,
      username: "u",
      password: "p",
      fetchImpl,
    }),
  );
  const registry = createRegistry();
  registerFamilies(registry, runtime);
  return { registry, runtime };
}

describe("family registration", () => {
  it("registers the measured families without inventing tool names", () => {
    const { registry } = build((async () => ({ status: 200, headers: new Headers(), text: async () => "" })) as unknown as typeof fetch);
    const coverage = registry.coverage();

    expect(implementedFamilies.map((family) => family.id)).toEqual([
      "Program",
      "Class",
      "Interface",
      "Table",
      "Structure",
      "DataElement",
      "Domain",
      "CdsView",
      "MetadataExtension",
      "FunctionGroup",
      "FunctionModule",
      "Include",
      "ServiceDefinition",
      "Package",
      "BehaviorDefinition",
      "BehaviorImplementation",
      "ServiceBinding",
    ]);
    for (const family of implementedFamilies) {
      // BehaviorDefinition is created as `CreateBehaviorDefinition`, so the generic
      // name check holds for every family.
      expect(registry.has(`Create${family.id}`)).toBe(true);
    }

    const missing = coverage.missing;
    expect(missing).not.toContain("CreateProgram");
    expect(missing).not.toContain("UpdateProgramLow");
    expect(missing).not.toContain("CreateClass");
    expect(missing).not.toContain("CreateDataElement");
    expect(missing).not.toContain("CreateFunctionGroup");
    expect(missing).not.toContain("UpdateFunctionModuleLow");
    expect(missing).not.toContain("GetSession");
    // A verb the catalog does not have must not appear.
    expect(registry.has("ActivateProgram")).toBe(false);
    expect(registry.has("UpdateFunctionGroupLow")).toBe(false);
    expect(registry.has("WhereUsedTable")).toBe(false);
  });

  it("covers every verb the catalog defines for a measured family", () => {
    const { registry } = build((async () => ({ status: 200, headers: new Headers(), text: async () => "" })) as unknown as typeof fetch);
    const coverage = registry.coverage();
    const familyNames = implementedFamilies.map((family) => family.id).join("|");
    const pattern = new RegExp(`^(Create|Update|Delete|Read|Get|Activate|Check|Validate|Lock|Unlock)(${familyNames})(Low)?$`);
    const stillMissing = coverage.missing.filter((name) => pattern.test(name));
    expect(stillMissing).toEqual([]);

    // Counted from the catalog rather than from a fixed number: family verb sets
    // differ (a function group has no UpdateLow), and non-family tools
    // (GetSession, the read-only surface) add to the total as they land.
    const expected = registry.list().filter((entry) => pattern.test(entry.definition.name)).length;
    expect(expected).toBeGreaterThan(0);
    expect(coverage.implemented).toBeGreaterThanOrEqual(expected + 1);
  });
});

describe("UpdateProgram order", () => {
  it("locks, writes, unlocks, activates and then verifies against the active version", async () => {
    const { impl, calls } = scriptedFetch([
      CSRF, // discovery for CSRF
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: "" }, // PUT
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
      { status: 200, body: "REPORT zfoo.\n\nWRITE 'x'.\n" }, // read active
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateProgram",
      { program_name: "ZFOO", source_code: "REPORT zfoo.\n\nWRITE 'x'.\n" },
      { system: "probe" },
    )) as { success: boolean; activated: boolean };

    expect(result.activated).toBe(true);
    expect(result.success).toBe(true);

    const methods = calls.filter((call) => !call.url.includes("/discovery")).map((call) => call.method);
    expect(methods).toEqual(["POST", "PUT", "POST", "POST", "GET"]);

    expect(calls[1]?.url).toContain("_action=LOCK");
    expect(calls[2]?.url).toContain("lockHandle=H1");
    expect(calls[3]?.url).toContain("_action=UNLOCK");
    expect(calls[4]?.url).toContain("/activation?method=activate");
    expect(calls[5]?.url).toContain("version=active");
  });

  it("reports a mismatch instead of claiming success when the active source differs", async () => {
    const { impl } = scriptedFetch([
      CSRF,
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" },
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: "something else entirely\n" },
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateProgram",
      { program_name: "ZFOO", source_code: "REPORT zfoo.\n" },
      { system: "probe" },
    )) as { success: boolean; activated: boolean; mismatch?: string };

    expect(result.activated).toBe(false);
    expect(result.success).toBe(false);
    expect(result.mismatch).toBeDefined();
  });
});

describe("create then read", () => {
  it("activates the new object, because a fresh class is unreadable until then", async () => {
    // Measured: in the session that created a class, every GET answers
    // "500 wrong input data for processing" until the object is activated once.
    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 200, body: "" }, // POST create
      { status: 200, body: "" }, // POST activation
    ]);
    const { registry } = build(impl);

    const created = (await registry.call(
      "CreateClass",
      { class_name: "ZCL_NEW", package_name: "$TMP", description: "x" },
      { system: "probe" },
    )) as { success: boolean; activated: boolean };

    expect(created.success).toBe(true);
    expect(created.activated).toBe(true);
    expect(calls.some((call) => call.url.includes("/activation?method=activate"))).toBe(true);
  });

  it("still reports success when the activation of an empty object fails", async () => {
    const { impl } = scriptedFetch([
      CSRF,
      { status: 200, body: "" },
      { status: 500, body: "<message>nothing to activate</message>" },
      { status: 500, body: "<message>nothing to activate</message>" },
    ]);
    const { registry } = build(impl);

    const created = (await registry.call(
      "CreateTable",
      { table_name: "ZTNEW", package_name: "$TMP" },
      { system: "probe" },
    )) as { success: boolean; activated: boolean; activation_note?: string };

    expect(created.success).toBe(true);
    expect(created.activated).toBe(false);
    expect(created.activation_note).toBeDefined();
  });
});

describe("family content shapes", () => {
  it("writes DDIC source to source/main as text/plain", async () => {
    // Measured: the object document of a table carries no content element
    // at all, so a `blue:content` body is accepted with 200 and **ignored** — the
    // table keeps its generated skeleton. `source/main` is the target that stores it.
    const ddl = "define table ztfoo {\n  key mandt : mandt not null;\n}\n";
    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: "" }, // PUT source/main
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
      { status: 200, body: ddl }, // read active, identical after normalisation
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateTable",
      { table_name: "ZTFOO", ddl_code: ddl },
      { system: "probe" },
    )) as { activated: boolean };

    expect(result.activated).toBe(true);

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toMatch(/\/ddic\/tables\/ztfoo\/source\/main\?lockHandle=H1/);
    expect(put?.headers?.["content-type"]).toContain("text/plain");
    // The source argument is trimmed before it is sent (one trailing newline less than
    // the caller wrote); the DDL itself must arrive verbatim.
    expect((put?.body ?? "").trim()).toBe(ddl.trim());
  });

  it("fails activation when what SAP stored is not what was written", async () => {
    // The falsest possible success: 200 on every request while the body never landed.
    // Comparing the stored source (ignoring blank lines SAP inserts) catches it.
    const { impl } = scriptedFetch([
      CSRF,
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" },
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: "define table ztfoo {\n\n  key client : abap.clnt not null;\n\n}" },
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateTable",
      { table_name: "ZTFOO", ddl_code: "define table ztfoo {\n  key mandt : mandt not null;\n}\n" },
      { system: "probe" },
    )) as { activated: boolean; mismatch?: string };

    expect(result.activated).toBe(false);
    expect(result.mismatch).toBeDefined();
  });
});

describe("read-modify-write updates", () => {
  it("patches only what the caller set, keeping SAP-managed fields", async () => {
    // The contract's Update verbs for DDIC take structured fields, not a document,
    // so the engine reads the current XML and changes just those fields.
    const current =
      '<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      'adtcore:responsible="SAP" adtcore:masterLanguage="DE" adtcore:name="ZD_X" adtcore:type="DOMA/DD" adtcore:description="old">' +
      '<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>000010</doma:length><doma:decimals>000000</doma:decimals></doma:typeInformation>' +
      '<doma:valueInformation><doma:appendExists>false</doma:appendExists><doma:fixValues/></doma:valueInformation></doma:content></doma:domain>';

    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: current }, // read current (inside the lock)
      { status: 200, body: "" }, // PUT
      { status: 200, body: "" }, // unlock
      { status: 200, body: current }, // read back to confirm the properties landed
      { status: 200, body: "" }, // activation
      { status: 200, body: current }, // read back for verification
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateDomain",
      // `package_name` is required by the contract's own list — enforced now, so the fixture
      // carries it like a real caller would.
      { domain_name: "ZD_X", package_name: "$TMP", length: "20", fixed_values: [{ low: "A", text: "Alpha" }] },
      { system: "probe" },
    )) as { activated: boolean };

    expect(result.activated).toBe(true);

    const put = calls.find((call) => call.method === "PUT");
    const body = put?.body ?? "";
    expect(body).toContain('adtcore:responsible="SAP"'); // untouched
    expect(body).toContain("<doma:length>000020</doma:length>"); // patched
    expect(body).toContain("<doma:low>A</doma:low><doma:text>Alpha</doma:text>"); // measured element
  });

  it("reads the XML body for families without a text source, not text/plain", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 200, body: '<blue:wbobj adtcore:name="ZE_X"/>' },
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "ReadDataElement",
      { data_element_name: "ZE_X" },
      { system: "probe" },
    )) as { content?: string };

    expect(result.content).toContain("wbobj");
    expect(calls[0]?.headers["accept"]).toBe("application/vnd.sap.adt.dataelements.v2+xml");
  });

  it("leaves typeName empty for a predefined data element type", async () => {
    // Measured: putting the ABAP type ("CHAR") into dtel:typeName makes SBD_DATAELEMENT
    // answer "error while deserialising" and the create is rejected.
    const { impl, calls } = scriptedFetch([CSRF, { status: 200, body: "" }, { status: 200, body: "" }]);
    const { registry } = build(impl);

    await registry.call(
      "CreateDataElement",
      { data_element_name: "ZE_PREDEF", package_name: "$TMP", data_type: "CHAR", length: "20" },
      { system: "probe" },
    );

    const post = calls.find((call) => call.method === "POST");
    const body = post?.body ?? "";
    expect(body).toContain("<dtel:typeName></dtel:typeName>");
    expect(body).toContain("<dtel:dataType>CHAR</dtel:dataType>");
    expect(body).toContain("<dtel:dataTypeLength>000020</dtel:dataTypeLength>");
    // Field labels carry fixed lengths, not the label's own length.
    expect(body).toContain("<dtel:shortFieldLength>10</dtel:shortFieldLength>");
    expect(body).toContain("<dtel:headingFieldLength>55</dtel:headingFieldLength>");
  });

  it("writes the DDL of a view inside CreateCdsView when the caller supplied it", async () => {
    // CreateCdsView takes an optional ddl_source; ADT only accepts metadata on the
    // POST, so the definition goes in as a write before activation.
    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 200, body: "" }, // POST metadata
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: "" }, // PUT source/main
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
    ]);
    const { registry } = build(impl);

    const ddl = "define view ZV_LIVE as select from t000 {\n  key mandt as client\n}\n";
    const created = (await registry.call(
      "CreateCdsView",
      { view_name: "ZV_LIVE", package_name: "$TMP", ddl_source: ddl },
      { system: "probe" },
    )) as { success: boolean };

    expect(created.success).toBe(true);
    const post = calls.find((call) => call.method === "POST" && call.url.includes("/ddic/ddl/sources"));
    // The POST body stays metadata only — no DDL in it.
    expect(post?.body ?? "").not.toContain("define view");
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toContain("/ddic/ddl/sources/zv_live/source/main");
    expect(put?.body).toBe(ddl);
  });
  it("creates an include on its own collection with its own root element", async () => {
    // Measured: posting the program envelope to /programs/includes answers
    // "system expected element ...abapInclude".
    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 200, body: "" }, // POST metadata
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock for the source
      { status: 200, body: "" }, // PUT source
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
    ]);
    const { registry } = build(impl);

    const created = (await registry.call(
      "CreateInclude",
      { include_name: "ZMMR_MCP_LTPROG_I01", package_name: "$TMP", source_code: "* hello\n" },
      { system: "probe" },
    )) as { success: boolean };

    expect(created.success).toBe(true);
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toContain("/programs/includes");
    expect(post?.headers["content-type"]).toBe("application/vnd.sap.adt.programs.includes.v2+xml");
    expect(post?.body ?? "").toContain("<include:abapInclude");
    expect(post?.body ?? "").toContain('adtcore:type="PROG/I"');
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toContain("/programs/includes/zmmr_mcp_ltprog_i01/source/main");
  });
});

const SERVICE_DEFINITION = { status: 200, body: "<srvd:serviceDefinition/>" };
const BINDING_TYPES_V2 =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<nameditem:namedItemList xmlns:nameditem="http://www.sap.com/adt/nameditem">' +
  "<nameditem:namedItem><nameditem:name>ODATA</nameditem:name>" +
  "<nameditem:description>1</nameditem:description>" +
  "<nameditem:data>ODATA V2</nameditem:data></nameditem:namedItem>" +
  "</nameditem:namedItemList>";

describe("service binding lifecycle", () => {
  it("preflights, negotiates the media type and generates the service after activation", async () => {
    const { impl, calls } = scriptedFetch([
      SERVICE_DEFINITION,
      { status: 200, body: BINDING_TYPES_V2 },
      CSRF, // fetched before the first POST
      { status: 415, body: "<message>Unsupported Media Type</message>" },
      { status: 415, body: "<message>Unsupported Media Type</message>" }, // Accept: */* retry, still v2
      { status: 201, body: "" }, // POST create, retried with the v1 media type
      { status: 200, body: "" }, // activation
      { status: 200, body: "<edmx:Edmx/>" }, // generate
    ]);
    const { registry } = build(impl);

    const created = (await registry.call(
      "CreateServiceBinding",
      {
        service_binding_name: "ZSVC_PROBE",
        service_definition_name: "ZSVC_SRVD_PROBE",
        package_name: "$TMP",
        binding_type: "ODataV2",
      },
      { system: "probe" },
    )) as { success: boolean; activated: boolean; generated_info?: string };

    expect(created.success).toBe(true);
    expect(created.activated).toBe(true);
    expect(created.generated_info).toContain("Edmx");
    const posts = calls.filter((call) => call.method === "POST" && call.url.endsWith("/businessservices/bindings"));
    expect(posts).toHaveLength(3);
    expect(posts[0]?.headers.accept).toBe("application/vnd.sap.adt.businessservices.servicebinding.v2+xml");
    expect(posts[1]?.headers.accept).toBe("*/*");
    expect(posts[1]?.headers["content-type"]).toBe("application/vnd.sap.adt.businessservices.servicebinding.v2+xml");
    expect(posts[2]?.headers.accept).toBe("*/*");
    expect(posts[2]?.headers["content-type"]).toBe(
      "application/vnd.sap.adt.businessservices.servicebinding.v1+xml",
    );
    expect(calls.some((call) => call.url.includes("/businessservices/odatav2/ZSVC_PROBE"))).toBe(true);
  });

  it("honours activate:false and does not generate an inactive binding", async () => {
    const { impl, calls } = scriptedFetch([
      SERVICE_DEFINITION,
      { status: 200, body: BINDING_TYPES_V2 },
      CSRF, // fetched before the create POST
      { status: 201, body: "" }, // POST create only
    ]);
    const { registry } = build(impl);

    const created = (await registry.call(
      "CreateServiceBinding",
      {
        service_binding_name: "ZSVC_STAGED",
        service_definition_name: "ZSVC_SRVD_PROBE",
        package_name: "$TMP",
        binding_type: "ODataV2",
        activate: false,
      },
      { system: "probe" },
    )) as { success: boolean; activated: boolean; activation_note?: string };

    expect(created.success).toBe(true);
    expect(created.activated).toBe(false);
    expect(created.activation_note).toContain("activate=false");
    expect(calls.some((call) => call.url.includes("/activation?method=activate"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/businessservices/odatav2/"))).toBe(false);
  });

  it("rejects a binding type the system does not publish before creating a shell", async () => {
    const { impl, calls } = scriptedFetch([SERVICE_DEFINITION, { status: 200, body: BINDING_TYPES_V2 }]);
    const { registry } = build(impl);

    await expect(
      registry.call(
        "CreateServiceBinding",
        {
          service_binding_name: "ZSVC_V4",
          service_definition_name: "ZSVC_SRVD_PROBE",
          package_name: "$TMP",
          binding_type: "ODataV4",
        },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("not available") });

    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/businessservices/bindings"))).toBe(false);
  });

  it("unpublishes a published binding before deleting it", async () => {
    const published =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" srvb:published="true" srvb:allowedAction="UNPUBLISH">' +
      '<srvb:services srvb:name="ZSVC_PROBE"><srvb:content srvb:version="0001">' +
      '<srvb:serviceDefinition adtcore:name="ZSVC_SRVD_PROBE"/></srvb:content></srvb:services>' +
      '<srvb:binding srvb:type="ODATA" srvb:version="V2"><srvb:implementation adtcore:name="ZSVC_PROBE"/></srvb:binding>' +
      "</srvb:serviceBinding>";
    const { impl, calls } = scriptedFetch([
      { status: 200, body: published }, // beforeDelete read
      CSRF, // fetched before the unpublish POST
      { status: 200, body: "<SEVERITY>OK</SEVERITY>" }, // unpublish job
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: "" }, // DELETE
      { status: 200, body: "" }, // unlock
    ]);
    const { registry } = build(impl);

    const deleted = (await registry.call(
      "DeleteServiceBinding",
      { service_binding_name: "ZSVC_PROBE" },
      { system: "probe" },
    )) as { success: boolean; pre_delete?: { unpublished?: boolean } };

    expect(deleted.success).toBe(true);
    expect(deleted.pre_delete?.unpublished).toBe(true);
    const unpublish = calls.find((call) => call.method === "POST" && call.url.includes("/unpublishjobs"));
    expect(unpublish?.url).toContain("servicename=ZSVC_PROBE");
    expect(unpublish?.url).toContain("serviceversion=0001");
    const deleteCall = calls.find((call) => call.method === "DELETE");
    expect(deleteCall?.url).toContain("lockHandle=H1");
  });
});

describe("parent/child families", () => {
  it("addresses a function module through its group and places it by containerRef", async () => {
    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 201, body: "" }, // POST create
      { status: 200, body: "" }, // activation
    ]);
    const { registry } = build(impl);

    const created = (await registry.call(
      "CreateFunctionModule",
      { function_group_name: "ZFG_LIVE", function_module_name: "ZFM_LIVE" },
      { system: "probe" },
    )) as { success: boolean };

    expect(created.success).toBe(true);
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toContain("/functions/groups/zfg_live/fmodules");
    const body = post?.body ?? "";
    expect(body).toContain('adtcore:type="FUGR/FF"');
    expect(body).toContain('adtcore:name="ZFG_LIVE"');
    // A function module is placed by its group, not by a package reference.
    expect(body).toContain("adtcore:containerRef");
    expect(body).not.toContain("adtcore:packageRef");
  });

  it("requires the group for a function module and says which argument is missing", async () => {
    const { impl } = scriptedFetch([CSRF]);
    const { registry } = build(impl);

    await expect(
      registry.call("ReadFunctionModule", { function_module_name: "ZFM_LIVE" }, { system: "probe" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("function_group_name") });
  });

  it("accepts a function module activation that only differs in blank lines", async () => {
    // Measured: SAP keeps the signature and the implementation apart and joins
    // them with blank lines on read, so a line-for-line comparison always fails.
    const written = "FUNCTION zfm\n  EXPORTING\n    VALUE(ev_result) TYPE i.\n  ev_result = 1.\nENDFUNCTION.\n";
    const active = written.replace("\n  ev_result = 1.", "\r\n\r\n\r\n  ev_result = 1.");
    const { impl } = scriptedFetch([
      CSRF,
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: "" }, // PUT
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
      { status: 200, body: active }, // read active
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateFunctionModule",
      { function_group_name: "ZFG_LIVE", function_module_name: "ZFM_LIVE", source_code: written },
      { system: "probe" },
    )) as { activated: boolean };

    expect(result.activated).toBe(true);
  });
});

describe("write policy", () => {
  it("refuses to create into a package the schema requires but the call omits", async () => {
    // Measured on DS4/100: `CreateProgram {program_name}` answered
    // `success: true` and created the object in `$TMP`, although the contract lists
    // `package_name` under `required` — the silent default turned an intended
    // transportable object into a local one.
    const { impl, calls } = scriptedFetch([CSRF]);
    const { registry } = build(impl);

    await expect(
      registry.call("CreateProgram", { program_name: "ZFOO" }, { system: "probe" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: expect.objectContaining({ missing: "package_name" }) });

    // Refused before the network: no CSRF fetch, no POST.
    expect(calls).toHaveLength(0);
  });

  it("refuses to write to a non-dev system before touching the network", async () => {
    const { impl, calls } = scriptedFetch([CSRF]);
    const { registry } = build(impl, "prd");

    await expect(
      registry.call("CreateProgram", { program_name: "ZFOO", package_name: "$TMP" }, { system: "probe" }),
    ).rejects.toMatchObject({ code: "SYSTEM_READ_ONLY" });

    expect(calls).toHaveLength(0);
  });
});

/**
 * `Validate*` answers "is this name free?", and it used to answer **yes** whenever the
 * existence probe failed for any reason at all.
 *
 * Measured live: `ValidateClassLow {class_name: "ZCL_MCP_T01"}` on a class that
 * existed answered `{exists: false, available: true}` — the class document refused the
 * media type the probe asked for (406), and the refusal was read as absence.
 */
describe("validate honesty", () => {
  const validate = (impl: typeof fetch) =>
    build(impl).registry.call(
      "ValidateClassLow",
      { class_name: "ZCL_X", package_name: "$TMP", description: "d" },
      { system: "probe" },
    );

  it("answers available when the object document answers 404", async () => {
    // A plain GET needs no CSRF, so the first scripted step is the class document itself.
    const { impl } = scriptedFetch([{ status: 404, body: "<exc:exception/>" }]);
    await expect(validate(impl)).resolves.toMatchObject({ exists: false, available: true });
  });

  it("does not call a name free when the probe was refused for another reason", async () => {
    // 406, then the `*/*` retry inside `requestAcceptingAny` answers 406 again.
    const { impl } = scriptedFetch([{ status: 406, body: "<exc:exception/>" }]);
    await expect(validate(impl)).rejects.toMatchObject({ code: "content-negotiation" });
  });

  it("reports an existing object as taken", async () => {
    const { impl } = scriptedFetch([{ status: 200, body: "<class:abapClass/>" }]);
    await expect(validate(impl)).resolves.toMatchObject({ exists: true, available: false });
  });
});

describe("unlock honesty", () => {
  /**
 * Measured live: the program was locked, then `UnlockProgramLow` was called
   * with an invented handle and answered `success: true` while the object kept its
   * enqueue. SAP answers a plain 200 to an UNLOCK whose handle it does not know, so the
   * only client-side evidence is the lock journal.
   */
  const locked = () =>
    scriptedFetch([
      CSRF,
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: "" }, // unlock
    ]);

  it("releases a handle it issued, without the unverified caveat", async () => {
    const { impl, calls } = locked();
    const { registry } = build(impl);

    const lock = (await registry.call("LockProgramLow", { program_name: "ZFOO" }, { system: "probe" })) as {
      lock_handle: string;
    };
    const unlock = (await registry.call(
      "UnlockProgramLow",
      { program_name: "ZFOO", lock_handle: lock.lock_handle, session_id: "s1" },
      { system: "probe" },
    )) as { success: boolean; release_unverified: boolean };

    expect(unlock.success).toBe(true);
    expect(unlock.release_unverified).toBe(false);
    expect(calls.at(-1)?.url).toContain("_action=UNLOCK");
  });

  it("refuses a handle no lock of this logon is holding", async () => {
    const { impl, calls } = locked();
    const { registry } = build(impl);

    await registry.call("LockProgramLow", { program_name: "ZFOO" }, { system: "probe" });
    const before = calls.length;

    await expect(
      registry.call(
        "UnlockProgramLow",
        { program_name: "ZFOO", lock_handle: "DEADBEEF00000000000000000000000000000000", session_id: "s1" },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: expect.objectContaining({ lock_handle: expect.any(String) }) });

    // Refused before SAP was asked: an UNLOCK would have answered 200 and released nothing.
    expect(calls.length).toBe(before);
  });
});

/**
 * A package write answers no handle when it had to re-lock in a new session.
 *
 * Measured live: `LockPackageLow` → `UpdatePackageLow` → `UnlockPackageLow` ended in
 * `INVALID_ARGUMENT: No lock of this gateway is open under that handle` — the update had already
 * released its fresh lock and closed the session that held it, but still answered the old handle
 * as `lock_handle`, so the caller chained an unlock on something that no longer existed.
 */
describe("package write that re-locks in a new session", () => {
  const PACKAGE_XML =
    '<?xml version="1.0" encoding="utf-8"?><pak:package xmlns:pak="http://www.sap.com/adt/packages" ' +
    'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZMCPPKG" adtcore:type="DEVC/K" ' +
    'adtcore:version="active" adtcore:description="old text"/>';

  it("answers lock_released with no handle instead of a dead one", async () => {
    // The request order is measured, not guessed (probe ): patch read → discovery →
    // PUT (refused) → logoff → discovery → LOCK → PUT → UNLOCK.
    const { impl, calls } = scriptedFetch([
      { status: 200, body: PACKAGE_XML }, // read the active package for the patch
      CSRF, // CSRF for the first write
      { status: 403, body: "<message>Package ZMCPPKG is locked by user U</message>" },
      { status: 200, body: "" }, // logoff: the retry runs in a new session
      CSRF, // …and that session fetches its own token
      { status: 200, body: "<DATA><LOCK_HANDLE>F1</LOCK_HANDLE></DATA>" }, // fresh lock
      { status: 200, body: "" }, // the write
      { status: 200, body: "" }, // that lock is released again
    ]);
    const { registry } = build(impl);

    const answer = (await registry.call(
      "UpdatePackageLow",
      {
        package_name: "ZMCPPKG",
        super_package: "ZMCP_RAP",
        updated_description: "new text",
        lock_handle: "OLD1",
      },
      { system: "probe" },
    )) as { lock_handle: string | null; lock_released: boolean; retried_in_new_session: boolean };

    expect(answer.retried_in_new_session).toBe(true);
    expect(answer.lock_released).toBe(true);
    // Nothing survives to unlock: a handle here is what made `UnlockPackageLow` refuse itself.
    expect(answer.lock_handle).toBeNull();
    expect(calls.some((call) => call.url.includes("_action=UNLOCK"))).toBe(true);
  });
});

/**
 * `CreateStructure` declares `fields` as **required** and used to ignore it.
 *
 * Measured live: the object came back as SAP's skeleton
 * (`define structure … { component_to_be_changed : abap.string(0); }`) while the caller had sent
 * three fields — the array reached nothing at all.
 */
describe("CreateStructure writes its fields", () => {
  it("puts the declared fields into the DDL", async () => {
    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 201, body: "" }, // POST /ddic/structures
      { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" }, // lock
      { status: 200, body: "" }, // PUT source/main
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
    ]);
    const { registry } = build(impl);

    await registry.call(
      "CreateStructure",
      {
        structure_name: "ZST_MCP_T01",
        package_name: "$TMP",
        description: "probe",
        fields: [
          { name: "ID", data_type: "CHAR", length: 10 },
          { name: "NAME", data_type: "CHAR", length: 40 },
          { name: "AMOUNT", data_type: "DEC", length: 15, decimals: 2 },
        ],
      },
      { system: "probe" },
    );

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toContain("/ddic/structures/zst_mcp_t01/source/main");
    expect(put?.body).toContain("define structure zst_mcp_t01 {");
    expect(put?.body).toContain("id : abap.char(10);");
    expect(put?.body).toContain("amount : abap.dec(15,2);");
    expect(put?.body).not.toContain("component_to_be_changed");
  });

  it("refuses `includes` rather than dropping them", async () => {
    const { impl } = scriptedFetch([CSRF, { status: 201, body: "" }]);
    const { registry } = build(impl);
    await expect(
      registry.call(
        "CreateStructure",
        {
          structure_name: "ZST_MCP_T02",
          package_name: "$TMP",
          fields: [{ name: "ID", data_type: "CHAR", length: 10 }],
          includes: [{ name: "ZST_OTHER" }],
        },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

describe("Check without a payload", () => {
  it("checks the stored version instead of refusing the family's own argument", async () => {
    const { impl } = scriptedFetch([
      { status: 200, body: "<class:abapClass/>" }, // object document (existence probe, plain GET: no CSRF)
      CSRF, // discovery for the checkrun POST
      { status: 200, body: "<chkrun:checkMessages xmlns:chkrun=\"http://www.sap.com/adt/checkrun\"/>" }, // checkrun: an empty report
    ]);
    const { registry } = build(impl);

    await expect(
      registry.call("CheckCdsViewLow", { view_name: "ZV_MCP_T01" }, { system: "probe" }),
    ).resolves.toMatchObject({ success: true, errors: 0 });
  });
});

describe("activation reads the draft, and only a missing draft is 'no draft'", () => {
  it("stops on a draft read that failed instead of activating the active version", async () => {
    // A 403 on the inactive read used to be swallowed: the handler fell back to the *active*
    // source, activated that, and answered `activated: true` — the one thing the caller did not
    // ask for. The fallback must apply to `not-found` only.
    const { impl, calls } = scriptedFetch([{ status: 403, body: "Service denied" }]);
    const { registry } = build(impl);

    await expect(
      registry.call("ActivateProgramLow", { program_name: "ZMMR_MCP_LTPROG" }, { system: "probe" }),
    ).rejects.toMatchObject({ status: 403 });

    // Nothing beyond the draft read may have been requested: no active read, no activation.
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(calls.some((call) => call.url.includes("version=active"))).toBe(false);
  });
});
