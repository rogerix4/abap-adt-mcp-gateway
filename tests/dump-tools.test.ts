/**
 * The three dump tools answer the same request the same way.
 *
 * Measured live on DS4/100: `RuntimeGetDumpById {response_mode: "summary"}`
 * answered 166 KB of `/formatted` long text and no `summary` at all, and
 * `HandlerDumpView {view: "summary"}` did the same — both were fixed routes to
 * `/runtime/dump/<id>/formatted`, so `view` / `response_mode` / `chapters` never
 * reached SAP and never shaped the answer.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-dump-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "ZH", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const DUMP_ID = "20261106193234vhfjeds4ci_DS4_00";

const META = `<?xml version="1.0" encoding="utf-8"?>
<dump:dump xmlns:dump="http://www.sap.com/adt/runtime/dump" error="CONVT_NO_NUMBER"
  exception="CX_SY_CONVERSION_NO_NUMBER" title="Runtime Error: CONVT_NO_NUMBER"
  author="CON_YHB" terminatedProgram="ZTEST_WTX3" serverInstance="vhfjeds4ci_DS4_00"
  datetime="2026-11-06T11:32:34Z" systemDate="06.11.2026" systemTime="19:32:34" language="ZH">
  <dump:link relation="http://www.sap.com/adt/relations/runtime/dump/termination"
    uri="adt://DS4/sap/bc/adt/programs/programs/ztest_wtx3/source/main#start=1753"/>
  <dump:chapters>
    <dump:chapter name="kap1" title="发生了什么？" category="用户视图" line="1"/>
    <dump:chapter name="kap8" title="源代码提取" category="ABAP 开发人员视图" line="3"/>
    <dump:chapter name="kap9" title="系统字段的内容" category="ABAP 开发人员视图" line="5"/>
  </dump:chapters>
</dump:dump>`;

/** Line numbers are 1-based into this text, matching the chapter index above. */
const FORMATTED = ["发生了什么 ----", "短文本 CONVT_NO_NUMBER", "源代码提取 ----", "DATA: x TYPE i.", "系统字段 ----", "SY-SUBRC = 0"].join(
  "\n",
);

const SUMMARY_HTML = "<html><body><p>运行时错误 CONVT_NO_NUMBER</p></body></html>";

interface Call {
  readonly path: string;
  readonly accept: string;
}

/** Routes on path so a test can assert which resources were actually read. */
function dumpFetch(calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, accept: headers.get("accept") ?? "" });
    if (url.pathname.endsWith("/formatted")) {
      return new Response(FORMATTED, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.pathname.endsWith("/summary")) {
      return new Response(SUMMARY_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.pathname.includes("/runtime/dump/")) {
      return new Response(META, { status: 200, headers: { "content-type": "application/xml" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

function harness() {
  const calls: Call[] = [];
  const runtime = new GatewayRuntime([system], (target) =>
    new AdtSession({
      url: target.endpoint.url,
      client: target.endpoint.client,
      language: target.endpoint.language,
      username: "u",
      password: "p",
      fetchImpl: dumpFetch(calls),
    }),
  );
  const registry = createRegistry();
  registerReadTools(registry, runtime);
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await registry.call(tool, args, { system: "probe" } as never)) as Record<string, unknown>;
  return { calls, call };
}

describe("RuntimeGetDumpById", () => {
  it("answers only the key facts for response_mode=summary — no long text is fetched", async () => {
    const { calls, call } = harness();
    const answer = await call("RuntimeGetDumpById", { dump_id: DUMP_ID, response_mode: "summary" });

    expect(answer["summary"]).toMatchObject({
      error: "CONVT_NO_NUMBER",
      exception: "CX_SY_CONVERSION_NO_NUMBER",
      program: "ZTEST_WTX3",
      user: "CON_YHB",
    });
    expect(answer["text"]).toBeUndefined();
    expect(answer["facts"]).toBeUndefined();
    expect(calls.some((entry) => entry.path.endsWith("/formatted"))).toBe(false);
  });

  it("answers facts plus the chapter index by default, without the formatted text", async () => {
    const { calls, call } = harness();
    const answer = await call("RuntimeGetDumpById", { dump_id: DUMP_ID });

    expect(answer["response_mode"]).toBe("payload");
    expect(answer["facts"]).toMatchObject({
      terminated_program: "ZTEST_WTX3",
      termination_uri: "adt://DS4/sap/bc/adt/programs/programs/ztest_wtx3/source/main#start=1753",
    });
    expect(answer["chapters"]).toHaveLength(3);
    expect(answer["text"]).toBeUndefined();
    expect(calls.some((entry) => entry.path.endsWith("/formatted"))).toBe(false);
  });

  it("adds the summary in front of the payload for response_mode=both", async () => {
    const { call } = harness();
    const answer = await call("RuntimeGetDumpById", { dump_id: DUMP_ID, response_mode: "both" });

    expect(answer["summary"]).toBeDefined();
    expect(answer["facts"]).toBeDefined();
    expect(answer["chapters"]).toHaveLength(3);
  });

  it("returns only the named chapters of the long text when chapters is passed", async () => {
    const { call } = harness();
    const answer = await call("RuntimeGetDumpById", { dump_id: DUMP_ID, chapters: ["源代码提取"] });

    const text = String(answer["text"] ?? "");
    expect(answer["view"]).toBe("formatted");
    expect(text).toContain("DATA: x TYPE i.");
    expect(text).not.toContain("CONVT_NO_NUMBER");
    expect(text).not.toContain("SY-SUBRC");
  });

  it("refuses a call without dump_id", async () => {
    const { call } = harness();
    await expect(call("RuntimeGetDumpById", {})).rejects.toThrow(/dump_id/);
  });
});

describe("HandlerDumpView", () => {
  it("honours view=summary instead of returning the formatted text", async () => {
    const { call } = harness();
    const answer = await call("HandlerDumpView", { dump_id: DUMP_ID, view: "summary" });

    expect(answer["view"]).toBe("summary");
    expect(String(answer["text"] ?? "")).toContain("运行时错误");
    expect(answer["chapters"]).toBeUndefined();
  });

  it("keeps the chapter index for the default view", async () => {
    const { call } = harness();
    const answer = await call("HandlerDumpView", { dump_id: DUMP_ID });

    expect(answer["facts"]).toMatchObject({ error: "CONVT_NO_NUMBER" });
    expect(answer["chapters"]).toHaveLength(3);
    expect(answer["text"]).toBeUndefined();
  });
});

describe("RuntimeAnalyzeDump", () => {
  it("keeps working with chapters=[\"developer\"] after the shared reader", async () => {
    const { call } = harness();
    const answer = await call("RuntimeAnalyzeDump", { dump_id: DUMP_ID, chapters: ["developer"] });

    const text = String(answer["text"] ?? "");
    expect(text).toContain("===== 源代码提取 =====");
    expect(text).toContain("===== 发生了什么？ =====");
    expect(answer["chapters"]).toBeUndefined();
  });

  it("accepts a still percent-encoded dump id from a feed link", async () => {
    const { call } = harness();
    const answer = await call("RuntimeAnalyzeDump", { dump_id: encodeURIComponent(`${DUMP_ID}%20%20CON_YHB`) });

    expect(answer["facts"]).toMatchObject({ error: "CONVT_NO_NUMBER" });
  });
});
