/**
 * Minimal XML patching for read-modify-write updates.
 *
 * DDIC objects are updated by reading the current document, changing the fields
 * the caller asked for, and putting the whole thing back. Building the document
 * from scratch instead loses every field SAP manages (`adtcore:responsible`,
 * `masterSystem`, timestamps, server-side defaults).
 *
 * These helpers assume the well-formed, attribute-quoted XML that ADT returns.
 */

/** Replaces the text of `<prefix:tag>…</prefix:tag>`, or inserts it if absent. */
export function patchElement(xml: string, tag: string, value: string): string {
  const open = new RegExp(`<${escapeForRegex(tag)}(\\s[^>]*)?>[\\s\\S]*?</${escapeForRegex(tag)}>`);
  if (open.test(xml)) {
    return xml.replace(open, (match) => {
      const openTag = /^<[^>]+>/.exec(match)?.[0] ?? `<${tag}>`;
      return `${openTag}${escapeXmlText(value)}</${tag}>`;
    });
  }
  // Self-closing form.
  const selfClosing = new RegExp(`<${escapeForRegex(tag)}(\\s[^>]*)?/>`);
  if (selfClosing.test(xml)) {
    return xml.replace(selfClosing, (match) => {
      const openTag = match.slice(0, -2) + ">";
      return `${openTag}${escapeXmlText(value)}</${tag}>`;
    });
  }
  return xml;
}

/** Replaces an attribute value on the first element that has it. */
export function patchAttribute(xml: string, attribute: string, value: string): string {
  const pattern = new RegExp(`(${escapeForRegex(attribute)})="[^"]*"`);
  if (!pattern.test(xml)) return xml;
  return xml.replace(pattern, `$1="${escapeXmlAttribute(value)}"`);
}

/** Replaces a whole block `<tag>…</tag>` (or its self-closing form) with raw XML. */
export function patchBlock(xml: string, tag: string, block: string): string {
  const paired = new RegExp(`<${escapeForRegex(tag)}(\\s[^>]*)?>[\\s\\S]*?</${escapeForRegex(tag)}>`);
  if (paired.test(xml)) return xml.replace(paired, block);
  const selfClosing = new RegExp(`<${escapeForRegex(tag)}(\\s[^>]*)?/>`);
  if (selfClosing.test(xml)) return xml.replace(selfClosing, block);
  return xml;
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
