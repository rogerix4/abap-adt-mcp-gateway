/**
 * XML surgery and structural reading.
 *
 * These are the two halves that replaced regexes over markup. The cases below are the
 * ones a regex cannot express, so they fail loudly if anything goes back: nesting,
 * `>` inside an attribute value, tags inside comments and CDATA, and the first-match-only
 * semantics the DDIC patchers rely on.
 */

import { describe, expect, it } from "vitest";

import { patchAttribute, patchBlock, patchElement } from "../src/adt/xml-patch.ts";
import {
  attributeOf,
  childTextOf,
  findElements,
  nodeTextOf,
  parseXml,
  rootNameOf,
} from "../src/adt/xml.ts";

describe("patchElement", () => {
  it("replaces the outer element when the same name is nested", () => {
    // `<tag>[\\s\\S]*?</tag>` stopped at the inner close tag and left a stray `</a>`.
    expect(patchElement("<a><a>inner</a></a>", "a", "X")).toBe("<a>X</a>");
  });

  it("keeps the attributes of the element it rewrites", () => {
    const xml = '<r><x:tag a="1"><x:tag a="2">v</x:tag></x:tag></r>';
    expect(patchElement(xml, "x:tag", "V")).toBe('<r><x:tag a="1">V</x:tag></r>');
  });

  it("expands a self-closing tag", () => {
    expect(patchElement('<r><t a="1"/></r>', "t", "V")).toBe('<r><t a="1">V</t></r>');
  });

  it("touches only the first match", () => {
    expect(patchElement("<r><t>1</t><t>2</t></r>", "t", "V")).toBe("<r><t>V</t><t>2</t></r>");
  });

  it("ignores a tag inside a comment", () => {
    expect(patchElement("<r><!-- <t>old</t> --><t>new</t></r>", "t", "V")).toBe(
      "<r><!-- <t>old</t> --><t>V</t></r>",
    );
  });

  it("ignores markup inside CDATA", () => {
    expect(patchElement("<r><t><![CDATA[<t>x</t>]]></t></r>", "t", "V")).toBe("<r><t>V</t></r>");
  });

  it("does not stop at a `>` inside an attribute value", () => {
    expect(patchElement('<r><t d="a>b">old</t></r>', "t", "V")).toBe('<r><t d="a>b">V</t></r>');
  });

  it("leaves a document without the tag untouched", () => {
    const xml = "<r><other/></r>";
    expect(patchElement(xml, "t", "V")).toBe(xml);
  });

  it("escapes the value it inserts", () => {
    expect(patchElement("<r><t>x</t></r>", "t", 'a<b>&"c"')).toBe('<r><t>a&lt;b&gt;&amp;"c"</t></r>');
  });
});

describe("patchAttribute", () => {
  it("replaces the value of the first element carrying the attribute", () => {
    expect(patchAttribute('<r><e d="1"/><e d="2"/></r>', "d", "Z")).toBe('<r><e d="Z"/><e d="2"/></r>');
  });

  it("handles `>` inside the old value", () => {
    expect(patchAttribute('<e d="a>b" f="c"/>', "d", "Z")).toBe('<e d="Z" f="c"/>');
  });

  it("handles single quotes and keeps them", () => {
    expect(patchAttribute("<e d='a>b'/>", "d", "Z")).toBe("<e d='Z'/>");
  });

  it("escapes quotes and ampersands in the value", () => {
    expect(patchAttribute('<e d="x"/>', "d", 'a"b&c')).toBe('<e d="a&quot;b&amp;c"/>');
  });

  it("leaves a document without the attribute untouched", () => {
    const xml = "<e f='1'/>";
    expect(patchAttribute(xml, "d", "Z")).toBe(xml);
  });
});

describe("patchBlock", () => {
  it("replaces a nested block completely", () => {
    expect(patchBlock("<r><t><t/></t></r>", "t", "<t/>")).toBe("<r><t/></r>");
  });

  it("replaces a self-closing block", () => {
    expect(patchBlock("<r><t/></r>", "t", "<t>x</t>")).toBe("<r><t>x</t></r>");
  });
});

describe("structural reading", () => {
  it("strips namespace prefixes so the same element has one name", () => {
    const parsed = parseXml(
      '<chkrun:checkMessages xmlns:chkrun="u"><chkrun:checkMessage chkrun:type="E" ' +
        'chkrun:uri="u#start=3,0" chkrun:line="3" chkrun:shortText="a &amp; b"/></chkrun:checkMessages>',
    );
    expect(parsed).toBeDefined();
    expect(rootNameOf(parsed as Record<string, unknown>)).toBe("checkMessages");
    const [message] = findElements(parsed, "checkMessage");
    expect(message).toBeDefined();
    expect(attributeOf(message!, "type")).toBe("E");
    expect(attributeOf(message!, "line")).toBe("3");
    expect(attributeOf(message!, "shortText")).toBe("a & b");
  });

  it("finds a repeated element and the text of an inner element", () => {
    const parsed = parseXml(
      "<messages><message><shortText>one</shortText></message><message><shortText>two</shortText></message></messages>",
    );
    const found = findElements(parsed, "message");
    expect(found).toHaveLength(2);
    expect(childTextOf(found[0]!, "shortText")).toBe("one");
    expect(childTextOf(found[1]!, "shortText")).toBe("two");
  });

  it("does not read a child element as an attribute of the same name", () => {
    const parsed = parseXml("<msg type=\"E\"><shortText><txt>x</txt></shortText></msg>");
    const [msg] = findElements(parsed, "msg");
    expect(attributeOf(msg!, "shortText")).toBeUndefined();
    expect(attributeOf(msg!, "type")).toBe("E");
    expect(childTextOf(msg!, "shortText")).toBe("");
  });

  it("decodes entities once, in the element's own text", () => {
    const parsed = parseXml('<msg type="E"><txt>LO &gt; X &amp;lt; Y</txt></msg>');
    const [msg] = findElements(parsed, "msg");
    expect(childTextOf(msg!, "txt")).toBe("LO > X &lt; Y");
    expect(nodeTextOf(msg!)).toBe("");
  });

  it("returns undefined for text that is not well-formed XML", () => {
    expect(parseXml("<a><b></a>")).toBeUndefined();
    expect(parseXml("")).toBeUndefined();
  });
});
