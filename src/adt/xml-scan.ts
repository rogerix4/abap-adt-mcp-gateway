/**
 * A small, offset-aware XML scanner.
 *
 * It exists because two different jobs need the same knowledge, and neither can get it
 * from a value-only parser:
 *
 *   - **Surgery**: `xml-patch.ts` has to replace one span of the document and leave every
 *     other byte alone, so it needs offsets.
 *   - **Well-formedness**: `parseXml` must refuse a half-understood document. The parser in
 *     `fast-xml-parser` is lenient — `<a><b></a>` silently becomes `{a:{b:""}}` — and its
 *     `XMLValidator` is deprecated in 5.12, which this repository's gate refuses.
 *
 * The scanner is deliberately strict about the subset ADT sends: element tags, attributes
 * in single or double quotes, comments, CDATA, processing instructions, doctype. It is not
 * a general XML parser and does not try to be one.
 */

export interface AttributeSpan {
  readonly name: string;
  /** Offsets of the value, quotes excluded. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

export interface ElementSpan {
  /** Offset of `<` of the start tag. */
  readonly start: number;
  /** Offset just past `>` of the start tag. */
  readonly openEnd: number;
  readonly selfClosing: boolean;
  readonly attributes: readonly AttributeSpan[];
}

export interface NamedElementSpan extends ElementSpan {
  readonly name: string;
}

export function isNameChar(ch: string): boolean {
  return ch === "-" || ch === "." || ch === ":" || /[A-Za-z0-9_]/.test(ch);
}

/** Offset just past a comment / CDATA / processing instruction / doctype, or `-1`. */
export function skipConstruct(xml: string, at: number): number {
  if (xml.startsWith("<!--", at)) {
    const end = xml.indexOf("-->", at + 4);
    return end < 0 ? xml.length : end + 3;
  }
  if (xml.startsWith("<![CDATA[", at)) {
    const end = xml.indexOf("]]>", at + 9);
    return end < 0 ? xml.length : end + 3;
  }
  if (xml.startsWith("<?", at)) {
    const end = xml.indexOf("?>", at + 2);
    return end < 0 ? xml.length : end + 2;
  }
  if (xml.startsWith("<!", at)) {
    const end = xml.indexOf(">", at + 2);
    return end < 0 ? xml.length : end + 1;
  }
  return -1;
}

/** Reads the start tag at `at` (which must be `<`). Returns the name only when it matches. */
export function readStartTag(xml: string, at: number, expected?: string): NamedElementSpan | undefined {
  if (xml[at] !== "<" || xml[at + 1] === "/" || xml[at + 1] === "!" || xml[at + 1] === "?") return undefined;
  let p = at + 1;
  const nameStart = p;
  while (p < xml.length && isNameChar(xml[p] as string)) p += 1;
  const name = xml.slice(nameStart, p);
  if (name.length === 0) return undefined;
  if (expected !== undefined && name !== expected) return undefined;

  const attributes: AttributeSpan[] = [];
  let selfClosing = false;
  while (p < xml.length) {
    const ch = xml[p] as string;
    if (ch === ">") {
      p += 1;
      break;
    }
    if (ch === "/" && xml[p + 1] === ">") {
      selfClosing = true;
      p += 2;
      break;
    }
    if (/\s/.test(ch)) {
      p += 1;
      continue;
    }
    const attrStart = p;
    while (p < xml.length && isNameChar(xml[p] as string)) p += 1;
    const attrName = xml.slice(attrStart, p);
    if (attrName.length === 0) {
      p += 1;
      continue;
    }
    while (p < xml.length && /\s/.test(xml[p] as string)) p += 1;
    if (xml[p] !== "=") {
      attributes.push({ name: attrName, valueStart: p, valueEnd: p });
      continue;
    }
    p += 1;
    while (p < xml.length && /\s/.test(xml[p] as string)) p += 1;
    const quote = xml[p];
    if (quote !== '"' && quote !== "'") {
      p += 1;
      continue;
    }
    p += 1;
    const valueStart = p;
    while (p < xml.length && xml[p] !== quote) p += 1;
    attributes.push({ name: attrName, valueStart, valueEnd: p });
    p += 1;
  }

  return { name, start: at, openEnd: p, selfClosing, attributes };
}

/** First start tag with this name at or after `from`. Comments and CDATA are skipped. */
export function findStartTag(xml: string, name: string, from: number): ElementSpan | undefined {
  let i = from;
  while (i < xml.length) {
    const at = xml.indexOf("<", i);
    if (at < 0) return undefined;
    const skip = skipConstruct(xml, at);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const tag = readStartTag(xml, at, name);
    if (tag !== undefined) return tag;
    i = at + 1;
  }
  return undefined;
}

/** First start tag carrying this attribute, at or after `from`. */
export function findAttribute(xml: string, attribute: string, from: number): AttributeSpan | undefined {
  let i = from;
  while (i < xml.length) {
    const at = xml.indexOf("<", i);
    if (at < 0) return undefined;
    const skip = skipConstruct(xml, at);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const tag = readStartTag(xml, at);
    if (tag !== undefined) {
      const hit = tag.attributes.find((span) => span.name === attribute);
      if (hit !== undefined) return hit;
    }
    i = at + 1;
  }
  return undefined;
}

/** The end tag matching the start tag that closes at `from`, counting nested same-name tags. */
export function findClose(xml: string, name: string, from: number): { start: number; end: number } | undefined {
  let depth = 1;
  let i = from;
  while (i < xml.length) {
    const at = xml.indexOf("<", i);
    if (at < 0) return undefined;
    const skip = skipConstruct(xml, at);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    if (xml[at + 1] === "/") {
      let p = at + 2;
      const nameStart = p;
      while (p < xml.length && isNameChar(xml[p] as string)) p += 1;
      const endName = xml.slice(nameStart, p);
      const gt = xml.indexOf(">", p);
      if (gt < 0) return undefined;
      if (endName === name) {
        depth -= 1;
        if (depth === 0) return { start: at, end: gt + 1 };
      }
      i = gt + 1;
      continue;
    }
    const nested = readStartTag(xml, at, name);
    if (nested !== undefined) {
      if (!nested.selfClosing) depth += 1;
      i = nested.openEnd;
      continue;
    }
    i = at + 1;
  }
  return undefined;
}

/**
 * Offsets of one element, start tag through end tag inclusive.
 *
 * For callers that need to look inside a block and then put the block back: slice
 * `[start, end)`, change what is inside, and hand it to `patchBlock`.
 */
export function elementSpan(
  xml: string,
  name: string,
  from = 0,
): { start: number; end: number; innerStart: number; innerEnd: number } | undefined {
  const open = findStartTag(xml, name, from);
  if (open === undefined) return undefined;
  if (open.selfClosing) {
    return { start: open.start, end: open.openEnd, innerStart: open.openEnd, innerEnd: open.openEnd };
  }
  const close = findClose(xml, name, open.openEnd);
  if (close === undefined) return undefined;
  return { start: open.start, end: close.end, innerStart: open.openEnd, innerEnd: close.start };
}

/**
 * True when the text is one well-formed document.
 *
 * Strict on purpose: a document this function rejects must be reported to the caller as
 * unreadable, because the alternative is a lenient parse that reports zero messages for a
 * document nobody understood.
 */
export function isWellFormed(xml: string): boolean {
  const stack: string[] = [];
  let roots = 0;
  let i = 0;

  while (i < xml.length) {
    const at = xml.indexOf("<", i);
    const text = at < 0 ? xml.slice(i) : xml.slice(i, at);
    // Only whitespace may sit outside the document element.
    if (stack.length === 0 && text.trim().length > 0) return false;
    if (at < 0) break;

    const skip = skipConstruct(xml, at);
    if (skip >= 0) {
      i = skip;
      continue;
    }

    if (xml[at + 1] === "/") {
      let p = at + 2;
      const nameStart = p;
      while (p < xml.length && isNameChar(xml[p] as string)) p += 1;
      const name = xml.slice(nameStart, p);
      while (p < xml.length && /\s/.test(xml[p] as string)) p += 1;
      if (name.length === 0 || xml[p] !== ">") return false;
      if (stack.pop() !== name) return false;
      i = p + 1;
      continue;
    }

    const tag = readStartTag(xml, at);
    if (tag === undefined) return false;
    if (stack.length === 0) {
      roots += 1;
      if (roots > 1) return false;
    }
    if (!tag.selfClosing) stack.push(tag.name);
    i = tag.openEnd;
  }

  return roots === 1 && stack.length === 0;
}
