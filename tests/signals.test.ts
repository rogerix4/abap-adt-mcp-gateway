/**
 * The two shared primitives the reliability pass introduced.
 *
 * `decodeXmlEntities` is asserted for the ordering bug it replaces (`&amp;` decoded
 * first turns a single escape into markup), and `hasSignal` for the Chinese wording the
 * configured systems actually answer with — a table that only knows English looks like
 * coverage and never fires.
 */

import { describe, expect, it } from "vitest";

import { hasSignal, isTransportRequired, SIGNAL_PATTERNS, type SignalName } from "../src/adt/signals.ts";
import { decodeXmlEntities, escapeXmlAttribute, plainText } from "../src/adt/xml.ts";

describe("decodeXmlEntities", () => {
  it("decodes an escape SAP sent once", () => {
    expect(decodeXmlEntities("LO_WORKSHEET-&gt;SET_CELL(")).toBe("LO_WORKSHEET->SET_CELL(");
  });

  it("does not decode twice", () => {
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeXmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("decodes numeric and hex references", () => {
    expect(decodeXmlEntities("a&#39;b")).toBe("a'b");
    expect(decodeXmlEntities("a&#x4E2D;b")).toBe("a中b");
  });

  it("leaves an unknown or out-of-range reference alone rather than throwing", () => {
    expect(decodeXmlEntities("&#x110000;")).toBe("");
    expect(decodeXmlEntities("&unknown;")).toBe("&unknown;");
  });

  it("round-trips through escapeXmlAttribute", () => {
    expect(decodeXmlEntities(escapeXmlAttribute(`a<b>&"c"`))).toBe(`a<b>&"c"`);
  });
});

describe("plainText", () => {
  it("drops tags and style blocks, keeps the sentence", () => {
    const html = "<html><head><style>body{color:red}</style></head><body><p>Object ZFOO &amp; ZBAR</p></body></html>";
    expect(plainText(html)).toBe("Object ZFOO & ZBAR");
  });
});

describe("hasSignal", () => {
  const chinese: ReadonlyArray<readonly [SignalName, string]> = [
    ["currently-editing", "使用者 U 当前编辑 ZFOO"],
    ["already-locked", "对象 ZFOO 已锁定"],
    ["single-select", "仅允许一个 SELECT 语句"],
    ["language-key-width", "'ZH' 不是 C(1,0) 的有效值"],
    // Captured live by checking a program whose inactive version is empty.
    // The English-only pattern missed both halves of this sentence, so a healthy active
    // program was reported with one error.
    ["report-statement-missing", "缺少 REPORT/PROGRAM 语句，或程序类型是 INCLUDE。"],
    // Captured live by creating the same program twice.
    ["already-exists", "已存在名为 ZMMR_MCP_T01 的程序或 include"],
  ];

  for (const [name, text] of chinese) {
    it(`recognises the Chinese wording for ${name}`, () => {
      expect(hasSignal(text, name)).toBe(true);
    });
  }

  it("recognises the English wording", () => {
    expect(hasSignal("User U is currently editing ZFOO", "currently-editing")).toBe(true);
    expect(hasSignal("The object is locked", "already-locked")).toBe(true);
    expect(hasSignal("Program ZFOO already exists", "already-exists")).toBe(true);
  });

  it("does not treat an empty or missing text as a match", () => {
    expect(hasSignal("", "already-locked")).toBe(false);
    expect(hasSignal(undefined, "already-locked")).toBe(false);
  });

  it("requires `transport` before claiming a missing transport", () => {
    expect(isTransportRequired("Parameter corrNr could not be found")).toBe(false);
    expect(isTransportRequired("A transport request is required")).toBe(true);
  });

  it("every signal carries its evidence", () => {
    for (const [name, definition] of Object.entries(SIGNAL_PATTERNS)) {
      expect(definition.evidence.length, name).toBeGreaterThan(0);
      expect(definition.patterns.length, name).toBeGreaterThan(0);
    }
  });
});
