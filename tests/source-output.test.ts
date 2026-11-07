/**
 * `output: "file"` on the source-reading tools.
 *
 * Measured live: `GetProgram {output: "file"}` answered exactly like
 * `GetProgram {}` — the whole source inline, no file, no path. Six tools declare the
 * argument (GetProgram, GetClass, GetInterface, GetInclude, GetFunctionModule,
 * GetProgFullCode) and none of them read it, so the promise "the source lands in a file"
 * was the one thing the call did not do.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { outlineOfSource, sourceFileAnswer } from "../src/tools/source-output.ts";

const SOURCE = [
  "REPORT zfoo.",
  "",
  "* a comment mentioning FORM not_a_form.",
  "FORM do_it.",
  "  WRITE: / 'x'.",
  "ENDFORM.",
  "",
  "CLASS lcl_x DEFINITION.",
  "  PUBLIC SECTION.",
  "    METHODS run.",
  "ENDCLASS.",
  "",
  "CLASS lcl_x IMPLEMENTATION.",
  "  METHOD run.",
  "    WRITE: / 'y'.",
  "  ENDMETHOD.",
  "ENDCLASS.",
].join("\n");

describe("outlineOfSource", () => {
  it("gives each top-level block its line range", () => {
    expect(outlineOfSource(SOURCE)).toEqual([
      { kind: "form", name: "DO_IT", start_line: 4, end_line: 6 },
      { kind: "class", name: "LCL_X", start_line: 8, end_line: 11 },
      { kind: "class", name: "LCL_X", start_line: 13, end_line: 17 },
    ]);
  });

  it("ignores a block name inside a comment", () => {
    expect(outlineOfSource("* FORM ghost.\nENDFORM.")).toEqual([]);
  });

  it("still says where an unterminated block starts", () => {
    expect(outlineOfSource("FORM never_closed.\n  WRITE: / 1.\n")).toEqual([
      { kind: "form", name: "NEVER_CLOSED", start_line: 1, end_line: 2 },
    ]);
  });
});

describe("sourceFileAnswer", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "source-output-"));
    process.env["ABAP_ADT_MCP_OUTPUT_DIR"] = directory;
  });

  afterEach(() => {
    delete process.env["ABAP_ADT_MCP_OUTPUT_DIR"];
    rmSync(directory, { recursive: true, force: true });
  });

  it("writes UTF-8 under <dir>/sources/<tool>/ and answers with the path", () => {
    const answer = sourceFileAnswer(SOURCE, { tool: "GetProgram", name: "ZFOO", version: "active" });

    expect(answer.path).toBe(join(directory, "sources", "GetProgram", "ZFOO-active.abap"));
    expect(readFileSync(answer.path, "utf8")).toBe(SOURCE);
    expect(answer.line_count).toBe(17);
    expect(answer.outline.length).toBe(3);
  });

  it("keeps a name that contains a path separator out of the directory", () => {
    const answer = sourceFileAnswer("REPORT z.\n", { tool: "GetClass", name: "/oo/classes/ZCL_FOO" });
    expect(answer.path.startsWith(join(directory, "sources", "GetClass"))).toBe(true);
  });
});
