/**
 * The source-analysis tools.
 *
 * These read ABAP text, so they are the only tools in the gateway that can be pinned to a
 * fixture instead of a system: the same source must always give the same tree and the same
 * symbol table. They also replaced an upstream implementation that scanned for keywords
 * with regular expressions, so the tests check facts a regex could not produce — parameter
 * directions, attribute levels, positions.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { registerFamilies } from "../src/families/index.js";
import { GatewayRuntime } from "../src/runtime.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-analysis-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
  auth: { type: "basic", username: "env:U", password: "env:P" },
  rfcBackend: "soap",
  env: {},
} as never;

function booted(): { call: (tool: string, args: Record<string, unknown>) => Promise<unknown>; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "token" } });
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
  return { call: (tool, args) => registry.call(tool, args, { system: "probe" }), urls };
}

const CODE = [
  "CLASS zcl_analysis_probe DEFINITION PUBLIC FINAL CREATE PUBLIC.",
  "  PUBLIC SECTION.",
  "    TYPES ty_count TYPE i.",
  "    CONSTANTS c_kind TYPE string VALUE 'probe'.",
  "    DATA mv_state TYPE string.",
  "    METHODS run IMPORTING iv_count TYPE ty_count RETURNING VALUE(rv_text) TYPE string.",
  "  PRIVATE SECTION.",
  "    DATA mv_hidden TYPE i.",
  "ENDCLASS.",
  "CLASS zcl_analysis_probe IMPLEMENTATION.",
  "  METHOD run.",
  "    DATA lv_count TYPE i.",
  "    lv_count = iv_count + 1.",
  "    rv_text = |count={ lv_count }|.",
  "    WRITE / sy-subrc.",
  "    CALL FUNCTION 'ZCONVERT_TO_CAPITALIZATION'.",
  "  ENDMETHOD.",
  "ENDCLASS.",
].join("\n");

interface AstAnswer {
  parser: string;
  statement_count: number;
  truncated: boolean;
  parsing_issues: string[];
  ast: { type: string; text: string; from: { row: number; column: number }; children: unknown[] }[];
  file?: string;
}

interface SemanticAnswer {
  symbol_count: number;
  scope_count: number;
  symbols: { name: string; kind: string; scope?: string; extra?: Record<string, unknown> }[];
  references: { name: string; kind: string }[];
}

describe("GetAbapAST", () => {
  it("parses the statement tree with positions", async () => {
    const { call, urls } = booted();
    const answer = (await call("GetAbapAST", { code: CODE })) as AstAnswer;

    expect(answer.parser).toBe("@abaplint/core");
    expect(answer.parsing_issues).toEqual([]);
    // Definition + implementation are separate top-level statements, so > 2 is expected.
    expect(answer.statement_count).toBeGreaterThan(2);
    expect(answer.ast[0]?.type).toBe("ClassDefinition");
    expect(answer.ast[0]?.from).toEqual({ row: 1, column: 1 });
    expect(answer.ast[0]?.text).toContain("CLASS zcl_analysis_probe DEFINITION");
    // A parsed tree is nested, not a flat list of lines.
    expect(JSON.stringify(answer.ast)).toContain("MethodImplementation");
    expect(urls).toHaveLength(0);
  });

  it("writes the answer to a file when asked, and reports the path", async () => {
    const { call } = booted();
    const target = join(tmpdir(), `ast-${process.pid}`, "ast.json");
    const answer = (await call("GetAbapAST", { code: CODE, filePath: target })) as AstAnswer;
    expect(answer.file).toBe(target);
    const written = JSON.parse(readFileSync(target, "utf8")) as AstAnswer;
    expect(written.statement_count).toBe(answer.statement_count);
  });

  it("refuses an empty call with the argument it needs", async () => {
    const { call } = booted();
    await expect(call("GetAbapAST", {})).rejects.toThrow(/missing "code"/);
  });
});

describe("GetAbapSemanticAnalysis", () => {
  it("reports symbols a keyword scan could not: kinds, scopes, parameter directions", async () => {
    const { call, urls } = booted();
    const answer = (await call("GetAbapSemanticAnalysis", { code: CODE })) as SemanticAnswer;

    const run = answer.symbols.find((symbol) => symbol.name === "run" && symbol.kind === "method");
    expect(run?.scope).toBe("zcl_analysis_probe");

    const parameter = answer.symbols.find((symbol) => symbol.name === "iv_count");
    expect(parameter).toMatchObject({ kind: "parameter", extra: { direction: "importing" } });

    const returning = answer.symbols.find((symbol) => symbol.name === "rv_text");
    expect(returning).toMatchObject({ kind: "parameter", extra: { direction: "returning" } });

    const attribute = answer.symbols.find((symbol) => symbol.name === "mv_state");
    expect(attribute).toMatchObject({ kind: "attribute", extra: { level: "instance" } });
    expect(answer.symbols.some((symbol) => symbol.name === "c_kind")).toBe(true);
    expect(answer.scope_count).toBeGreaterThan(1);
    expect(urls).toHaveLength(0);
  });

  it("collects the references the code makes", async () => {
    const { call } = booted();
    const answer = (await call("GetAbapSemanticAnalysis", { code: CODE })) as SemanticAnswer;
    expect(answer.references).toContainEqual({ name: "ZCONVERT_TO_CAPITALIZATION", kind: "function_module" });
    expect(answer.references).toContainEqual({ name: "SY-SUBRC", kind: "system_field" });
    expect(answer.references.some((reference) => reference.kind === "type" && reference.name === "TY_COUNT")).toBe(true);
  });

  it("reports report-level declarations, which the parser model does not carry", async () => {
    // Measured live: a report with `DATA: lv_x TYPE i.` answered `symbol_count: 0`,
    // and a `PERFORM missing_form.` produced no reference at all.
    const { call } = booted();
    const answer = (await call("GetAbapSemanticAnalysis", {
      code: ["REPORT zprobe.", "DATA: lv_x TYPE i, lv_y TYPE i.", "CONSTANTS c_one TYPE i VALUE 1.", "PERFORM missing_form."].join("\n"),
    })) as SemanticAnswer & { analysis_level: string };

    expect(answer.analysis_level).toBe("parse");
    expect(answer.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "LV_X", kind: "variable" }),
        expect.objectContaining({ name: "LV_Y", kind: "variable" }),
        expect.objectContaining({ name: "C_ONE", kind: "constant" }),
      ]),
    );
    expect(answer.references).toContainEqual({ name: "MISSING_FORM", kind: "form" });
  });
});

describe("GetAbapSystemSymbols", () => {
  it("lists the system fields without asking the system, and resolves names through it", async () => {
    const { call } = booted();
    const answer = (await call("GetAbapSystemSymbols", { code: CODE })) as {
      system_fields: string[];
      symbols: { name: string; kind: string; resolved: boolean }[];
    };

    expect(answer.system_fields).toEqual(["SY-SUBRC"]);
    expect(answer.symbols.some((symbol) => symbol.name === "ZCL_ANALYSIS_PROBE" && symbol.kind === "class")).toBe(true);
    // The probe session answers nothing useful, so the lookup must report "unresolved"
    // rather than pretending the object exists.
    expect(answer.symbols.every((symbol) => symbol.resolved === false)).toBe(true);
  });
});
