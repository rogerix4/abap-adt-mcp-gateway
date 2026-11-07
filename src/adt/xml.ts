/**
 * XML helpers: escaping, entity decoding, tag stripping, and structural reading.
 *
 * One implementation on purpose. The same five-line `&amp;` chain existed in six
 * files with three different orderings, and the order is the whole bug:
 *
 *   - `&amp;` decoded **before** `&lt;` turns a single escape `&amp;lt;` into `<`,
 *     i.e. text that SAP escaped once is read as markup;
 *   - a path that forgot the chain leaked `&gt;` into the message the model reads —
 * measured: an activation error arrived as
 *     `Unable to interpret "LO_WORKSHEET-&gt;SET_CELL("`, which reads like a syntax
 *     error in a line the caller never touched.
 *
 * So: decode named entities first, numeric entities second, `&amp;` **last**.
 *
 * Reading ADT answers goes through a real parser (`fast-xml-parser`), not a regex over
 * markup. Regexes over XML cannot nest: `<a><a/></a>` matches up to the first `</a>`, and
 * every new shape SAP ships costs one more branch. The parser also strips namespace
 * prefixes, so `chkrun:checkMessage` and `checkMessage` are the same element here — that
 * is what makes the message readers shape-independent.
 */

import { XMLParser } from "fast-xml-parser";

import { isWellFormed } from "./xml-scan.js";

const NAMED_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&nbsp;/g, " "],
];

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

/** Decodes the entities ADT puts in element text and attributes. `&amp;` goes last. */
export function decodeXmlEntities(value: string): string {
  let text = value;
  for (const [pattern, replacement] of NAMED_ENTITIES) text = text.replace(pattern, replacement);
  text = text.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePoint(Number.parseInt(hex, 16)));
  text = text.replace(/&#(\d+);/g, (_match, decimal: string) => codePoint(Number(decimal)));
  return text.replace(/&amp;/g, "&");
}

/** Replaces every tag with a space — for turning an ADT HTML error page into one line. */
export function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

/** Drops tags and decodes entities: the readable text of an element or a document. */
export function plainText(value: string): string {
  const withoutBlocks = value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
  return decodeXmlEntities(stripTags(withoutBlocks)).replace(/\s+/g, " ").trim();
}

/**
 * The first element name in the document, XML declaration and comments skipped.
 *
 * Used when an answer has no text at all: "210 bytes, no <msg>, root <chkl:messages>"
 * says which shape arrived, while "a document I cannot read" does not.
 */
export function rootElement(value: string): string | undefined {
  const withoutProlog = value.replace(/<\?xml[^>]*\?>/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
  return /<([A-Za-z_][\w:.-]*)/.exec(withoutProlog)?.[1];
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ *
 * Structural reading
 * ------------------------------------------------------------------ */

/** One parsed element: attributes under `@_name`, text under `#text`, children by name. */
export type XmlObject = Record<string, unknown>;

const ADT_XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // `chkrun:type` and `type` have to land on the same key, otherwise every reader needs
  // to know which prefix the release of the day uses.
  removeNSPrefix: true,
  // Values stay strings: `0100` must not become 100, and `false` must not become a boolean.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  allowBooleanAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/**
 * Parses an ADT document, or `undefined` when the text is not well-formed XML.
 *
 * The document is validated first because the parser is lenient: `<a><b></a>` silently
 * becomes `{a:{b:""}}`, and a half-understood document is exactly what must not be reported
 * as a clean result. (`XMLValidator` would do this too, but it is deprecated in 5.12 and
 * this repository's gate refuses deprecated symbols; `xml-scan.ts` already has the
 * knowledge, so it answers the question.) Malformed input has to reach the caller as
 * `unrecognized`, not as zero.
 */
export function parseXml(text: string): XmlObject | undefined {
  if (text.trim().length === 0) return undefined;
  if (!isWellFormed(text)) return undefined;
  try {
    const parsed: unknown = ADT_XML.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as XmlObject) : undefined;
  } catch {
    return undefined;
  }
}

/** The document element's name, namespace prefix already stripped. */
export function rootNameOf(parsed: XmlObject): string | undefined {
  return Object.keys(parsed).find((key) => !key.startsWith("@_") && key !== "#text");
}

/** Every element with this local name, at any depth. Handles single and repeated tags. */
export function findElements(root: unknown, localName: string): XmlObject[] {
  const found: XmlObject[] = [];
  const wanted = localName.toLowerCase();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as XmlObject)) {
      if (key.startsWith("@_")) continue;
      if (key.toLowerCase() === wanted) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== null && typeof item === "object") found.push(item as XmlObject);
          else if (item !== undefined) found.push({ "#text": String(item) });
        }
      }
      if (key !== "#text") visit(value);
    }
  };

  visit(root);
  return found;
}

/**
 * An attribute value.
 *
 * Only `@_name` is an attribute. The unprefixed key is accepted **solely when it is a
 * primitive**, because `node[name]` is also where a child element of the same name lives —
 * taking it unconditionally turned `<msg><shortText><txt>…</txt></shortText></msg>` into
 * the string `[object Object]` (measured, the activation text came back empty).
 */
export function attributeOf(node: XmlObject, name: string): string | undefined {
  const prefixed = node[`@_${name}`];
  if (prefixed !== undefined && prefixed !== null) {
    return typeof prefixed === "string" ? prefixed : String(prefixed);
  }
  const plain = node[name];
  if (typeof plain === "string" || typeof plain === "number" || typeof plain === "boolean") {
    return String(plain);
  }
  return undefined;
}

/** The text of a named child element, trimmed. */
export function childTextOf(node: XmlObject, name: string): string | undefined {
  const child = node[name];
  if (child === undefined || child === null) return undefined;
  const first = Array.isArray(child) ? child[0] : child;
  if (first === null || first === undefined) return undefined;
  if (typeof first === "string") return first.trim();
  if (typeof first !== "object") return String(first).trim();
  return nodeTextOf(first as XmlObject);
}

/**
 * The readable text of one ADT message element, wherever the release put it.
 *
 * Three shapes are in use, all captured live: the text as an attribute
 * (`chkrun:shortText="…"`), as a child element of `<msg>`, and one level deeper —
 * `<msg><shortText><txt>…</txt></shortText></msg>` (measured ). Taking the first
 * `txt` descendant and falling back to the element's own text covers all three without a
 * shape branch per release.
 */
export function messageTextOf(node: XmlObject): string {
  const attribute = attributeOf(node, "shortText");
  if (attribute !== undefined && attribute.trim().length > 0) return attribute.trim();
  const txt = findElements(node, "txt")[0];
  if (txt !== undefined) {
    const text = nodeTextOf(txt);
    if (text.length > 0) return text;
  }
  return (childTextOf(node, "shortText") ?? nodeTextOf(node)).trim();
}

/**
 * The element's own text content (`<txt>…</txt>`), trimmed.
 */
export function nodeTextOf(node: XmlObject): string {
  const text = node["#text"];
  if (text === undefined || text === null) return "";
  return typeof text === "string" ? text.trim() : String(text).trim();
}
