/**
 * XML surgery for read-modify-write updates.
 *
 * DDIC objects are updated by reading the current document, changing the fields the
 * caller asked for, and putting the whole thing back. Building the document from scratch
 * instead loses every field SAP manages (`adtcore:responsible`, `masterSystem`,
 * timestamps, server-side defaults).
 *
 * Why a scanner and not a parse-then-serialise round trip: the document belongs to SAP.
 * Re-serialising rewrites every byte the caller did not ask to change — the declaration,
 * self-closing forms, attribute order, namespace layout, entity spelling — and the PUT
 * then differs from what was read in ways nobody can explain. This module therefore
 * *locates* the target and replaces exactly that span.
 *
 * What the scanner fixes compared with the regexes it replaces:
 *
 *   - **Nesting.** `<tag>[\s\S]*?</tag>` stops at the first `</tag>`, so a same-name child
 *     truncated the parent and appended a stray end tag. Depth is counted here.
 *   - **Quoted values.** `[^>]*` stops at a `>` inside an attribute value.
 *   - **Comments and CDATA.** A tag inside `<!-- … -->` used to be a valid match.
 *
 * The API is unchanged, including the two behaviours callers already depend on:
 * only the **first** matching element is touched, and a missing tag leaves the document
 * untouched (`descriptors.ts` relies on the latter to detect an absent field).
 */

import { findAttribute, findClose, findStartTag } from "./xml-scan.js";
import { escapeXmlAttribute, escapeXmlText } from "./xml.js";

/**
 * Replaces the text of the first `<prefix:tag>…</prefix:tag>`.
 *
 * A missing tag leaves the document untouched; a self-closing tag is expanded.
 */
export function patchElement(xml: string, tag: string, value: string): string {
  const open = findStartTag(xml, tag, 0);
  if (open === undefined) return xml;
  if (open.selfClosing) {
    const openTag = `${xml.slice(open.start, open.openEnd - 2)}>`;
    return `${xml.slice(0, open.start)}${openTag}${escapeXmlText(value)}</${tag}>${xml.slice(open.openEnd)}`;
  }
  const close = findClose(xml, tag, open.openEnd);
  if (close === undefined) return xml;
  return `${xml.slice(0, open.openEnd)}${escapeXmlText(value)}${xml.slice(close.start)}`;
}

/** Replaces an attribute value on the first element that has it. */
export function patchAttribute(xml: string, attribute: string, value: string): string {
  const hit = findAttribute(xml, attribute, 0);
  if (hit === undefined) return xml;
  return `${xml.slice(0, hit.valueStart)}${escapeXmlAttribute(value)}${xml.slice(hit.valueEnd)}`;
}

/** Replaces a whole block `<tag>…</tag>` (or its self-closing form) with raw XML. */
export function patchBlock(xml: string, tag: string, block: string): string {
  const open = findStartTag(xml, tag, 0);
  if (open === undefined) return xml;
  if (open.selfClosing) return `${xml.slice(0, open.start)}${block}${xml.slice(open.openEnd)}`;
  const close = findClose(xml, tag, open.openEnd);
  if (close === undefined) return xml;
  return `${xml.slice(0, open.start)}${block}${xml.slice(close.end)}`;
}

export { escapeXmlAttribute, escapeXmlText };
