/**
 * SmartForm tools.
 *
 * SAP has no ADT resource for Smart Forms: ADT discovery advertises no such
 * collection, and a form is a cluster of tables (STXFADM / STXFADMI / STXFTXT)
 * plus a generated function module. Every tool here therefore runs through the
 * `ZMCP_SSF_*` bridge function modules (function group `ZMCP_SSF_UTILS`, sources
 * in `abap/`), reached through the `SSF_CONTENT` / `SSF_UPLOAD_XML` /
 * `SSF_DELETE_FORM` actions of `ZMCP_ADT_DISPATCH`.
 *
 * The bridge answers the Form Builder XML (the format of SMARTFORMS > Utilities >
 * Download); the layout and the content outline below are derived from that XML
 * here, so a page and window read costs one round trip, not one per node.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegistry, ToolContext } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import { GatewayError } from "../engine/errors.js";
import { AdtError } from "../adt/errors.js";
import { RfcBridge } from "../adt/rfc.js";
import { hasSignal } from "../adt/signals.js";

type Args = Record<string, unknown>;

const arg = (args: Args, name: string): string | undefined => {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const required = (args: Args, name: string, tool: string): string => {
  const value = arg(args, name);
  if (value === undefined) throw new GatewayError("INVALID_ARGUMENT", `${tool}: missing "${name}".`);
  return value;
};

/** `true` unless the caller said `false`; the contract's flags are booleans. */
const flagOn = (args: Args, name: string, fallback: boolean): boolean => {
  const value = args[name];
  return typeof value === "boolean" ? value : fallback;
};

/** SAP flags travel as `X` / empty; `switchFlag` sends `X` / `N` so "off" cannot be
 * confused with "not passed" (the bridge reads an empty string as "absent"). */
const sapFlag = (on: boolean): string => (on ? "X" : "");
const switchFlag = (on: boolean): string => (on ? "X" : "N");

/** A form name is 30 characters, customer namespace, no lower case. */
function formName(args: Args, tool: string): string {
  const name = required(args, "form_name", tool).trim().toUpperCase();
  if (!/^[ZY][A-Z0-9_]{0,29}$/.test(name)) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: "${name}" is not a Z*/Y* SmartForm name.`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// A very small XML reader — enough for the Form Builder XML, which has elements,
// plain text and no mixed content.
// ---------------------------------------------------------------------------

interface Element {
  /** Tag name as written, e.g. `sf:NODE`. */
  readonly name: string;
  /** Tag name without the namespace prefix, e.g. `NODE`. */
  readonly local: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly (Element | string)[];
}

const TOKEN =
  /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

function parseXml(text: string): Element {
  const root: Element = { name: "#document", local: "#document", attrs: {}, children: [] };
  const children: (Element | string)[][] = [root.children as (Element | string)[]];
  const open: Element[] = [root];
  const attribute = /([\w.:-]+)\s*=\s*"([^"]*)"/g;

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const [, cdata, closing, name, rawAttrs, selfClosing, characters] = match;
    const bucket = children[children.length - 1]!;
    if (characters !== undefined) {
      if (characters.trim() !== "") bucket.push(characters.trim());
      continue;
    }
    if (cdata !== undefined) {
      bucket.push(cdata);
      continue;
    }
    if (name === undefined) continue; // declaration or comment
    if (closing === "/") {
      if (open.length > 1) {
        open.pop();
        children.pop();
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    attribute.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = attribute.exec(rawAttrs ?? "")) !== null) attrs[attr[1]!] = attr[2]!;
    const element: Element = {
      name,
      local: name.includes(":") ? name.slice(name.indexOf(":") + 1) : name,
      attrs,
      children: [],
    };
    bucket.push(element);
    if (selfClosing !== "/") {
      open.push(element);
      children.push(element.children as (Element | string)[]);
    }
  }
  return root;
}

const elements = (parent: Element, local: string): Element[] =>
  parent.children.filter((child): child is Element => typeof child !== "string" && child.local === local);

const first = (parent: Element, local: string): Element | undefined => elements(parent, local)[0];

const textOf = (element: Element | undefined): string | undefined => {
  if (element === undefined) return undefined;
  const parts = element.children.filter((child): child is string => typeof child === "string");
  return parts.length === 0 ? undefined : parts.join("").trim();
};

const fieldOf = (parent: Element | undefined, local: string): string | undefined =>
  parent === undefined ? undefined : textOf(first(parent, local));

/** Depth-first, document order. */
function descendants(parent: Element, local: string, into: Element[] = []): Element[] {
  for (const child of parent.children) {
    if (typeof child === "string") continue;
    if (child.local === local) into.push(child);
    descendants(child, local, into);
  }
  return into;
}

/** The caption SAP shows in the tree, for the language the form is read in. */
function captionOf(node: Element, language: string | undefined): string | undefined {
  const captions = descendants(first(node, "T_CAPTION") ?? node, "item");
  const wanted = language === undefined ? undefined : captions.find((item) => fieldOf(item, "LANGU") === language);
  return fieldOf(wanted ?? captions[0], "CAPTION");
}

// ---------------------------------------------------------------------------
// Layout: page formats, pages, windows, and the stored geometry in millimetres.
// ---------------------------------------------------------------------------

interface Extent {
  readonly value: number;
  readonly unit: string;
  /** `null` for a unit this gateway cannot convert (SAP keeps adding them). */
  readonly mm: number | null;
}

const POINT_MM = 25.4 / 72;
const TWIP_MM = 25.4 / 1440;

/**
 * Units the Form Builder writes: absolute lengths plus the character-based
 * `CH` / `LN` that depend on the page's characters per inch / lines per inch.
 */
function toMillimetres(value: number, unit: string, axis: "x" | "y", cpi: number, lpi: number): number | null {
  switch (unit.toUpperCase()) {
    case "MM":
      return value;
    case "CM":
      return value * 10;
    case "IN":
      return value * 25.4;
    case "PT":
      return value * POINT_MM;
    case "TW":
      return value * TWIP_MM;
    case "CH":
      return axis === "x" ? (value / cpi) * 25.4 : (value / lpi) * 25.4;
    case "LN":
      return (value / lpi) * 25.4;
    default:
      return null;
  }
}

function extentOf(
  holder: Element | undefined,
  valueTag: string,
  unitTag: string,
  axis: "x" | "y",
  cpi: number,
  lpi: number,
): Extent | undefined {
  const raw = fieldOf(holder, valueTag);
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  const unit = (fieldOf(holder, unitTag) ?? "").toUpperCase();
  const mm = toMillimetres(value, unit, axis, cpi, lpi);
  return { value, unit, mm: mm === null ? null : Math.round(mm * 100) / 100 };
}

interface Window {
  readonly name: string | undefined;
  readonly type: string | undefined;
  readonly type_text: string | undefined;
  readonly caption: string | undefined;
  readonly top: Extent | undefined;
  readonly left: Extent | undefined;
  readonly width: Extent | undefined;
  readonly height: Extent | undefined;
  readonly nodes: readonly ContentNode[];
}

interface ContentNode {
  readonly type: string;
  readonly name: string | undefined;
  readonly caption: string | undefined;
  readonly fields?: Readonly<Record<string, string>>;
  readonly lines?: readonly string[];
}

interface Page {
  readonly name: string | undefined;
  readonly caption: string | undefined;
  readonly orientation: string | undefined;
  readonly next_page: string | undefined;
  readonly numbering: string | undefined;
  readonly windows: readonly Window[];
}

interface Layout {
  readonly page_formats: readonly {
    readonly format: string | undefined;
    readonly cpi: number;
    readonly lpi: number;
    readonly style: string | undefined;
    readonly output_mode: string | undefined;
  }[];
  readonly pages: readonly Page[];
  readonly style_names: readonly string[];
}

/**
 * Window types as SAP names them — `CL_SSF_FB_WINDOW`:
 * `C_WTYPE_MAIN = 'M'`, `_TEXT = 'T'` ("Nicht-Hauptfenster"), `_GRAPHIC = 'G'`,
 * `_ADDRESS = 'A'`, `_COPY = 'C'`, `_LATEFORM = 'L'` ("am Ende des Formulars").
 */
const WINDOW_TYPES: Readonly<Record<string, string>> = {
  M: "MAIN",
  T: "NON_MAIN",
  G: "GRAPHIC",
  A: "ADDRESS",
  C: "COPY",
  L: "FINAL",
};

/** Leaf values of the node's own object element — what SE80 shows on its tab. */
function objectFields(node: Element): Record<string, string> {
  const obj = first(node, "OBJ");
  if (obj === undefined) return {};
  const inner = obj.children.find((child): child is Element => typeof child !== "string");
  if (inner === undefined) return {};
  const fields: Record<string, string> = {};
  for (const child of inner.children) {
    if (typeof child === "string") continue;
    const value = textOf(child);
    if (value !== undefined && child.children.every((grand) => typeof grand === "string")) fields[child.local] = value;
  }
  return fields;
}

/** The paragraphs of a text node (`TDFORMAT` = paragraph format, `TDLINE` = text). */
function textLines(node: Element): string[] | undefined {
  const obj = first(node, "OBJ");
  const text = obj === undefined ? undefined : first(obj, "TEXT");
  if (text === undefined) return undefined;
  const lines = descendants(text, "item")
    .filter((item) => first(item, "TDLINE") !== undefined)
    .map((item) => `${fieldOf(item, "TDFORMAT") ?? ""}|${fieldOf(item, "TDLINE") ?? ""}`);
  return lines.length === 0 ? undefined : lines;
}

const notContent = (local: string): boolean => /^(TDFORMAT|TDLINE|CAPTION)$/.test(local);

function outlineOf(container: Element, language: string | undefined): ContentNode[] {
  const nodes: ContentNode[] = [];
  for (const node of descendants(container, "NODE")) {
    const type = fieldOf(node, "NODETYPE");
    if (type === undefined || type === "WI" || type === "PA" || type === "RP") continue;
    const obj = first(node, "OBJ") ?? node;
    const name = fieldOf(first(obj, "NAME") ?? obj, "INAME");
    const fields = Object.fromEntries(Object.entries(objectFields(node)).filter(([key]) => !notContent(key)));
    const lines = textLines(node);
    nodes.push({
      type,
      name,
      caption: captionOf(node, language),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
      ...(lines === undefined ? {} : { lines }),
    });
  }
  return nodes;
}

function layoutOf(xml: string, language: string | undefined, withNodes: boolean): Layout {
  const document = parseXml(xml);
  const form = descendants(document, "SMARTFORM")[0] ?? document;
  const formats: Layout["page_formats"][number][] = [];
  const pages: Page[] = [];
  const styleNames = new Set<string>();

  const variants = descendants(form, "VARHEADER").flatMap((header) => elements(header, "item"));
  for (const variant of variants.length === 0 ? [form] : variants) {
    const cpi = Number(fieldOf(variant, "CPI") ?? "0") || 12;
    const lpi = Number(fieldOf(variant, "LPI") ?? "0") || 6;
    const style = fieldOf(variant, "STDSTYLE");
    if (style !== undefined && style !== "") styleNames.add(style);
    formats.push({
      format: fieldOf(variant, "PAGEFORMAT"),
      cpi,
      lpi,
      style,
      output_mode: fieldOf(variant, "XSFOUTMODE"),
    });

    const pageTree = first(variant, "PAGETREE") ?? variant;
    const pageNodes = descendants(pageTree, "NODE").filter((node) => fieldOf(node, "NODETYPE") === "PA");
    for (const pageNode of pageNodes) {
      const page = first(first(pageNode, "OBJ") ?? pageNode, "PAGE") ?? pageNode;
      const pageName = fieldOf(first(page, "NAME") ?? page, "INAME");
      const windows: Window[] = [];
      for (const windowNode of descendants(pageNode, "NODE")) {
        if (fieldOf(windowNode, "NODETYPE") !== "WI") continue;
        const window = first(first(windowNode, "OBJ") ?? windowNode, "WINDOW") ?? windowNode;
        const holder = descendants(windowNode, "OUTATTR").find((candidate) => first(candidate, "WWIDTH") !== undefined);
        const type = fieldOf(window, "WTYPE");
        windows.push({
          name: fieldOf(first(window, "NAME") ?? window, "INAME"),
          type,
          type_text: type === undefined ? undefined : (WINDOW_TYPES[type] ?? type),
          caption: captionOf(windowNode, language),
          top: extentOf(holder, "WTOP", "U_WTOP", "y", cpi, lpi),
          left: extentOf(holder, "WLEFT", "U_WLEFT", "x", cpi, lpi),
          width: extentOf(holder, "WWIDTH", "U_WWIDTH", "x", cpi, lpi),
          height: extentOf(holder, "WHEIGHT", "U_WHEIGHT", "y", cpi, lpi),
          nodes: withNodes ? outlineOf(first(windowNode, "PROC_CTRL") ?? windowNode, language) : [],
        });
      }
      pages.push({
        name: pageName,
        caption: captionOf(pageNode, language),
        orientation: fieldOf(page, "PAGEORTN"),
        next_page: fieldOf(first(page, "NEXTPAGE") ?? page, "INAME"),
        numbering: [fieldOf(page, "NUMB_MODE"), fieldOf(page, "NUMB_TYPE")].filter(Boolean).join("/") || undefined,
        windows,
      });
    }
  }

  // Styles the text nodes name, so the caller can fetch their CSS too.
  for (const style of descendants(form, "STYLE_NAME")) {
    const value = textOf(style);
    if (value !== undefined && value !== "") styleNames.add(value);
  }

  return { page_formats: formats, pages, style_names: [...styleNames] };
}

// ---------------------------------------------------------------------------
// The tools.
// ---------------------------------------------------------------------------

export const SMARTFORM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "CreateSmartForm",
  "DeleteSmartForm",
  "GetSmartFormContent",
  "GetSmartFormLayout",
  "RenderSmartForm",
]);

type Dispatch = (action: string, params: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>;

const reader = (runtime: GatewayRuntime, ctx: ToolContext, args: Args, tool: string): Dispatch => {
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), false);
  const bridge = new RfcBridge(resolved.session);
  return async (action, params) => {
    try {
      const answer = await bridge.dispatch(action, params);
      return answer.result !== null && typeof answer.result === "object"
        ? (answer.result as Record<string, unknown>)
        : {};
    } catch (error) {
      const message = String((error as Error).message ?? error);
      // Only a dispatcher-level failure ("could not be called", subrc=8) means the bridge
      // is missing; "SmartForm X does not exist" is an ordinary refusal and keeps its words.
      const bridgeProblem = hasSignal(message, "bridge-missing");
      // A form that does not exist is the caller's input, not an SAP fault: measured live
      //, `GetSmartFormContent {form_name: "ZMCP_NEVER_FORM9"}` answered
      // `UPSTREAM_FAILED` with "SmartForm ZMCP_NEVER_FORM9 does not exist", so a caller
      // branching on `not-found` saw a server problem instead of a wrong name.
      const missing = /does not exist|不存在/i.test(message);
      const details = (error as { details?: Record<string, unknown> }).details;
      if (missing) {
        throw new AdtError({
          code: "not-found",
          message: `${tool}: ${message}`,
          nextAction:
            "check the form name; the bridge reads the ACTIVE version only, so a form that was never activated cannot be read",
          status: 404,
          method: "RFC",
          path: action,
        });
      }
      throw new GatewayError("UPSTREAM_FAILED", `${tool}: ${message}`, {
        ...(details ?? {}),
        ...(bridgeProblem
          ? { nextAction: "check that ZMCP_SSF_CONTENT / ZMCP_SSF_UPLOAD / ZMCP_SSF_DELETE are active in ZMCP_SSF_UTILS" }
          : {}),
      });
    }
  };
};

/** Reads the Form Builder XML the layout and the outline are derived from. */
async function readForm(dispatch: Dispatch, name: string): Promise<{ xml: string; language: string | undefined }> {
  let form: Record<string, unknown>;
  try {
    form = await dispatch("SSF_CONTENT", { part: "FORM", form_name: name });
  } catch (error) {
    // FB_CONVERT_FORM_TO_XML has no fallback to the saved version, so a form that was
    // created but never activated can only be reported, not read.
    if (/no active version/i.test(String((error as Error).message ?? ""))) {
      throw new GatewayError(
        "UPSTREAM_FAILED",
        `SmartForm ${name} has no active version: ZMCP_SSF_CONTENT reads the active form only, ` +
          "so a form that was only saved cannot be read here.",
        { nextAction: `activate ${name} in SMARTFORMS, then read it again` },
      );
    }
    throw error;
  }
  const xml = String(form.XML ?? "");
  if (xml === "") throw new GatewayError("UPSTREAM_FAILED", `SmartForm ${name}: the bridge returned no XML.`);
  const language = form.LANGUAGE === undefined ? undefined : String(form.LANGUAGE);
  return { xml, language };
}

async function getLayout(args: Args, ctx: ToolContext, runtime: GatewayRuntime): Promise<unknown> {
  const tool = "GetSmartFormLayout";
  const name = formName(args, tool);
  const dispatch = reader(runtime, ctx, args, tool);
  const { xml, language } = await readForm(dispatch, name);
  const layout = layoutOf(xml, language, false);
  if (layout.pages.length === 0) {
    throw new GatewayError("UPSTREAM_FAILED", `${tool}: SmartForm ${name} has no page in its XML.`);
  }
  return {
    success: true,
    transport: "rfc",
    form_name: name,
    language,
    // FB_CONVERT_FORM_TO_XML reads the active version only; a form that was never
    // activated is refused by the bridge instead of being read from its saved state.
    active: true,
    page_formats: layout.page_formats,
    pages: layout.pages,
  };
}

/** `&SYMBOL&` names the form uses, in source order and without duplicates. */
function symbolsIn(xml: string): string[] {
  const plain = xml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const found: string[] = [];
  for (const match of plain.matchAll(/&([A-Za-z_][A-Za-z0-9_]*)&/g)) {
    const name = (match[1] ?? "").toUpperCase();
    if (name !== "" && !found.includes(name)) found.push(name);
  }
  return found;
}

async function getContent(args: Args, ctx: ToolContext, runtime: GatewayRuntime): Promise<unknown> {
  const tool = "GetSmartFormContent";
  const name = formName(args, tool);
  const dispatch = reader(runtime, ctx, args, tool);
  const { xml, language } = await readForm(dispatch, name);
  const layout = layoutOf(xml, language, true);
  const summary = flagOn(args, "summary", false);

  const styles: { name: string; css?: string; error?: string }[] = [];
  if (flagOn(args, "include_styles", true)) {
    for (const style of layout.style_names) {
      try {
        const answer = await dispatch("SSF_CONTENT", { part: "STYLE", name: style });
        styles.push({ name: style, css: String(answer.CSS ?? "") });
      } catch (error) {
        styles.push({ name: style, error: String((error as Error).message ?? error).slice(0, 200) });
      }
    }
  }

  let texts: string[] | undefined;
  if (flagOn(args, "include_texts", true)) {
    try {
      const answer = await dispatch("SSF_CONTENT", { part: "TEXTS", form_name: name });
      const lines = Array.isArray(answer.LINES) ? (answer.LINES as Record<string, unknown>[]) : [];
      texts = lines.map((line) => String(line.TEXT ?? ""));
    } catch {
      // A form without form texts answers sy-subrc=4; that is not an error.
      texts = [];
    }
  }

  const counts: Record<string, number> = {};
  for (const page of layout.pages) {
    for (const window of page.windows) {
      for (const node of window.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
    }
  }

  const base = {
    success: true,
    transport: "rfc",
    form_name: name,
    language,
    active: true,
    page_formats: layout.page_formats,
    page_count: layout.pages.length,
    window_count: layout.pages.reduce((sum, page) => sum + page.windows.length, 0),
    node_counts: counts,
    styles,
    ...(texts === undefined ? {} : { texts }),
    // The bridge does not export SE78 graphics; SE78 stays the place to look at them.
    graphics: {
      fetched: false,
      reason: "ZMCP_SSF_CONTENT does not export SE78 graphics; the graphic keys are in the node fields.",
    },
  };

  // The description promises the files, and `summary` promises an overview of them: before
  // nothing was written (no `files`, no `<form>.content.json`) and the full content
  // tree plus 128 KB of Form Builder XML came back in the answer instead.
  const dir = join(outputDir(), "smartforms", name);
  const contentFile = join(dir, `${name}.content.json`);
  const xmlFile = join(dir, `${name}.form.xml`);
  const full = { ...base, pages: layout.pages, windows: windowsOverview(layout), symbols: symbolsIn(xml), xml };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(contentFile, `${JSON.stringify(full, null, 2)}\n`, "utf8");
    writeFileSync(xmlFile, xml, "utf8");
  } catch (error) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      `${tool}: cannot write to "${dir}": ${String((error as Error).message ?? error)}.`,
      { nextAction: "check ABAP_ADT_MCP_OUTPUT_DIR and its permissions" },
    );
  }

  return summary
    ? {
        ...base,
        // The CSS of one SmartStyle is ~8 KB; an overview says how much there is, and the full
        // text is in `files.content`.
        styles: styles.map((style) =>
          style.error === undefined
            ? { name: style.name, css_chars: (style.css ?? "").length }
            : { name: style.name, error: style.error },
        ),
        windows: windowsOverview(layout),
        symbols: symbolsIn(xml),
        files: { content: contentFile, xml: xmlFile },
      }
    : { ...base, pages: layout.pages, files: { content: contentFile, xml: xmlFile } };
}

/** `{page, name, caption, type, top_mm, height_mm}` per window — the overview `summary` promises. */
function windowsOverview(layout: ReturnType<typeof layoutOf>): Array<Record<string, unknown>> {
  return layout.pages.flatMap((page) =>
    page.windows.map((window) => ({
      page: page.name,
      name: window.name,
      caption: window.caption,
      type: window.type,
      ...(window.top === undefined ? {} : { top_mm: window.top.mm }),
      ...(window.height === undefined ? {} : { height_mm: window.height.mm }),
    })),
  );
}

async function createForm(args: Args, ctx: ToolContext, runtime: GatewayRuntime): Promise<unknown> {
  const tool = "CreateSmartForm";
  const name = formName(args, tool);
  const file = required(args, "xml_file", tool);
  if (arg(args, "transport_request") !== undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: the bridge writes local forms only, so it cannot record a transport request.`, {
      nextAction: "drop transport_request and package_name (the form goes to $TMP), or create it in SMARTFORMS",
    });
  }
  const packageName = arg(args, "package_name");
  if (packageName !== undefined && !packageName.startsWith("$")) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: package "${packageName}" is transportable; the bridge writes $… packages only.`, {
      nextAction: "pass package_name = \"$TMP\" or create the form in SMARTFORMS and transport it there",
    });
  }

  let xml: string;
  try {
    xml = readFileSync(file, "utf8");
  } catch (error) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: cannot read "${file}": ${String((error as Error).message ?? error)}.`);
  }
  if (!/<(sf:)?SMARTFORM/i.test(xml)) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: "${file}" is not Form Builder XML (no SMARTFORM element).`, {
      nextAction: "use the file SMARTFORMS > Utilities > Download writes",
    });
  }

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);
  const answer = await bridge.dispatch("SSF_UPLOAD_XML", {
    form_name: name,
    xml,
    overwrite: sapFlag(flagOn(args, "overwrite", false)),
    // A blank, not an empty string: the bridge must tell "off" from "not passed".
    activate: switchFlag(flagOn(args, "activate", true)),
  });
  const result = (answer.result ?? {}) as Record<string, unknown>;
  // `ACTIVE` says the form was stored, not that SAP could generate its function
  // module. A form whose interface names a missing type is stored active but has no
  // generated module; the old success answer sent the caller to `RenderSmartForm`,
  // which then failed with a misleading "activate it first". Treat that as the
  // activation failure it is.
  if (flagOn(args, "activate", true) && String(result.GENERATED_FM ?? "") === "") {
    throw new GatewayError(
      "UPSTREAM_FAILED",
      `${tool}: SmartForm ${name} was stored but SAP generated no function module.`,
      {
        details: { result },
        nextAction:
          "check the form interface types (a missing DDIC/CDS structure or table type is the usual cause), then activate the form in SMARTFORMS and render it again",
      },
    );
  }
  return {
    success: true,
    transport: "rfc",
    form_name: name,
    package_name: result.PACKAGE_NAME,
    language: result.LANGUAGE,
    stored: result.STORED === "X",
    active: result.ACTIVE === "X",
    generated_fm: result.GENERATED_FM === "" ? undefined : result.GENERATED_FM,
  };
}

async function deleteForm(args: Args, ctx: ToolContext, runtime: GatewayRuntime): Promise<unknown> {
  const tool = "DeleteSmartForm";
  const name = formName(args, tool);
  const confirm = flagOn(args, "confirm", false);
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);
  const answer = await bridge.dispatch("SSF_DELETE_FORM", { form_name: name, confirm: sapFlag(confirm) });
  const result = (answer.result ?? {}) as Record<string, unknown>;
  return {
    success: true,
    transport: "rfc",
    form_name: name,
    dry_run: !confirm,
    deleted: result.DELETED === "X",
    package_name: result.PACKAGE_NAME,
    generated_fm: result.GENERATED_FM === "" ? undefined : result.GENERATED_FM,
    tadir_left: result.TADIR_LEFT === "X",
    ...(confirm ? {} : { nextAction: "pass confirm: true to delete it" }),
  };
}

/**
 * Where the rendered files go — one place for every file the gateway writes, so the
 * override (`ABAP_ADT_MCP_OUTPUT_DIR`) is read the same way here and for `output: "file"`.
 */
import { outputDir } from "./output-dir.js";

async function renderForm(args: Args, ctx: ToolContext, runtime: GatewayRuntime): Promise<unknown> {
  const tool = "RenderSmartForm";
  const name = formName(args, tool);

  // `values` wins over `values_file`; both are the same object.
  let values: unknown = args["values"];
  if (values === undefined) {
    const file = arg(args, "values_file");
    if (file !== undefined) {
      try {
        values = JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch (error) {
        throw new GatewayError("INVALID_ARGUMENT", `${tool}: cannot read "${file}": ${String((error as Error).message ?? error)}.`);
      }
    }
  }
  if (values !== undefined && (values === null || typeof values !== "object" || Array.isArray(values))) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: "values" must be a JSON object of interface parameters.`);
  }

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), false);
  const bridge = new RfcBridge(resolved.session);
  let result: Record<string, unknown>;
  try {
    const answer = await bridge.dispatch("SSF_RENDER", {
      form_name: name,
      ...(arg(args, "language") === undefined ? {} : { language: arg(args, "language") }),
      ...(arg(args, "device") === undefined ? {} : { device: arg(args, "device") }),
      values: JSON.stringify(values ?? {}),
    });
    result = (answer.result ?? {}) as Record<string, unknown>;
  } catch (error) {
    const message = String((error as Error).message ?? error);
    // A form that was never activated cannot be rendered: its function module is missing.
    const details = (error as { details?: Record<string, unknown> }).details;
    throw new GatewayError("UPSTREAM_FAILED", `${tool}: ${message}`, {
      ...(details ?? {}),
      ...(hasSignal(message, "no-generated-function-module")
        ? { nextAction: `activate ${name} in SMARTFORMS, then render it again` }
        : {}),
    });
  }

  const directory = join(outputDir(), "smartforms", name);
  mkdirSync(directory, { recursive: true });
  const otfFile = join(directory, `${name}.sap.otf.txt`);
  const pdfFile = join(directory, `${name}.sap.pdf`);
  writeFileSync(otfFile, String(result["OTF_TEXT"] ?? ""), "utf8");

  const base64 = String(result["PDF_BASE64"] ?? "");
  const pdfWritten = base64 !== "";
  if (pdfWritten) writeFileSync(pdfFile, Buffer.from(base64, "base64"));

  return {
    success: true,
    transport: "rfc",
    form_name: name,
    language: result["LANGUAGE"],
    // Empty means the print parameters came from the user master (SU3 default device).
    device: result["DEVICE"] === "" ? undefined : result["DEVICE"],
    generated_fm: result["GENERATED_FM"],
    otf_lines: result["OTF_COUNT"],
    pdf_size: pdfWritten ? result["PDF_SIZE"] : undefined,
    // Parameters the caller left out were passed initial; the render used empty values.
    defaults_used: result["DEFAULTS"] === "" ? undefined : String(result["DEFAULTS"] ?? "").split(","),
    files: { otf: otfFile, ...(pdfWritten ? { pdf: pdfFile } : {}) },
    ...(pdfWritten ? {} : { note: "the PDF conversion returned nothing; only the OTF text was written" }),
  };
}

export function registerSmartFormTools(registry: ToolRegistry, runtime: GatewayRuntime): void {
  const register = (name: string, handler: (args: Args, ctx: ToolContext) => Promise<unknown>): void => {
    if (registry.has(name)) registry.register(name, handler);
  };
  register("GetSmartFormLayout", (args, ctx) => getLayout(args, ctx, runtime));
  register("GetSmartFormContent", (args, ctx) => getContent(args, ctx, runtime));
  register("CreateSmartForm", (args, ctx) => createForm(args, ctx, runtime));
  register("DeleteSmartForm", (args, ctx) => deleteForm(args, ctx, runtime));
  register("RenderSmartForm", (args, ctx) => renderForm(args, ctx, runtime));
}
