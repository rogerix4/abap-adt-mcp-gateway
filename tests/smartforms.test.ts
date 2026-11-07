/**
 * The SmartForm tools.
 *
 * SAP has no ADT resource for Smart Forms, so these tools run through the
 * `ZMCP_SSF_*` bridge and derive the layout from the Form Builder XML the bridge
 * returns. The two things that fail quietly are the unit conversion (a wrong
 * factor still returns a number) and the "off" flag of `activate` (an empty
 * string cannot be told apart from "not passed"), so both are pinned here.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { registerFamilies } from "../src/families/index.js";
import { GatewayRuntime } from "../src/runtime.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-smartform-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "env:U", password: "env:P" },
  rfcBackend: "soap",
  env: {},
} as never;

/** Two windows: one in CM, one in PT, so the conversion factors are visible. */
const FORM_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<sf:SMARTFORM xmlns:sf="urn:sap-com:SmartForms:2000:internal-structure" ' +
  'xmlns="urn:sap-com:sdixml-ifr:2000" sf:language="EN">' +
  "<HEADER><FORMNAME>ZPROBE_FORM</FORMNAME><MASTERLANG>E</MASTERLANG></HEADER>" +
  "<sf:VARHEADER><sf:item>" +
  "<PAGEFORMAT>DIN-A4</PAGEFORMAT><CPI>14.00</CPI><LPI>6.00</LPI>" +
  "<STDSTYLE>ZSTYLE1</STDSTYLE><XSFOUTMODE>A</XSFOUTMODE>" +
  "<sf:PAGETREE><sf:NODE><NODETYPE>RP</NODETYPE><sf:SUCC><sf:item><sf:NODE>" +
  "<NODETYPE>PA</NODETYPE><sf:OBJ><sf:PAGE>" +
  "<NAME><INAME>%PAGE1</INAME></NAME><NEXTPAGE><INAME>%PAGE2</INAME></NEXTPAGE>" +
  "<NUMB_MODE>I</NUMB_MODE><NUMB_TYPE>A</NUMB_TYPE><PAGEORTN>P</PAGEORTN>" +
  "<T_CAPTION><item><LANGU>E</LANGU><CAPTION>Page one</CAPTION></item></T_CAPTION>" +
  "</sf:PAGE></sf:OBJ>" +
  "<sf:SUCC>" +
  "<sf:item><sf:NODE><NODETYPE>WI</NODETYPE><sf:OBJ><sf:WINDOW>" +
  "<NAME><INAME>MAIN</INAME></NAME><WTYPE>M</WTYPE>" +
  "<T_CAPTION><item><LANGU>E</LANGU><CAPTION>Main</CAPTION></item></T_CAPTION>" +
  "<sf:PROC_CTRL><sf:NODE><NODETYPE>RC</NODETYPE><sf:SUCC><sf:item><sf:NODE>" +
  "<NODETYPE>TX</NODETYPE><sf:OBJ><sf:TEXT>" +
  "<TEXT><item><TDFORMAT>P1</TDFORMAT><TDLINE>&WERKS&</TDLINE></item>" +
  "<item><TDFORMAT></TDFORMAT><TDLINE>second line</TDLINE></item></TEXT>" +
  "</sf:TEXT></sf:OBJ></sf:NODE></sf:item></sf:SUCC></sf:NODE></sf:PROC_CTRL>" +
  "</sf:WINDOW></sf:OBJ>" +
  "<sf:OUTATTR><sf:OUTATTR><WWIDTH>24.00</WWIDTH><U_WWIDTH>CM</U_WWIDTH>" +
  "<WTOP>5.10</WTOP><U_WTOP>CM</U_WTOP><WHEIGHT>20.00</WHEIGHT><U_WHEIGHT>CM</U_WHEIGHT>" +
  "</sf:OUTATTR></sf:OUTATTR></sf:NODE></sf:item>" +
  "<sf:item><sf:NODE><NODETYPE>WI</NODETYPE><sf:OBJ><sf:WINDOW>" +
  "<NAME><INAME>%WINDOW2</INAME></NAME><WTYPE>T</WTYPE>" +
  "</sf:WINDOW></sf:OBJ>" +
  "<sf:OUTATTR><sf:OUTATTR><WWIDTH>72.00</WWIDTH><U_WWIDTH>PT</U_WWIDTH>" +
  "<WTOP>0.50</WTOP><U_WTOP>IN</U_WTOP>" +
  "</sf:OUTATTR></sf:OUTATTR></sf:NODE></sf:item>" +
  "</sf:SUCC></sf:NODE></sf:item></sf:SUCC></sf:NODE></sf:PAGETREE>" +
  "</sf:item></sf:VARHEADER></sf:SMARTFORM>";

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const unescape = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const paramOf = (body: string, name: string): string => {
  const raw = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1] ?? "";
  return unescape(raw);
};

const soapAnswer = (result: Record<string, unknown>): string =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">' +
  "<soap-env:Body><urn:ZMCP_ADT_DISPATCH.Response>" +
  "<EV_SUBRC>0</EV_SUBRC><EV_MESSAGE>OK</EV_MESSAGE>" +
  `<EV_RESULT>${escape(JSON.stringify(result))}</EV_RESULT>` +
  "</urn:ZMCP_ADT_DISPATCH.Response></soap-env:Body></soap-env:Envelope>";

interface Booted {
  readonly call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly actions: string[];
  readonly params: string[];
}

/** A registry whose SOAP endpoint answers from `answer(action, params)`. */
function booted(answer: (action: string, params: Record<string, unknown>) => Record<string, unknown>): Booted {
  const actions: string[] = [];
  const params: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("/sap/bc/soap/rfc")) {
      return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "token" } });
    }
    const body = String(init?.body ?? "");
    const action = paramOf(body, "IV_ACTION");
    const raw = paramOf(body, "IV_PARAMS");
    actions.push(action);
    params.push(raw);
    return new Response(soapAnswer(answer(action, JSON.parse(raw === "" ? "{}" : raw))), {
      status: 200,
      headers: { "content-type": "text/xml" },
    });
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
  return {
    actions,
    params,
    call: (tool, args) => registry.call(tool, args, { system: "probe" }),
  };
}

const formAnswer = () => ({ PART: "FORM", FORM_NAME: "ZPROBE_FORM", LANGUAGE: "E", XML: FORM_XML });

describe("GetSmartFormLayout", () => {
  it("reads the page, the windows and converts the stored units to millimetres", async () => {
    const { call, actions } = booted(() => formAnswer());
    const layout = (await call("GetSmartFormLayout", { form_name: "zprobe_form" })) as {
      form_name: string;
      page_formats: { format: string; cpi: number; lpi: number; style: string }[];
      pages: {
        name: string;
        caption: string;
        orientation: string;
        next_page: string;
        windows: { name: string; type: string; type_text: string; top?: { value: number; unit: string; mm: number } }[];
      }[];
    };

    expect(actions).toEqual(["SSF_CONTENT"]);
    expect(layout.form_name).toBe("ZPROBE_FORM");
    expect(layout.page_formats[0]).toMatchObject({ format: "DIN-A4", cpi: 14, lpi: 6, style: "ZSTYLE1" });
    expect(layout.pages[0]).toMatchObject({
      name: "%PAGE1",
      caption: "Page one",
      orientation: "P",
      next_page: "%PAGE2",
    });

    const [main, secondary] = layout.pages[0]!.windows;
    // CM → mm is ×10; 72 pt is 25.4 mm; 0.5 in is 12.7 mm.
    expect(main).toMatchObject({ name: "MAIN", type: "M", type_text: "MAIN" });
    expect(main?.top).toEqual({ value: 5.1, unit: "CM", mm: 51 });
    expect(secondary).toMatchObject({ name: "%WINDOW2", type: "T", type_text: "NON_MAIN" });
    expect(secondary?.top).toEqual({ value: 0.5, unit: "IN", mm: 12.7 });
    // The layout answer carries no content tree — that is GetSmartFormContent's job.
    expect(JSON.stringify(layout)).not.toContain("second line");
  });

  it("answers with the bridge's own reason when the form was never activated", async () => {
    const { call } = booted(() => {
      throw new Error("SSF_CONTENT error (action=SSF_CONTENT, subrc=4): SmartForm ZPROBE_FORM has no active version");
    });
    await expect(call("GetSmartFormLayout", { form_name: "ZPROBE_FORM" })).rejects.toThrow(/no active version/);
  });

  it("reports a form that does not exist as not-found, not as a server failure", async () => {
    // Measured live: `GetSmartFormContent {form_name: "ZMM_SF_MCP_NEVER9"}` answered
    // `UPSTREAM_FAILED` with "SmartForm ZMM_SF_MCP_NEVER9 does not exist", so a caller branching
    // on `not-found` read a wrong name as a broken system.
    const { call } = booted(() => {
      throw new Error("SSF_CONTENT error (action=SSF_CONTENT, subrc=4): SmartForm ZPROBE_FORM does not exist");
    });
    await expect(call("GetSmartFormContent", { form_name: "ZPROBE_FORM" })).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("GetSmartFormContent", () => {
  it("derives the node outline and the text lines from the same XML", async () => {
    const { call, actions } = booted((_action, params) => {
      if (params["part"] === "STYLE") return { PART: "STYLE", NAME: "ZSTYLE1", CSS: ".x{color:red}" };
      if (params["part"] === "TEXTS") return { PART: "TEXTS", COUNT: 1, LINES: [{ TEXT: "hello" }] };
      return formAnswer();
    });

    const content = (await call("GetSmartFormContent", { form_name: "ZPROBE_FORM" })) as {
      node_counts: Record<string, number>;
      styles: { name: string; css?: string }[];
      texts?: string[];
      pages: { windows: { nodes: { type: string; lines?: string[] }[] }[] }[];
      graphics: { fetched: boolean };
      xml?: string;
      files: { content: string; xml: string };
    };

    expect(actions.filter((action) => action === "SSF_CONTENT")).toHaveLength(3);
    expect(content.node_counts["TX"]).toBe(1);
    expect(content.styles[0]).toEqual({ name: "ZSTYLE1", css: ".x{color:red}" });
    expect(content.texts).toEqual(["hello"]);
    expect(content.graphics.fetched).toBe(false);
    // The Form Builder XML is written to disk instead of being repeated in the answer
    // (128 KB for a real form); `files` is what the description promises.
    expect(content.xml).toBeUndefined();
    expect(readFileSync(content.files.xml, "utf8")).toContain("<sf:SMARTFORM");
    const written = JSON.parse(readFileSync(content.files.content, "utf8")) as { pages: unknown[]; xml: string };
    expect(written.xml).toContain("<sf:SMARTFORM");
    expect(written.pages).toHaveLength(1);

    const nodes = content.pages[0]!.windows.flatMap((window) => window.nodes);
    const text = nodes.find((node) => node.type === "TX");
    // Paragraph format and text, in the format SE80 shows: "P1|&WERKS&".
    expect(text?.lines).toEqual(["P1|&WERKS&", "|second line"]);
  });

  it("answers with the counts only when summary is set", async () => {
    const { call } = booted((_action, params) =>
      params["part"] === "STYLE" ? { PART: "STYLE", NAME: "ZSTYLE1", CSS: ".x{color:red}" } : formAnswer(),
    );
    const content = (await call("GetSmartFormContent", { form_name: "ZPROBE_FORM", summary: true })) as {
      pages?: unknown;
      xml?: string;
      window_count: number;
      windows: Array<Record<string, unknown>>;
      symbols: string[];
      styles: Array<Record<string, unknown>>;
      files: { content: string; xml: string };
    };
    expect(content.pages).toBeUndefined();
    expect(content.xml).toBeUndefined();
    expect(content.window_count).toBe(2);
    // The overview the description promises: windows per page and the &symbols& the form uses.
    expect(content.windows[0]).toMatchObject({ name: "MAIN", type: "M", top_mm: 51 });
    expect(content.symbols).toEqual(["WERKS"]);
    // An overview carries the size of the CSS, not the stylesheet (~8 KB for a real style).
    expect(content.styles[0]).toEqual({ name: "ZSTYLE1", css_chars: 13 });
    expect(readFileSync(content.files.content, "utf8")).toContain("<sf:SMARTFORM");
  });
});

describe("CreateSmartForm", () => {
  const xmlFile = (): string => {
    const path = join(tmpdir(), `smartform-${process.pid}.xml`);
    writeFileSync(path, FORM_XML, "utf8");
    return path;
  };

  it("sends the XML and the flags the caller asked for", async () => {
    const { call, params } = booted(() => ({
      FORM_NAME: "ZMM_SF_MCP_PROBE",
      LANGUAGE: "E",
      STORED: "X",
      ACTIVE: "X",
      PACKAGE_NAME: "$TMP",
      GENERATED_FM: "/1BCDWB/SF00000001",
    }));

    const created = (await call("CreateSmartForm", {
      form_name: "ZMM_SF_MCP_PROBE",
      xml_file: xmlFile(),
      overwrite: true,
    })) as { stored: boolean; active: boolean; generated_fm?: string; package_name: string };

    expect(created).toMatchObject({ stored: true, active: true, package_name: "$TMP", generated_fm: "/1BCDWB/SF00000001" });
    const sent = JSON.parse(params[0] ?? "{}") as Record<string, string>;
    expect(sent["form_name"]).toBe("ZMM_SF_MCP_PROBE");
    expect(sent["overwrite"]).toBe("X");
    expect(sent["activate"]).toBe("X");
    expect(sent["xml"]).toContain("<sf:SMARTFORM");
  });

  it("fails when activation produced no generated function module", async () => {
    const { call } = booted(() => ({
      FORM_NAME: "ZMM_SF_MCP_PROBE",
      LANGUAGE: "E",
      STORED: "X",
      ACTIVE: "X",
      PACKAGE_NAME: "$TMP",
      GENERATED_FM: "",
    }));

    await expect(
      call("CreateSmartForm", { form_name: "ZMM_SF_MCP_PROBE", xml_file: xmlFile() }),
    ).rejects.toThrow(/generated no function module/);
  });

  it("asks for an inactive form with N, because an empty string means 'not passed'", async () => {
    const { call, params } = booted(() => ({
      FORM_NAME: "ZMM_SF_MCP_PROBE",
      LANGUAGE: "E",
      STORED: "X",
      ACTIVE: "",
      PACKAGE_NAME: "$TMP",
      GENERATED_FM: "",
    }));

    const created = (await call("CreateSmartForm", {
      form_name: "ZMM_SF_MCP_PROBE",
      xml_file: xmlFile(),
      activate: false,
    })) as { active: boolean; generated_fm?: string };

    expect(created.active).toBe(false);
    expect(created.generated_fm).toBeUndefined();
    const sent = JSON.parse(params[0] ?? "{}") as Record<string, string>;
    expect(sent["activate"]).toBe("N");
    expect(sent["overwrite"]).toBe("");
  });

  it("refuses a transport and a transportable package before it writes anything", async () => {
    const { call, actions } = booted(() => formAnswer());
    await expect(
      call("CreateSmartForm", { form_name: "ZMM_SF_MCP_PROBE", xml_file: xmlFile(), transport_request: "DEVK900001" }),
    ).rejects.toThrow(/transport request/);
    await expect(
      call("CreateSmartForm", { form_name: "ZMM_SF_MCP_PROBE", xml_file: xmlFile(), package_name: "ZSD" }),
    ).rejects.toThrow(/transportable/);
    expect(actions).toEqual([]);
  });

  it("refuses a name outside the customer namespace", async () => {
    const { call } = booted(() => formAnswer());
    await expect(call("CreateSmartForm", { form_name: "SAPFORM", xml_file: xmlFile() })).rejects.toThrow(
      /not a Z\*\/Y\* SmartForm name/,
    );
  });
});

describe("DeleteSmartForm", () => {
  it("is a dry run unless the caller confirms", async () => {
    const { call, params } = booted(() => ({
      FORM_NAME: "ZMM_SF_MCP_PROBE",
      DRY_RUN: "X",
      DELETED: "",
      PACKAGE_NAME: "$TMP",
      GENERATED_FM: "",
      TADIR_LEFT: "",
    }));

    const answer = (await call("DeleteSmartForm", { form_name: "ZMM_SF_MCP_PROBE" })) as {
      dry_run: boolean;
      deleted: boolean;
      nextAction?: string;
    };
    expect(answer).toMatchObject({ dry_run: true, deleted: false });
    expect(answer.nextAction).toContain("confirm: true");
    expect((JSON.parse(params[0] ?? "{}") as Record<string, string>)["confirm"]).toBe("");
  });

  it("reports the delete and a leftover TADIR entry", async () => {
    const { call } = booted(() => ({
      FORM_NAME: "ZMM_SF_MCP_PROBE",
      DELETED: "X",
      PACKAGE_NAME: "$TMP",
      TADIR_LEFT: "X",
    }));
    const answer = (await call("DeleteSmartForm", { form_name: "ZMM_SF_MCP_PROBE", confirm: true })) as {
      dry_run: boolean;
      deleted: boolean;
      tadir_left: boolean;
    };
    expect(answer).toMatchObject({ dry_run: false, deleted: true, tadir_left: true });
  });
});

describe("RenderSmartForm", () => {
  it("writes the OTF text and the PDF and reports the defaulted parameters", async () => {
    const outDir = join(tmpdir(), `sf-out-${process.pid}`);
    process.env["ABAP_ADT_MCP_OUTPUT_DIR"] = outDir;
    const pdf = Buffer.from("%PDF-1.4 probe", "utf8");

    const { call, params } = booted((action, args) => {
      expect(action).toBe("SSF_RENDER");
      expect(args["form_name"]).toBe("ZPROBE_FORM");
      return {
        FORM_NAME: "ZPROBE_FORM",
        LANGUAGE: "E",
        DEVICE: "LOCL",
        GENERATED_FM: "/1BCDWB/SF00000009",
        OTF_COUNT: 2,
        PDF_SIZE: pdf.length,
        OTF_TEXT: "first line\nsecond line",
        PDF_BASE64: pdf.toString("base64"),
        DEFAULTS: "ITAB_SH",
      };
    });

    const rendered = (await call("RenderSmartForm", {
      form_name: "ZPROBE_FORM",
      values: { IV_WERKS: "1000" },
    })) as {
      otf_lines: number;
      pdf_size: number;
      defaults_used?: string[];
      files: { otf: string; pdf?: string };
    };

    expect(rendered).toMatchObject({ otf_lines: 2, pdf_size: pdf.length });
    expect(rendered.defaults_used).toEqual(["ITAB_SH"]);
    expect(rendered.files.otf).toBe(join(outDir, "smartforms", "ZPROBE_FORM", "ZPROBE_FORM.sap.otf.txt"));
    expect(readFileSync(rendered.files.otf, "utf8")).toBe("first line\nsecond line");
    expect(readFileSync(rendered.files.pdf!, "utf8")).toBe("%PDF-1.4 probe");
    expect(JSON.parse(params[0] ?? "{}")).toMatchObject({ values: '{"IV_WERKS":"1000"}' });
  });

  it("reads the values from a file when values is not given", async () => {
    process.env["ABAP_ADT_MCP_OUTPUT_DIR"] = join(tmpdir(), `sf-out-${process.pid}`);
    const valuesFile = join(tmpdir(), `sf-values-${process.pid}.json`);
    writeFileSync(valuesFile, JSON.stringify({ IV_WERKS: "2000" }), "utf8");
    const { call, params } = booted(() => ({
      FORM_NAME: "ZPROBE_FORM",
      LANGUAGE: "E",
      DEVICE: "LOCL",
      GENERATED_FM: "/1BCDWB/SF00000009",
      OTF_COUNT: 1,
      PDF_SIZE: 0,
      OTF_TEXT: "one line",
      PDF_BASE64: "",
    }));

    const rendered = (await call("RenderSmartForm", { form_name: "ZPROBE_FORM", values_file: valuesFile })) as {
      files: { pdf?: string };
    };
    expect(JSON.parse(params[0] ?? "{}")).toMatchObject({ values: '{"IV_WERKS":"2000"}' });
    // No PDF came back, so only the OTF file is named.
    expect(rendered.files.pdf).toBeUndefined();
  });
});
