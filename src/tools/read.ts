/**
 * Read-only tools that are not part of an object family.
 *
 * Every one answers from an ADT endpoint measured on the reference system, and
 * none of them writes — they are registered without a tier check, so a `qa` or
 * `prd` system can serve them too.
 */

import type { ToolRegistry } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import { GatewayError } from "../engine/errors.js";
import { parseDataPreview, parseDataPreviewDetailed } from "../adt/datapreview.js";
import { AdtError } from "../adt/errors.js";
import { isCuaMissingError, RfcBridge } from "../adt/rfc.js";
import { hasSignal } from "../adt/signals.js";
import { decodeXmlEntities } from "../adt/xml.js";
import { attributeOf, childTextOf, findElements, parseXml } from "../adt/xml.js";
import type { XmlObject } from "../adt/xml.js";
import type { AdtSession } from "../adt/session.js";
import { registerProfilerTools } from "./profiler.js";
import { parseAtomFeed } from "./atom-feed.js";
import { sourceFileAnswer } from "./source-output.js";

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(args: Args, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Dump / trace ids are opaque keys that callers often pass still percent-encoded. */
function opaqueId(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    const last = decoded.split("/").filter((part) => part.length > 0).pop() ?? decoded;
    return encodeURIComponent(last);
  } catch {
    return encodeURIComponent(value);
  }
}

/** Attribute of the root element of a small XML answer. */
function rootAttr(xml: string, root: string, name: string): string | undefined {

  const attributes = new RegExp(`<${root}\\b([^>]*)>`).exec(xml)?.[1];
  if (attributes === undefined) return undefined;
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
  return value === undefined ? undefined : decodeXmlEntities(value);
}

/** `<enh:source>` carries the enhancement code base64-encoded, wrapped every 76 characters. */
function decodeBase64(value: string): string {
  try {
    return Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  // Structure first, entities once at the end: decoding `&amp;` before `&lt;` turns a
  // single escape into markup, which is why this chain now lives in `adt/xml.ts`.
  return decodeXmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/h\d>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface DumpChapter {
  readonly name: string;
  readonly title: string;
  readonly category: string;
  readonly line: number;
}

/** Titles `chapters:["developer"]` expands to, in every language this stack serves. */
// SAP writes the short-dump chapters in the logon language, so the English, Chinese and
// German titles are matched alike.
const DEVELOPER_CHAPTERS = [
  /短文本|short text|kurztext/i,
  /发生了什么|what happened/i,
  /错误分析|error analysis|fehleranalyse/i,
  /异常对象链|chain of exception/i,
  /关于在何处终止|information on where terminated/i,
  /源代码提取|source code extract/i,
  /活动调用|active calls/i,
  /用户和事务|user and transaction/i,
] as const;

/** Pulls `adtcore:objectReference` elements out of a search / list answer. */
function objectReferences(xml: string): Array<Record<string, string | undefined>> {
  return [...xml.matchAll(/<adtcore:objectReference\b([^>]*)\/?>/g)].map((match) => {
    const attributes = match[1] ?? "";
    const read = (key: string): string | undefined => {
      const value = new RegExp(`\\b${key}="([^"]*)"`).exec(attributes)?.[1];
      return value === undefined ? undefined : decodeXmlEntities(value);
    };
    return {
      name: read("adtcore:name"),
      type: read("adtcore:type"),
      package_name: read("adtcore:packageName"),
      description: read("adtcore:description"),
      uri: read("adtcore:uri"),
    };
  });
}

interface UsageReference {
  readonly name: string;
  readonly type: string;
  readonly package_name: string;
  readonly uri: string;
  readonly parent_uri: string;
  readonly object_identifier?: string;
}

/** ADT resource segment per where-used object type. */
const WHERE_USED_PATHS: Readonly<Record<string, string>> = {
  class: "oo/classes",
  "clas/oc": "oo/classes",
  interface: "oo/interfaces",
  "intf/oi": "oo/interfaces",
  "intf/if": "oo/interfaces",
  program: "programs/programs",
  "prog/p": "programs/programs",
  include: "programs/includes",
  "prog/i": "programs/includes",
  functiongroup: "functions/groups",
  fugr: "functions/groups",
  "fugr/f": "functions/groups",
  package: "packages",
  "devc/k": "packages",
  table: "ddic/tables",
  "tabl/dt": "ddic/tables",
  structure: "ddic/structures",
  "tabl/ds": "ddic/structures",
  dataelement: "ddic/dataelements",
  "dtel/de": "ddic/dataelements",
  domain: "ddic/domains",
  "doma/dd": "ddic/domains",
  view: "ddic/ddl/sources",
  "ddls/df": "ddic/ddl/sources",
};

const WHERE_USED_ACCEPT = "application/vnd.sap.adt.repository.usagereferences.result.v1+xml";
const WHERE_USED_CT = "application/vnd.sap.adt.repository.usagereferences.request.v1+xml";
const WHERE_USED_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">' +
  "<usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>";
const USAGE_SNIPPETS_ACCEPT = "application/vnd.sap.adt.repository.usagesnippets.result.v1+xml";
const USAGE_SNIPPETS_CT = "application/vnd.sap.adt.repository.usagesnippets.request.v1+xml";

const escapeXmlText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const lower = (value: string): string => value.trim().toLowerCase();

/** nodestructure media types: a single bare `as+xml` Accept is the only one that answers. */
const NODE_ASX_ACCEPT = "application/vnd.sap.as+xml";
const NODE_ASX_CT = "application/vnd.sap.as+xml; charset=UTF-8; dataname=null";
const nodeAsxBody = (nodeId: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">' +
  `<asx:values><DATA><TV_NODEKEY>${escapeXmlText(nodeId)}</TV_NODEKEY></DATA></asx:values></asx:abap>`;

interface TreeNode {
  readonly type: string;
  readonly name: string;
  readonly tech_name: string;
  readonly uri: string;
  readonly expandable: boolean;
  readonly description?: string;
}

interface NodeType {
  readonly type: string;
  readonly label: string;
  readonly node_id: string;
}

interface NodeStructure {
  readonly nodes: readonly TreeNode[];
  readonly object_types: readonly NodeType[];
  readonly raw: string;
}

function xmlTag(block: string, name: string): string {
  const text = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1]?.trim() ?? "";
  return text.length === 0 ? "" : decodeXmlEntities(text);
}

/** Reads one nodestructure level and parses the ASX answer into nodes + type drill-down ids. */
async function readNodeStructure(
  session: Pick<AdtSession, "request">,
  parentType: string,
  parentName: string,
  nodeId: string,
  withShortDescriptions: boolean,
): Promise<NodeStructure> {
  const path =
    "/repository/nodestructure" +
    `?parent_type=${encodeURIComponent(parentType.trim())}` +
    `&parent_name=${encodeURIComponent(lower(parentName))}` +
    `&parent_tech_name=${encodeURIComponent(lower(parentName))}` +
    `&withShortDescriptions=${withShortDescriptions ? "true" : "false"}` +
    `&node_id=${encodeURIComponent(nodeId)}`;
  const response = await session.request({
    method: "POST",
    path,
    accept: NODE_ASX_ACCEPT,
    contentType: NODE_ASX_CT,
    body: nodeAsxBody(nodeId),
    timeoutMs: 120_000,
  });
  const xml = response.body;
  const nodes = [...xml.matchAll(/<SEU_ADT_REPOSITORY_OBJ_NODE>([\s\S]*?)<\/SEU_ADT_REPOSITORY_OBJ_NODE>/g)].map(
    (match) => {
      const block = match[1] ?? "";
      const description = xmlTag(block, "DESCRIPTION");
      return {
        type: xmlTag(block, "OBJECT_TYPE"),
        name: xmlTag(block, "OBJECT_NAME"),
        tech_name: xmlTag(block, "TECH_NAME"),
        uri: xmlTag(block, "OBJECT_URI"),
        expandable: xmlTag(block, "EXPANDABLE") === "X",
        ...(description.length === 0 ? {} : { description }),
      };
    },
  );
  const objectTypes = [...xml.matchAll(/<SEU_ADT_OBJECT_TYPE_INFO>([\s\S]*?)<\/SEU_ADT_OBJECT_TYPE_INFO>/g)].map(
    (match) => {
      const block = match[1] ?? "";
      return {
        type: xmlTag(block, "OBJECT_TYPE"),
        label: xmlTag(block, "OBJECT_TYPE_LABEL"),
        node_id: xmlTag(block, "NODE_ID"),
      };
    },
  );
  return { nodes, object_types: objectTypes, raw: xml };
}

function treeResult(
  structure: NodeStructure,
  enrich: boolean,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: true,
    count: structure.nodes.length,
    nodes: structure.nodes.map((node) =>
      enrich
        ? { ...node }
        : { type: node.type, name: node.name, tech_name: node.tech_name, expandable: node.expandable },
    ),
    object_types: structure.object_types,
    session_id: sessionId,
    ...extra,
  };
}

/** ADT resource URI for a where-used target, or `undefined` for an unknown type. */
function whereUsedUri(name: string, type: string | undefined): string | undefined {
  const segment = WHERE_USED_PATHS[(type ?? "").trim().toLowerCase()];
  if (segment === undefined) return undefined;
  // The endpoint wants the full repository URI; without `/sap/bc/adt` SAP answers
  // 500 "Error while converting object references".
  return `/sap/bc/adt/${segment}/${encodeURIComponent(name.trim().toLowerCase())}`;
}

function xmlAttrOf(source: string, key: string): string {
  const value = new RegExp(`\\b${key}="([^"]*)"`).exec(source)?.[1];
  return value === undefined ? "" : decodeXmlEntities(value);
}

function parseUsageReference(attributes: string, inner: string): UsageReference {
  const adtObject = /<usagereferences:adtObject\b([^>]*)>/.exec(inner)?.[1] ?? "";
  const packageRef = /<adtcore:packageRef\b([^>]*)>/.exec(inner)?.[1] ?? "";
  const identifier = /<objectIdentifier>([\s\S]*?)<\/objectIdentifier>/.exec(inner)?.[1]?.trim();
  return {
    name: xmlAttrOf(adtObject, "adtcore:name"),
    type: xmlAttrOf(adtObject, "adtcore:type"),
    package_name: xmlAttrOf(packageRef, "adtcore:name"),
    uri: xmlAttrOf(attributes, "uri"),
    parent_uri: xmlAttrOf(attributes, "parentUri"),
    ...(identifier === undefined || identifier.length === 0 ? {} : { object_identifier: identifier }),
  };
}

/** The Data Preview endpoint wraps the text as `SELECT ... INTO TABLE ... UP TO n ROWS`. */
export function precheckSqlQuery(sql: string): string {
  const trimmed = sql.trim();
  if (!/^SELECT\b/i.test(trimmed)) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      'GetSqlQuery only runs SELECT statements; the Data Preview endpoint wraps the text in "SELECT ... INTO TABLE".',
      { nextAction: "start the statement with SELECT; express a CTE as a subquery" },
    );
  }
  if (trimmed.includes(";")) {
    throw new GatewayError("INVALID_ARGUMENT", "GetSqlQuery accepts one statement; remove the semicolon.", {
      nextAction: "send one SELECT without a trailing semicolon",
    });
  }
  return trimmed;
}

/** A classified `GetSqlQuery` failure, or `undefined` for an unclassified error. */
export interface SqlQueryFailure {
  readonly code: "INVALID_ARGUMENT" | "UPSTREAM_FAILED";
  readonly nextAction: string;
}

/**
 * Turns the words SAP uses for Data Preview failures into a stable code and a hint.
 *
 * The old catch-all used the word `invalid`, which also matched the HTTP 500 text
 * `Invalid access with negative length to a string` and reported an ADT internal
 * error as if the caller's SQL were invalid. Unknown columns and one-character
 * language keys are caller errors; a 500 is not.
 */
export function classifySqlQueryFailure(message: string, status?: number): SqlQueryFailure | undefined {
  if (hasSignal(message, "temp-pool")) {
    return {
      code: "UPSTREAM_FAILED",
      nextAction:
        "the system ran out of temporary program space; wait for the pool to clear, reduce row_number, or use GetTableContentsLow for a direct table read",
    };
  }
  if ((status !== undefined && status >= 500) || hasSignal(message, "server-error")) {
    return {
      code: "UPSTREAM_FAILED",
      nextAction:
        "ADT Data Preview's SQL rewriter breaks on wide aggregate SELECTs (6 aggregate columns work; 10+ can return a spurious GROUP BY error or this 500). Simplify by splitting into at most 6 aggregates, select raw rows and aggregate in ABAP, or use GetTableContents for a direct table read",
    };
  }

  const column = /Unknown column name "([^"]+)"/i.exec(message)?.[1]?.toUpperCase();
  if (column !== undefined) {
    const hint =
      column === "AS4TEXT"
        ? "AS4TEXT is in E07T, not E070. Data Preview accepts one plain SELECT and rejects joins: read the E070 header and the E07T text in two queries, then merge by TRKORR (LANGU selects one language)"
        : column === "AS4USER" || column === "TRFUNCTION" || column === "TRSTATUS"
          ? `${column} belongs to E070; E07T has only TRKORR / LANGU / AS4TEXT. Read E070 and E07T separately and merge by TRKORR — this endpoint rejects joins`
          : column === "RBUKRS"
            ? "RBUKRS is a field of ACDOCA / FAGLFLEXT; T001 uses BUKRS"
            : `check ${column} against DD03L or the table's own field list`;
    return { code: "INVALID_ARGUMENT", nextAction: hint };
  }

  if (hasSignal(message, "single-select")) {
    return {
      code: "INVALID_ARGUMENT",
      nextAction:
        "ADT Data Preview accepts one plain SELECT and does not support JOIN; query each table separately and merge the rows in the caller",
    };
  }

  if (hasSignal(message, "language-key-width")) {
    return {
      code: "INVALID_ARGUMENT",
      nextAction: "SPRAS is a one-character language key; on this system use '1' for Chinese, not 'ZH'",
    };
  }
  if (hasSignal(message, "sql-syntax")) {
    return {
      code: "INVALID_ARGUMENT",
      nextAction:
        "use a plain SELECT with explicit columns; Data Preview rejects DESC, <> and NOT = — use ORDER BY ... DESCENDING, NE and NOT ( ... )",
    };
  }
  return undefined;
}

/**
 * Which includes belong to a program or function group.
 *
 * Two sources, in this order, because each one alone lies:
 *   - the repository tree, which is what SAP shows in SE80 — but is **buffered per logon**
 *     session, so right after `CreateInclude` + activation the same session still answers
 * the pre-create tree (measured );
 *   - `D010INC`, the table that decides membership at compile time — the honest fallback.
 *
 * `GetIncludesList` and `GetProgFullCode` both need this; one copy keeps them from
 * disagreeing about what "the program's includes" means.
 */
async function includeMembership(
  session: Pick<AdtSession, "request">,
  objectType: string,
  objectName: string,
): Promise<{ includes: string[]; source: "node_structure" | "d010inc" | "none"; nodes: NodeStructure["nodes"]; raw: string }> {
  const structure = await readNodeStructure(session, objectType, objectName, "000000", true);
  // Includes hang under the `PROG/I` type node, never directly under the root; without
  // this second step the tool answered an empty list for every program.
  let nodes = structure.nodes;
  const includeType = structure.object_types.find((entry) => /^PROG\/I$/i.test(entry.type));
  if (includeType !== undefined) {
    const deeper = await readNodeStructure(session, objectType, objectName, includeType.node_id, true);
    nodes = [...nodes, ...deeper.nodes];
  }
  let includes = nodes.filter((node) => /^PROG\/I$/i.test(node.type)).map((node) => node.name);
  let source: "node_structure" | "d010inc" | "none" = includes.length > 0 ? "node_structure" : "none";

  if (includes.length === 0) {
    const response = await session.request({
      method: "POST",
      path: "/datapreview/freestyle?rowNumber=500",
      accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
      contentType: "text/plain",
      body: `SELECT INCLUDE FROM D010INC WHERE MASTER = '${objectName.trim().toUpperCase()}'`,
      timeoutMs: 120_000,
    });
    const rows = parseDataPreview(response.body).rows.map((row) => String(row["INCLUDE"] ?? "").trim());
    // `<REPINI>`-style system includes and `DBD$SSEL` are the compiler's, not the
    // program's; the caller wants the ones somebody wrote.
    includes = rows.filter((entry) => entry.length > 0 && !/^[<$]/.test(entry));
    if (includes.length > 0) source = "d010inc";
  }
  return { includes, source, nodes, raw: structure.raw };
}

interface DumpFacts {
  readonly dump_id: string;
  readonly error: string;
  readonly exception: string;
  readonly title: string;
  readonly author: string;
  readonly terminated_program: string;
  readonly server_instance: string;
  readonly datetime: string;
  readonly system_date: string;
  readonly system_time: string;
  readonly language: string;
  readonly termination_uri: string;
}

interface DumpRead {
  readonly facts: DumpFacts;
  readonly chapters: readonly DumpChapter[];
  readonly text?: string;
}

/**
 * One dump, read once for every tool that shows it.
 *
 * `.../dump/<id>` (v1+xml) carries the facts and the chapter index; the flat
 * `/formatted` text carries neither. Keeping both reads here is what makes
 * `view` / `chapters` / `response_mode` mean the same thing in
 * `RuntimeAnalyzeDump`, `RuntimeGetDumpById` and `HandlerDumpView` — as fixed
 * routes they all answered the full `/formatted` long text (~166 KB measured)
 * whatever the caller asked for.
 */
async function readDump(
  session: AdtSession,
  id: string,
  view: string,
  filters: readonly string[],
): Promise<DumpRead> {
  const meta = await session.request({
    path: `/runtime/dump/${id}`,
    accept: "application/vnd.sap.adt.runtime.dump.v1+xml",
    timeoutMs: 120_000,
  });
  const attr = (name: string): string => rootAttr(meta.body, "dump:dump", name) ?? "";
  // Structural: the termination link was matched as `relation="…" … uri="…"`, so the
  // two attributes had to be written in that order for the URI to come out at all.
  const dumpDoc = parseXml(meta.body);
  const links = dumpDoc === undefined ? [] : findElements(dumpDoc, "link");
  const termination = links.find((link) => (attributeOf(link, "relation") ?? "").includes("/termination"));
  const facts: DumpFacts = {
    dump_id: id,
    error: attr("error"),
    exception: attr("exception"),
    title: attr("title"),
    author: attr("author"),
    terminated_program: attr("terminatedProgram"),
    server_instance: attr("serverInstance"),
    datetime: attr("datetime"),
    system_date: attr("systemDate"),
    system_time: attr("systemTime"),
    language: attr("language"),
    termination_uri: termination === undefined ? "" : (attributeOf(termination, "uri") ?? ""),
  };
  const chapters: readonly DumpChapter[] =
    dumpDoc === undefined
      ? []
      : findElements(dumpDoc, "chapter").map((chapter) => ({
          name: attributeOf(chapter, "name") ?? "",
          title: attributeOf(chapter, "title") ?? "",
          category: attributeOf(chapter, "category") ?? "",
          line: Number(attributeOf(chapter, "line") ?? 0),
        }));

  const wantsFormatted = view === "formatted" || filters.length > 0;
  if (wantsFormatted) {
    const formatted = await session.request({
      path: `/runtime/dump/${id}/formatted`,
      accept: "text/plain",
      timeoutMs: 120_000,
    });
    let text = formatted.body;
    if (filters.length > 0 && chapters.length > 0) {
      const ordered = [...chapters].sort((left, right) => left.line - right.line);
      const lines = text.split(/\r?\n/);
      const sections = ordered.map((chapter, index) => ({
        title: chapter.title,
        category: chapter.category,
        text: lines
          .slice(Math.max(0, chapter.line - 1), (ordered[index + 1]?.line ?? lines.length + 1) - 1)
          .join("\n")
          .trim(),
      }));
      const matches = (filter: string, section: { readonly title: string; readonly category: string }): boolean => {
        const needle = filter.toLowerCase();
        if (needle === "developer") {
          return DEVELOPER_CHAPTERS.some((pattern) => pattern.test(section.title));
        }
        return (
          section.title.toLowerCase().startsWith(needle) ||
          section.category.toLowerCase().startsWith(needle)
        );
      };
      const kept = sections.filter((section) => filters.some((filter) => matches(filter, section)));
      text = kept.map((section) => `===== ${section.title} =====\n${section.text}`).join("\n\n");
    }
    return { facts, chapters, text };
  }
  if (view === "summary") {
    const summary = await session.request({
      path: `/runtime/dump/${id}/summary`,
      accept: "text/html",
      timeoutMs: 120_000,
    });
    return { facts, chapters, text: stripHtml(summary.body) };
  }
  return { facts, chapters };
}

/** `chapters` argument → filter list, shared by every dump tool. */
function dumpFilters(args: Args): readonly string[] {
  return Array.isArray(args["chapters"])
    ? args["chapters"].map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    : [];
}

export function registerReadTools(registry: ToolRegistry, runtime: GatewayRuntime): void {
  if (registry.has("GetSqlQuery")) {
    registry.register("GetSqlQuery", async (args, ctx) => {
      const rawSql = str(args, "sql_query");
      if (rawSql === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "sql_query".');
      const sql = precheckSqlQuery(rawSql);
      const resolved = runtime.resolve(ctx.system, undefined, false);
      // Clamp: a preview is a preview. Very large row numbers also keep the temporary
      // subroutine pool busy on some releases, which answered "temporary subroutine
      // pools exhausted" after a run of preview calls.
      const rowNumber = Math.max(1, Math.min(Math.trunc(num(args, "row_number", 100)), 5000));

      let response: Awaited<ReturnType<AdtSession["request"]>>;
      try {
        response = await resolved.session.request({
          method: "POST",
          // Ask for one row more than the caller wants, so `truncated` means "there is
          // more" rather than "the answer happened to fill the page exactly".
          path: `/datapreview/freestyle?rowNumber=${rowNumber + 1}`,
          accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
          contentType: "text/plain",
          body: sql,
          timeoutMs: 120_000,
        });
      } catch (error) {
        const message = String((error as Error).message ?? error);
        const failure = classifySqlQueryFailure(message, error instanceof AdtError ? error.status : undefined);
        if (failure !== undefined) {
          throw new GatewayError(failure.code, `GetSqlQuery: ${message}`, { nextAction: failure.nextAction });
        }
        throw error;
      }

      const preview = parseDataPreview(response.body);
      const truncated = preview.rows.length > rowNumber;
      const rows = truncated ? preview.rows.slice(0, rowNumber) : preview.rows;
      return {
        success: true,
        row_count: rows.length,
        row_limit: rowNumber,
        truncated,
        columns: preview.columns,
        rows,
        ...(preview.executedQuery === undefined ? {} : { executed_query: preview.executedQuery }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetBadiImplementations")) {
    registry.register("GetBadiImplementations", async (args, ctx) => {
      const definition = str(args, "badi_definition")?.toUpperCase();
      if (definition === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "badi_definition".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const quote = (value: string): string => value.replace(/'/g, "''");
      const runSelect = async (sql: string, rowNumber: number): Promise<Array<Record<string, string>>> => {
        const response = await resolved.session.request({
          method: "POST",
          path: `/datapreview/freestyle?rowNumber=${rowNumber}`,
          accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
          contentType: "text/plain",
          body: sql,
          timeoutMs: 120_000,
        });
        return parseDataPreview(response.body).rows.map((row) => ({ ...row }));
      };

      // Classic BAdI: the definition is an SXS_ATTR row, its implementations are
      // SXC_EXIT rows (`EXIT_NAME` = definition, `IMP_NAME` = implementation).
      const exits = await runSelect(
        `SELECT IMP_NAME, FLT_VAL FROM SXC_EXIT WHERE EXIT_NAME = '${quote(definition)}'`,
        500,
      );
      // The implementation class is not in SXC_EXIT; resolve it through TADIR, which
      // registers the implementation object (OBJECT='SXCI') and its class (OBJECT='CLAS').
      const repository = await runSelect(
        `SELECT OBJECT, OBJ_NAME, DEVCLASS FROM TADIR WHERE OBJ_NAME LIKE '%${quote(definition)}'`,
        2000,
      );
      const classes = new Set<string>();
      const implPackages = new Map<string, string>();
      for (const row of repository) {
        const object = (row["OBJECT"] ?? "").toUpperCase();
        const name = (row["OBJ_NAME"] ?? "").trim().toUpperCase();
        if (name.length === 0) continue;
        if (object === "CLAS") classes.add(name);
        if (object === "SXCI") implPackages.set(name, (row["DEVCLASS"] ?? "").trim());
      }
      const customerOnly = args["customer_only"] !== false;
      const implementations = exits
        .map((row) => {
          const implementation = (row["IMP_NAME"] ?? "").trim().toUpperCase();
          const packageName = implPackages.get(implementation) ?? "";
          // SE19 names the class after the implementation, most often with a leading
          // `Z` dropped (`ZDEMO_BADI` -> `ZCL_IM_DEMO_BADI`).
          const candidates = [
            implementation,
            `ZCL_IM_${implementation}`,
            `ZCL_IM_${implementation.replace(/^Z(?=\w)/, "")}`,
            `CL_EX_${implementation}`,
          ];
          let className = candidates.find((candidate) => classes.has(candidate)) ?? null;
          // Only when the definition has a single implementation is `ZCL_IM_<BAdI>`
          // unambiguous; with several it would label every row with one class.
          if (className === null && exits.length === 1 && classes.has(`ZCL_IM_${definition}`)) {
            className = `ZCL_IM_${definition}`;
          }
          return {
            implementation,
            filter_value: (row["FLT_VAL"] ?? "").trim(),
            package_name: packageName,
            class_name: className,
          };
        })
        .filter((entry) => entry.implementation.length > 0)
        .filter((entry) =>
          customerOnly
            ? /^[ZY]/.test(entry.implementation) || /^[ZY$]/.test(entry.package_name)
            : true,
        );

      return {
        success: true,
        badi_definition: definition,
        kind: implementations.length > 0 ? "classic" : "unknown",
        count: implementations.length,
        implementations,
        note:
          "Classic BAdI only (SXC_EXIT). `active_only` is not judgeable from SXC_EXIT — check `class_name` " +
          "with GetClass, or the ENHO object in SE19. Kernel BAdIs never appear here.",
        session_id: resolved.sessionId,
      };
    });
  }

  // `GetEnhancements` / `GetEnhancementSpot` were fixed routes: they handed over the raw ADT
  // document, in which `<enh:source>` is **base64** and the enhanced object is a sibling element.
  // Measured on SAPMV45A: four implementations, each one source-code plugin.
  if (registry.has("GetEnhancements")) {
    registry.register("GetEnhancements", async (args, ctx) => {
      const objectName = str(args, "object_name");
      const objectType = str(args, "object_type");
      if (objectName === undefined || objectType === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "object_name" / "object_type".');
      }
      const base = whereUsedUri(objectName, objectType);
      if (base === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", `Unsupported object type "${objectType}" for enhancements.`);
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const response = await resolved.session.request({
        path: `${base.replace(/^\/sap\/bc\/adt/, "")}/source/main/enhancements/elements`,
        // The list is v3 on current releases and v1 on older ones; `application/xml` is the last
        // fallback the route used before it was replaced by this implementation.
        accept:
          "application/vnd.sap.adt.enhancements.v3+xml, application/vnd.sap.adt.enhancements.v1+xml, application/xml",
        timeoutMs: 120_000,
      });
      const doc = parseXml(response.body);
      const implementations =
        doc === undefined
          ? []
          : findElements(doc, "enhancementImplementations").map((node) => {
              const enhanced = findElements(node, "enhancedObject")[0];
              const switchRef = findElements(node, "ref")[0];
              const switchNode = findElements(node, "switch")[0];
              const elements = findElements(node, "sourceCodePlugin").map((plugin) => {
                const position = findElements(plugin, "position")[0];
                // Two positions travel with one plugin: the `enh:uri` of the plugin is the line
                // inside the enhancement source, the `<enh:position>` is where it sits in the
                // enhanced object (measured: `#start=1,0` vs `#start=89,0`).
                const own = /start=(\d+),(\d+)/.exec(attributeOf(plugin, "uri") ?? "");
                const at = /start=(\d+),(\d+)/.exec(
                  (position === undefined ? undefined : attributeOf(position, "uri")) ?? "",
                );
                const sourceText = childTextOf(plugin, "source") ?? "";
                const decoded = sourceText.length === 0 ? "" : decodeBase64(sourceText);
                return {
                  id: (attributeOf(plugin, "id") ?? "").trim(),
                  full_name: attributeOf(plugin, "full_name") ?? "",
                  mode: attributeOf(plugin, "mode") ?? "",
                  replacing: (attributeOf(plugin, "replacing") ?? "") === "true",
                  ...(own === null ? {} : { row: Number(own[1]), column: Number(own[2]) }),
                  ...(at === null ? {} : { object_row: Number(at[1]), object_column: Number(at[2]) }),
                  source_chars: decoded.length,
                  first_line: decoded.split(/\r?\n/)[0] ?? "",
                };
              });
              return {
                name: attributeOf(node, "name") ?? "",
                type: attributeOf(node, "type") ?? "",
                version: attributeOf(node, "version") ?? "",
                ...(enhanced === undefined
                  ? {}
                  : {
                      enhanced_object: {
                        name: attributeOf(enhanced, "name") ?? "",
                        type: attributeOf(enhanced, "type") ?? "",
                        uri: attributeOf(enhanced, "uri") ?? "",
                      },
                    }),
                ...(switchNode === undefined
                  ? {}
                  : {
                      switch: {
                        state: attributeOf(switchNode, "state") ?? "",
                        ...(switchRef === undefined
                          ? {}
                          : { name: attributeOf(switchRef, "name") ?? "", type: attributeOf(switchRef, "type") ?? "" }),
                      },
                    }),
                element_count: elements.length,
                elements,
              };
            });
      return {
        success: true,
        object: { name: objectName.toUpperCase(), type: objectType.toUpperCase() },
        count: implementations.length,
        enhancements: implementations,
        ...(implementations.length === 0
          ? { note: "SAP answered an empty <enh:enhancements/>: this object carries no enhancement." }
          : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetEnhancementSpot")) {
    registry.register("GetEnhancementSpot", async (args, ctx) => {
      const spot = str(args, "enhancement_spot");
      if (spot === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "enhancement_spot".');
      const resolved = runtime.resolve(ctx.system, undefined, false);
      // Discovery lists both collections: `enhsxs` (Enhancement Spot) and `enhsxsb` (BAdI Enhancement
      // Spot). The BAdI one is asked first because a BAdI spot carries the definitions this tool is
      // about; `enhsxs` answers for the rest.
      const body = await (async (): Promise<string> => {
        try {
          return (
            await resolved.session.request({
              path: `/enhancements/enhsxsb/${encodeURIComponent(spot.toLowerCase())}`,
              accept: "application/vnd.sap.adt.enh.enhs.v2+xml",
              timeoutMs: 120_000,
            })
          ).body;
        } catch (error) {
          if (!(error instanceof AdtError) || error.status !== 404) throw error;
          return (
            await resolved.session.request({
              path: `/enhancements/enhsxs/${encodeURIComponent(spot.toLowerCase())}`,
              accept: "application/vnd.sap.adt.enh.enhs.v1+xml",
              timeoutMs: 120_000,
            })
          ).body;
        }
      })();
      const attrs = /<enhs:objectData\b([^>]*)>/.exec(body)?.[1] ?? "";
      const packageName = /<adtcore:packageRef\b([^>]*)>/.exec(body)?.[1] ?? "";
      const toolType = /<enhs:contentCommon\b[^>]*enhs:toolType="([^"]*)"/.exec(body)?.[1] ?? "";
      const usages = [...body.matchAll(/<enhcore:referencedObject\b([^>]*)>([\s\S]*?)<\/enhcore:referencedObject>/g)].map(
        (match) => {
          const reference = /<enhcore:objectReference\b([^>]*)\/?>/.exec(match[2] ?? "")?.[1] ?? "";
          return {
            usage: xmlAttrOf(match[1] ?? "", "enhcore:element_usage"),
            name: xmlAttrOf(reference, "adtcore:name"),
            type: xmlAttrOf(reference, "adtcore:type"),
            uri: xmlAttrOf(reference, "adtcore:uri"),
          };
        },
      );
      const badiDefinitions = [...body.matchAll(/<enhs:badiDefinition\b([^>]*)>([\s\S]*?)<\/enhs:badiDefinition>/g)].map(
        (match) => {
          const definition = match[1] ?? "";
          const iface = /<enhs:interface\b([^>]*)\/?>/.exec(match[2] ?? "")?.[1] ?? "";
          return {
            name: xmlAttrOf(definition, "enhs:name"),
            shorttext: xmlAttrOf(definition, "enhs:shorttext"),
            single_use: xmlAttrOf(definition, "enhs:singleUse") === "true",
            fallback_class: xmlAttrOf(definition, "enhs:useFallbackClass") === "true",
            interface: xmlAttrOf(iface, "adtcore:name"),
            interface_type: xmlAttrOf(iface, "adtcore:type"),
          };
        },
      );
      return {
        success: true,
        enhancement_spot: spot.toUpperCase(),
        name: xmlAttrOf(attrs, "adtcore:name"),
        type: xmlAttrOf(attrs, "adtcore:type"),
        description: xmlAttrOf(attrs, "adtcore:description"),
        responsible: xmlAttrOf(attrs, "adtcore:responsible"),
        version: xmlAttrOf(attrs, "adtcore:version"),
        package_name: xmlAttrOf(packageName, "adtcore:name"),
        tool_type: toolType,
        usage_count: usages.length,
        usages,
        badi_definition_count: badiDefinitions.length,
        badi_definitions: badiDefinitions,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("RuntimeListDumps")) {
    registry.register("RuntimeListDumps", async (args, ctx) => {
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const top = num(args, "top", num(args, "max_results", 50));
      const skip = num(args, "skip", 0);
      const query = new URLSearchParams();
      query.set("$top", String(top));
      if (skip > 0) query.set("$skip", String(skip));
      const orderby = str(args, "orderby");
      if (orderby !== undefined) query.set("$orderby", orderby);
      const user = str(args, "user");
      if (user !== undefined) query.set("$filter", `user eq '${user.replace(/'/g, "''")}'`);
      if (str(args, "inlinecount") === "allpages") query.set("$inlinecount", "allpages");

      const path = `/runtime/dumps?${query.toString()}`;
      const response = await resolved.session.request({
        path,
        accept: "application/atom+xml;type=feed",
        timeoutMs: 120_000,
      });
      const includeSummary = args["include_summary"] === true;
      // Structural read of the Atom feed: `<atom:category term="…" label="…">` and the
      // self link used to be matched in one fixed attribute order, so a release writing
      // `label` first silently emptied `error` and `program`.
      const feed = parseXml(response.body);
      const entries = feed === undefined ? [] : findElements(feed, "entry");
      const dumps = entries.map((entry) => {
        const categories = findElements(entry, "category").map((category) => ({
          term: attributeOf(category, "term") ?? "",
          label: attributeOf(category, "label") ?? "",
        }));
        const dumpHref = findElements(entry, "link")
          .map((link) => attributeOf(link, "href") ?? "")
          .find((href) => href.includes("/runtime/dump/"));
        const dumpId =
          dumpHref === undefined ? childTextOf(entry, "id") : dumpHref.split("/runtime/dump/").pop();
        const who = childTextOf(entry, "name");
        const published = childTextOf(entry, "published");
        const summary = childTextOf(entry, "summary");
        return {
          ...(dumpId === undefined || dumpId.length === 0 ? {} : { dump_id: dumpId }),
          error: categories.find((category) => /runtime error/i.test(category.label))?.term ?? "",
          program:
            categories.find((category) => !/runtime error/i.test(category.label) && /program/i.test(category.label))
              ?.term ?? "",
          ...(who === undefined ? {} : { user: who }),
          ...(published === undefined ? {} : { published }),
          ...(includeSummary && summary !== undefined ? { summary } : {}),
        };
      });
      return {
        success: true,
        path,
        status: response.status,
        count: dumps.length,
        truncated: dumps.length >= top,
        dumps,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("RuntimeAnalyzeDump")) {
    registry.register("RuntimeAnalyzeDump", async (args, ctx) => {
      const requested = str(args, "dump_id");
      if (requested === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "dump_id".');
      }
      const id = opaqueId(requested);
      const view = (str(args, "view") ?? "default").toLowerCase();
      const includePayload = args["include_payload"] !== false;
      const filters = dumpFilters(args);

      const resolved = runtime.resolve(ctx.system, undefined, false);
      const dump = await readDump(resolved.session, id, view, filters);
      const wantsFormatted = view === "formatted" || filters.length > 0;

      return {
        success: true,
        dump_id: id,
        view: wantsFormatted ? "formatted" : view,
        facts: dump.facts,
        ...(includePayload && !wantsFormatted && view !== "summary" ? { chapters: dump.chapters } : {}),
        ...(dump.text === undefined ? {} : { text: dump.text, text_length: dump.text.length }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("RuntimeGetDumpById")) {
    registry.register("RuntimeGetDumpById", async (args, ctx) => {
      const requested = str(args, "dump_id");
      if (requested === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "dump_id".');
      }
      const id = opaqueId(requested);
      const view = (str(args, "view") ?? "default").toLowerCase();
      const mode = (str(args, "response_mode") ?? "payload").toLowerCase();
      const filters = dumpFilters(args);

      const resolved = runtime.resolve(ctx.system, undefined, false);
      const dump = await readDump(resolved.session, id, view, filters);
      const wantsFormatted = view === "formatted" || filters.length > 0;
      const keyFacts = {
        title: dump.facts.title,
        error: dump.facts.error,
        exception: dump.facts.exception,
        program: dump.facts.terminated_program,
        termination_uri: dump.facts.termination_uri,
        user: dump.facts.author,
        datetime: dump.facts.datetime,
      };
      // `payload` is the metadata + chapter index view (~7 KB); `summary` is the key
      // facts alone; `both` adds the summary in front of the payload.
      const withPayload = mode !== "summary";
      const withSummary = mode !== "payload";

      return {
        success: true,
        dump_id: id,
        view: wantsFormatted ? "formatted" : view,
        response_mode: mode,
        ...(withSummary ? { summary: keyFacts } : {}),
        ...(withPayload ? { facts: dump.facts, chapters: dump.chapters } : {}),
        ...(dump.text === undefined ? {} : { text: dump.text, text_length: dump.text.length }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("HandlerDumpView")) {
    // The legacy `Handler*` name carries only `dump_id` + `view`, and answers the same
    // shape as `RuntimeAnalyzeDump` so a caller can switch names without relearning it.
    registry.register("HandlerDumpView", async (args, ctx) => {
      const requested = str(args, "dump_id");
      if (requested === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "dump_id".');
      }
      const id = opaqueId(requested);
      const view = (str(args, "view") ?? "default").toLowerCase();
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const dump = await readDump(resolved.session, id, view, []);
      return {
        success: true,
        dump_id: id,
        view,
        facts: dump.facts,
        ...(view === "default" ? { chapters: dump.chapters } : {}),
        ...(dump.text === undefined ? {} : { text: dump.text, text_length: dump.text.length }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetTypeInfo")) {
    registry.register("GetTypeInfo", async (args, ctx) => {
      const name = str(args, "type_name");
      if (name === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "type_name".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const lowerName = name.toLowerCase();
      try {
        const response = await resolved.session.request({
          path: `/ddic/dataelements/${encodeURIComponent(lowerName)}`,
          accept: "application/vnd.sap.adt.dataelements.v2+xml",
          timeoutMs: 120_000,
        });
        const root = /<blue:wbobj\b([^>]*)>/.exec(response.body)?.[1] ?? "";
        const packageRef = /<adtcore:packageRef\b([^>]*)>/.exec(response.body)?.[1] ?? "";
        const tag = (element: string): string =>
          new RegExp(`<dtel:${element}>([\\s\\S]*?)</dtel:${element}>`).exec(response.body)?.[1]?.trim() ?? "";
        const number = (element: string): number => Number(tag(element) || 0);
        return {
          success: true,
          kind: "data_element",
          name,
          description: xmlAttrOf(root, "adtcore:description"),
          package_name: xmlAttrOf(packageRef, "adtcore:name"),
          responsible: xmlAttrOf(root, "adtcore:responsible"),
          type_kind: tag("typeKind"),
          type_name: tag("typeName"),
          data_type: tag("dataType"),
          length: number("dataTypeLength"),
          decimals: number("dataTypeDecimals"),
          labels: {
            short: tag("shortFieldLabel"),
            medium: tag("mediumFieldLabel"),
            long: tag("longFieldLabel"),
            heading: tag("headingFieldLabel"),
          },
          session_id: resolved.sessionId,
        };
      } catch (error) {
        if (args["include_structure_fallback"] === false) throw error;
        // Measured: for `BAPIRET2` (a structure) this branch answered
        // `{kind: "structure", count: 0, fields: [], raw_xml}` — the structures endpoint returns
        // the object header with a `sourceUri`, no `<field>` elements, so the "field definitions"
        // the tool promises were never there. DD03L is where they are.
        const upper = name.trim().toUpperCase();
        const readRows = async (sql: string): Promise<Array<Record<string, string>>> => {
          try {
            const response = await resolved.session.request({
              method: "POST",
              path: "/datapreview/freestyle?rowNumber=1000",
              accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
              contentType: "text/plain",
              body: sql,
              timeoutMs: 120_000,
            });
            return parseDataPreview(response.body).rows as Array<Record<string, string>>;
          } catch {
            return [];
          }
        };

        // A domain answers its own header: type, length and fixed values.
        const domain = await resolved.session
          .requestAcceptingAny({
            path: `/ddic/domains/${encodeURIComponent(lowerName)}`,
            accept: "application/vnd.sap.adt.domains.v2+xml",
          })
          .catch(() => undefined);
        if (domain !== undefined) {
          // Measured on a `$TMP` probe domain: the document is `<doma:domain …>` with
          // `adtcore:description` on the root, `<doma:datatype>` (lower-case `t`), the length twice
          // (`typeInformation` and `outputInformation`) and the fixed values as
          // `<doma:fixValue><doma:low>A</doma:low><doma:text>Alpha</doma:text></doma:fixValue>`.
          const tag = (element: string): string =>
            new RegExp(`<doma:${element}>([\\s\\S]*?)</doma:${element}>`, "i").exec(domain.body)?.[1]?.trim() ?? "";
          const rootAttributes = /<([A-Za-z_][\w:.-]*)\b([^>]*)>/.exec(domain.body.replace(/<\?xml[^>]*\?>/, ""))?.[2] ?? "";
          const fromXml = [...domain.body.matchAll(/<doma:fixValue>([\s\S]*?)<\/doma:fixValue>/gi)].map((match) => {
            const block = match[1] ?? "";
            const field = (name: string): string =>
              new RegExp(`<doma:${name}>([\\s\\S]*?)</doma:${name}>`, "i").exec(block)?.[1]?.trim() ?? "";
            return { low: field("low"), ...(field("high") === "" ? {} : { high: field("high") }), text: field("text") };
          });
          // `DD07L` is the fallback when the document carries no value range.
          const fixed = fromXml.length > 0
            ? fromXml
            : (
                await readRows(
                  `SELECT DOMVALUE_L FROM DD07L WHERE DOMNAME = '${upper}' AND AS4LOCAL = 'A' ORDER BY DOMVALUE_L`,
                )
              ).map((row) => ({ low: String(row["DOMVALUE_L"] ?? "").trim(), text: "" }));
          const conversionExit = tag("conversionExit");
          const valueTable = /<doma:valueTableRef\b[^>]*adtcore:name="([^"]*)"/i.exec(domain.body)?.[1] ?? "";
          return {
            success: true,
            kind: "domain",
            name: upper,
            description: xmlAttrOf(rootAttributes, "adtcore:description"),
            data_type: tag("datatype"),
            length: Number(tag("length") || 0),
            decimals: Number(tag("decimals") || 0),
            lowercase: tag("lowercase") === "true",
            sign_exists: tag("signExists") === "true",
            ...(conversionExit === "" ? {} : { conversion_exit: conversionExit }),
            ...(valueTable === "" ? {} : { value_table: valueTable }),
            ...(fixed.length === 0 ? {} : { fixed_values: fixed }),
            session_id: resolved.sessionId,
          };
        }

        // A table type has no structure resource at all (measured: `BAPIRET2_T`
        // answered 404 from `/ddic/structures/`), so a missing answer here must not abort the
        // chain — the table type is found in DD40L below.
        const structure = await resolved.session
          .requestAcceptingAny({
            path: `/ddic/structures/${encodeURIComponent(lowerName)}`,
            accept: "application/vnd.sap.adt.structures.v2+xml",
          })
          .catch(() => undefined);
        const structureBody = structure?.body ?? "";
        const rootTag = /<([A-Za-z_][\w:.-]*)\b([^>]*)>/.exec(structureBody.replace(/<\?xml[^>]*\?>/, ""));
        const root = rootTag?.[2] ?? "";
        const fromXml = [...structureBody.matchAll(/<(?:\w+:)?field\b([^>]*?)\/?>/g)].map((match) => {
          const attributes = match[1] ?? "";
          return {
            name: xmlAttrOf(attributes, "adtcore:name") || xmlAttrOf(attributes, "name"),
            type: xmlAttrOf(attributes, "type") || xmlAttrOf(attributes, "adtcore:type"),
            length: Number(xmlAttrOf(attributes, "length") || 0),
            decimals: Number(xmlAttrOf(attributes, "decimals") || 0),
            key: xmlAttrOf(attributes, "key") === "true",
          };
        });
        const adtType = xmlAttrOf(root, "adtcore:type");
        const fromTable = fromXml.length > 0
          ? []
          : (
              await readRows(
                `SELECT FIELDNAME, POSITION, KEYFLAG, ROLLNAME, DATATYPE, LENG, DECIMALS FROM DD03L ` +
                  `WHERE TABNAME = '${upper}' AND AS4LOCAL = 'A'`,
              )
            ).map((row) => ({
              name: String(row["FIELDNAME"] ?? "").trim(),
              position: String(row["POSITION"] ?? "").trim(),
              data_element: String(row["ROLLNAME"] ?? "").trim(),
              type: String(row["DATATYPE"] ?? "").trim(),
              length: Number(row["LENG"] ?? 0),
              decimals: Number(row["DECIMALS"] ?? 0),
              key: String(row["KEYFLAG"] ?? "").trim().length > 0,
            }));
        if (fromXml.length > 0 || fromTable.length > 0) {
          const fields = fromXml.length > 0 ? fromXml : fromTable;
          const sourceUri = xmlAttrOf(root, "abapsource:sourceUri");
          // `TABL/DS` is what the structures endpoint says for a transparent table too, so the
          // structure-vs-table question is answered by DD02L (`INTTAB` = structure).
          const tableClass = String(
            (await readRows(`SELECT TABNAME, TABCLASS FROM DD02L WHERE TABNAME = '${upper}' AND AS4LOCAL = 'A'`))[0]?.[
              "TABCLASS"
            ] ?? "",
          )
            .trim()
            .toUpperCase();
          const kind =
            tableClass === ""
              ? /TABL\/DT/i.test(adtType)
                ? "table"
                : "structure"
              : tableClass === "INTTAB"
                ? "structure"
                : "table";
          return {
            success: true,
            kind,
            name: upper,
            description: xmlAttrOf(root, "adtcore:description"),
            ...(tableClass === "" ? {} : { table_class: tableClass }),
            ...(sourceUri.length === 0 ? {} : { source_uri: sourceUri }),
            count: fields.length,
            fields,
            session_id: resolved.sessionId,
          };
        }

        // Last stop: a table type names its row type instead of carrying fields.
        const tableType = await readRows(
          `SELECT TYPENAME, ROWTYPE, DATATYPE, LENG, DECIMALS FROM DD40L WHERE TYPENAME = '${upper}'`,
        );
        const row = tableType[0];
        if (row !== undefined) {
          return {
            success: true,
            kind: "table_type",
            name: upper,
            row_type: String(row["ROWTYPE"] ?? "").trim(),
            row_kind: String(row["DATATYPE"] ?? "").trim(),
            length: Number(row["LENG"] ?? 0),
            decimals: Number(row["DECIMALS"] ?? 0),
            session_id: resolved.sessionId,
          };
        }
        return {
          success: true,
          kind: "unknown",
          name: upper,
          description: xmlAttrOf(root, "adtcore:description"),
          count: 0,
          fields: [],
          detail: "no data element, domain, structure, table or table type of this name was found",
          session_id: resolved.sessionId,
        };
      }
    });
  }

  if (registry.has("GetVirtualFoldersLow")) {
    registry.register("GetVirtualFoldersLow", async (args, ctx) => {
      const pattern = str(args, "object_search_pattern") ?? "*";
      const facetOrder = Array.isArray(args["facet_order"]) && args["facet_order"].length > 0
        ? args["facet_order"].map((entry) => String(entry))
        : ["package", "type"];
      const preselection = Array.isArray(args["preselection"]) ? args["preselection"] : [];
      const preselectionValues = preselection
        .flatMap((entry) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          return Array.isArray(record["values"]) ? record["values"].map((value) => String(value).toLowerCase()) : [];
        })
        .filter((value) => value.length > 0);
      // Measured: this stack's request schema has `facetorder` only — any
      // `preselection` child answers HTTP 400 ("expected the end of virtualFoldersRequest"),
      // so the selection is applied to the answer here instead.
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<vfs:virtualFoldersRequest xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders"' +
        ` objectSearchPattern="${escapeXmlText(pattern)}">` +
        "<vfs:facetorder>" +
        facetOrder.map((facet) => `<vfs:facet>${escapeXmlText(facet)}</vfs:facet>`).join("") +
        "</vfs:facetorder></vfs:virtualFoldersRequest>";

      const resolved = runtime.resolve(ctx.system, undefined, false);
      const response = await resolved.session.request({
        method: "POST",
        path: "/repository/informationsystem/virtualfolders/contents",
        accept: "application/vnd.sap.adt.repository.virtualfolders.result.v1+xml",
        contentType: "application/vnd.sap.adt.repository.virtualfolders.request.v1+xml",
        body,
        timeoutMs: 120_000,
      });
      const parsed = [...response.body.matchAll(/<vfs:virtualFolder\b([^>]*?)\/?>/g)].map((match) => {
        const attributes = match[1] ?? "";
        return {
          name: xmlAttrOf(attributes, "name"),
          display_name: xmlAttrOf(attributes, "displayName"),
          facet: xmlAttrOf(attributes, "facet"),
          uri: xmlAttrOf(attributes, "uri"),
          counter: xmlAttrOf(attributes, "counter"),
          text: xmlAttrOf(attributes, "text"),
          has_children: xmlAttrOf(attributes, "hasChildrenOfSameFacet") === "true",
        };
      });
      const selected = parsed;
      return {
        success: true,
        object_search_pattern: pattern,
        facet_order: facetOrder,
        ...(preselectionValues.length === 0
          ? {}
          : {
              preselection_ignored: preselectionValues,
              preselection_note:
                "this stack's request schema has no preselection element (HTTP 400), and the answer is paged, " +
                "so filtering it here would hide folders beyond the first page. Narrow `object_search_pattern` instead.",
            }),
        object_count: Number(xmlAttrOf(response.body, "objectCount") || 0),
        count: selected.length,
        folders: args["ignore_short_descriptions"] === true
          ? selected.map((folder) => ({ ...folder, text: undefined }))
          : selected,
        ...(args["with_versions"] === true ? { with_versions: true } : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("DescribeByList")) {
    registry.register("DescribeByList", async (args, ctx) => {
      const raw = Array.isArray(args["objects"]) ? args["objects"] : [];
      const entries = raw
        .map((entry) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          return {
            name: typeof record["name"] === "string" ? record["name"].trim() : "",
            type: typeof record["type"] === "string" ? record["type"].trim() : undefined,
          };
        })
        .filter((entry) => entry.name.length > 0);
      if (entries.length === 0) {
        const single = str(args, "name");
        if (single === undefined) {
          throw new GatewayError("INVALID_ARGUMENT", 'Pass "objects" (an array of {name, type}) or "name".');
        }
        entries.push({ name: single, type: str(args, "object_type") ?? str(args, "type") });
      }

      const resolved = runtime.resolve(ctx.system, undefined, false);
      const perSearch = num(args, "max_results", 5);
      const objects: Array<Record<string, string | undefined>> = [];
      const missing: string[] = [];
      for (const entry of entries) {
        const response = await resolved.session.requestAcceptingAny({
          path:
            "/repository/informationsystem/search?operation=quickSearch" +
            `&query=${encodeURIComponent(entry.name)}&maxResults=${perSearch}` +
            (entry.type === undefined ? "" : `&objectType=${encodeURIComponent(entry.type)}`),
          accept: "application/xml",
        });
        const found = objectReferences(response.body);
        const exact = found.find(
          (item) => (item["name"] ?? "").toUpperCase() === entry.name.toUpperCase(),
        );
        const hit = exact ?? found[0];
        if (hit === undefined) missing.push(entry.name);
        else objects.push(hit);
      }
      return {
        success: missing.length === 0,
        count: objects.length,
        objects,
        ...(missing.length === 0 ? {} : { missing }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetObjectInfo")) {
    registry.register("GetObjectInfo", async (args, ctx) => {
      const parentType = str(args, "parent_type");
      const parentName = str(args, "parent_name");
      if (parentType === undefined || parentName === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "parent_type" / "parent_name".');
      }
      const maxDepth = num(args, "maxDepth", 1);
      const enrich = args["enrich"] !== false;
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const structure = await readNodeStructure(resolved.session, parentType, parentName, "000000", enrich);
      return treeResult(structure, enrich, resolved.sessionId, {
        root: { type: parentType.toUpperCase(), name: parentName.toUpperCase() },
        max_depth_requested: maxDepth,
        // The ADT nodes on this stack carry no child node id, so one level is all that
        // exists; the object type ids below are the way down.
        depth_reached: 1,
        ...(structure.object_types.length === 0
          ? {}
          : { expand_hint: "pass object_types[].node_id to GetObjectsByType with the same parent" }),
      });
    });
  }

  for (const packageTool of ["GetPackageContents", "GetPackageTree"] as const) {
    if (!registry.has(packageTool)) continue;
    registry.register(packageTool, async (args, ctx) => {
      const packageName = str(args, "package_name");
      if (packageName === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "package_name".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const structure = await readNodeStructure(resolved.session, "DEVC/K", packageName, "000000", true);
      return treeResult(structure, true, resolved.sessionId, {
        package_name: packageName.toUpperCase(),
        ...(packageTool === "GetPackageTree" ? { tree: structure.nodes } : {}),
      });
    });
  }

  if (registry.has("GetObjectsByType")) {
    registry.register("GetObjectsByType", async (args, ctx) => {
      const parentType = str(args, "parent_type");
      const parentName = str(args, "parent_name");
      const nodeId = str(args, "node_id");
      if (parentType === undefined || parentName === undefined || nodeId === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "parent_type" / "parent_name" / "node_id".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const structure = await readNodeStructure(resolved.session, parentType, parentName, nodeId, true);
      return treeResult(structure, true, resolved.sessionId, {
        parent: { type: parentType.toUpperCase(), name: parentName.toUpperCase(), node_id: nodeId },
      });
    });
  }

  if (registry.has("GetObjectsList")) {
    registry.register("GetObjectsList", async (args, ctx) => {
      const parentType = str(args, "parent_type");
      const parentName = str(args, "parent_name");
      if (parentType === undefined || parentName === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "parent_type" / "parent_name".');
      }
      const withShort = args["with_short_descriptions"] !== false;
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const structure = await readNodeStructure(resolved.session, parentType, parentName, "000000", withShort);
      return treeResult(structure, withShort, resolved.sessionId, {
        parent: { type: parentType.toUpperCase(), name: parentName.toUpperCase() },
      });
    });
  }

  for (const structureTool of ["GetObjectStructure", "GetObjectStructureLow"] as const) {
    if (!registry.has(structureTool)) continue;
    registry.register(structureTool, async (args, ctx) => {
      // The contract spells these `object_type` / `object_name`; an older tool in the
      // same family spells them `objecttype` / `objectname`. Both are accepted — measured
      //, `GetObjectStructureLow` answered `Missing "objecttype"` for the
      // documented arguments.
      const objectType = str(args, "object_type") ?? str(args, "objecttype");
      const objectName = str(args, "object_name") ?? str(args, "objectname");
      if (objectType === undefined || objectName === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "object_type" / "object_name".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const structure = await readNodeStructure(resolved.session, objectType, objectName, "000000", true);
      // The root node carries only the category list (measured on DS4/100: `TREE_CONTENT`
      // empty for `CLAS/OC CL_SALV_TABLE` and `PROG/P ZTEST_WTX3`); the members hang under the
      // category `NODE_ID`s, so a tool documented as "compact JSON tree" has to expand them.
      const maxNodes = 500;
      const nodes: Array<Record<string, unknown>> = [];
      let truncated = false;
      const objectTypes: Array<{ type: string; label: string; node_id: string; count: number }> = [];
      for (const category of structure.object_types) {
        const before = nodes.length;
        if (category.node_id.length > 0 && nodes.length < maxNodes) {
          const deeper = await readNodeStructure(
            resolved.session,
            objectType,
            objectName,
            category.node_id,
            true,
          );
          for (const node of deeper.nodes) {
            if (nodes.length >= maxNodes) {
              truncated = true;
              break;
            }
            nodes.push({ ...node, category: category.label, category_type: category.type });
          }
        }
        objectTypes.push({ ...category, count: nodes.length - before });
      }
      return {
        success: true,
        object: { type: objectType.toUpperCase(), name: objectName.toUpperCase() },
        count: nodes.length,
        truncated,
        object_types: objectTypes,
        nodes,
        session_id: resolved.sessionId,
        ...(structureTool === "GetObjectStructureLow" ? { raw_xml: structure.raw } : {}),
      };
    });
  }

  if (registry.has("GetNodeStructureLow")) {
    registry.register("GetNodeStructureLow", async (args, ctx) => {
      const parentType = str(args, "parent_type");
      const parentName = str(args, "parent_name");
      if (parentType === undefined || parentName === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "parent_type" / "parent_name".');
      }
      const nodeId = str(args, "node_id") ?? "000000";
      const withShort = args["with_short_descriptions"] !== false;
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const structure = await readNodeStructure(resolved.session, parentType, parentName, nodeId, withShort);
      return treeResult(structure, withShort, resolved.sessionId, {
        parent: { type: parentType.toUpperCase(), name: parentName.toUpperCase(), node_id: nodeId },
        raw_xml: structure.raw,
      });
    });
  }

  if (registry.has("GetObjectNodeFromCache")) {
    registry.register("GetObjectNodeFromCache", async (args, ctx) => {
      const objectType = str(args, "object_type");
      const objectName = str(args, "object_name");
      const techName = str(args, "tech_name") ?? objectName;
      if (objectType === undefined || objectName === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "object_type" / "object_name".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const structure = await readNodeStructure(resolved.session, objectType, techName ?? objectName, "000000", true);
      return treeResult(structure, true, resolved.sessionId, {
        object: { type: objectType.toUpperCase(), name: objectName.toUpperCase(), tech_name: (techName ?? objectName).toUpperCase() },
      });
    });
  }

  /**
   * `GetTableContents` — SE16-style preview, parsed.
   *
 * Measured live: the tool answered the raw `<dataPreview:tableData>` document, whose
   * `totalRows` said **0** while three rows were present, and the contract's own promises
   * (`max_rows`, `fields`, `include_metadata`, compact rows) were read by nothing. A caller
   * branching on `totalRows` concluded the table was empty.
   */
  if (registry.has("GetTableContents")) {
    registry.register("GetTableContents", async (args, ctx) => {
      const table = str(args, "table_name");
      if (table === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "table_name".');
      const requested = Number(args["max_rows"]);
      const maxRows = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 20;
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const response = await resolved.session.request({
        method: "POST",
        path: `/datapreview/ddic?rowNumber=${maxRows}&ddicEntityName=${encodeURIComponent(lower(table))}`,
        accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
        contentType: "text/plain",
        timeoutMs: 120_000,
      });
      const detailed = parseDataPreviewDetailed(response.body);
      const wanted = Array.isArray(args["fields"])
        ? (args["fields"] as unknown[]).map((field) => String(field).toUpperCase())
        : undefined;
      const columns = wanted === undefined ? detailed.columns : detailed.columns.filter((column) => wanted.includes(column.name.toUpperCase()));
      // Compact rows: an empty cell is left out, so a wide table does not read as a wall of "".
      const rows = detailed.rows.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([name, value]) => (wanted === undefined || wanted.includes(name.toUpperCase())) && value.length > 0)),
      );
      return {
        success: true,
        table_name: table.toUpperCase(),
        row_limit: maxRows,
        row_count: rows.length,
        truncated: rows.length >= maxRows,
        columns: columns.map((column) => column.name),
        rows,
        ...(args["include_metadata"] === true
          ? {
              column_metadata: columns.map((column) => ({
                name: column.name,
                type: column.type,
                description: column.description,
                length: column.length,
                key: column.key,
              })),
            }
          : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetIncludesList")) {
    registry.register("GetIncludesList", async (args, ctx) => {
      const objectName = str(args, "object_name");
      const objectType = str(args, "object_type");
      if (objectName === undefined || objectType === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "object_name" / "object_type".');
      }
      // `object_type` is exempt from the registry's enum check because the generic `*ObjectLow`
      // routes take far more ADT type ids than their declared enum. This route is not generic: ADT
      // answers an empty node structure for any other id, which reads as "this object has no
      // includes" (measured 2026-11-07 with `object_type: "__NOT_A_CONTRACT_VALUE__"`).
      const includeTypes = ["PROG/P", "PROG/I", "FUGR", "CLAS/OC"];
      if (!includeTypes.includes(objectType.toUpperCase())) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          `GetIncludesList: "object_type" must be one of ${includeTypes.map((value) => `"${value}"`).join(", ")}; got "${objectType}".`,
          {
            argument: "object_type",
            value: objectType,
            allowed: includeTypes,
            nextAction:
              "Pass one of the listed types: a program, an include, a function group or a class is the only object that owns includes.",
          },
        );
      }
      const detailed = args["detailed"] === true;
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const membership = await includeMembership(resolved.session, objectType, objectName);
      return {
        success: true,
        object: { name: objectName.toUpperCase(), type: objectType.toUpperCase() },
        count: membership.includes.length,
        includes: membership.includes,
        source: membership.source,
        nodes: membership.nodes,
        ...(detailed ? { raw_xml: membership.raw } : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  /**
   * `GetProgFullCode` — the program **and its includes**.
   *
 * Measured live: the description promises "full code … including all
   * includes, in tree traversal order", and the tool answered only `source/main` —
   * a program whose body says `INCLUDE zmcp_t01_f01.` came back with no body at all.
   * A caller reading "full code" would conclude the include is empty.
   */
  if (registry.has("GetProgFullCode")) {
    registry.register("GetProgFullCode", async (args, ctx) => {
      const name = str(args, "name");
      const objectType = str(args, "type");
      if (name === undefined || objectType === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "name" / "type".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const collection = /^FUGR$/i.test(objectType) ? "/functions/groups" : "/programs/programs";
      const mainPath = `${collection}/${lower(name)}/source/main`;
      const main = await resolved.session.text({ path: mainPath, accept: "text/plain" });

      const membership = await includeMembership(resolved.session, objectType, name);
      // The main source arrives from SAP with CRLF; the separators this assembler adds must
      // not introduce a second line ending, or a caller that hashes the text gets a different
      // digest for the same program than the sources it was built from.
      const eol = main.includes("\r\n") ? "\r\n" : "\n";
      const includes: { name: string; line_count: number }[] = [];
      const parts: string[] = [main.trimEnd()];
      for (const include of membership.includes) {
        const source = await resolved.session
          .text({ path: `/programs/includes/${lower(include)}/source/main`, accept: "text/plain" })
          .catch(() => undefined);
        // An include listed in the tree but unreadable is named in the answer instead of
        // being dropped: silence here is how "full code" becomes a half answer again.
        if (source === undefined) {
          parts.push(`*&---- INCLUDE ${include} (could not be read) ----`);
          includes.push({ name: include, line_count: 0 });
          continue;
        }
        parts.push(`*&---- INCLUDE ${include} ----${eol}${source.trimEnd()}`);
        includes.push({ name: include, line_count: source.split(/\r?\n/).length });
      }

      const assembled = `${parts.join(`${eol}${eol}`)}${eol}`;
      const answer = {
        success: true,
        name,
        type: objectType,
        includes_source: membership.source,
        includes,
      };
      if (str(args, "output") === "file") {
        return { ...answer, ...sourceFileAnswer(assembled, { tool: "GetProgFullCode", name }) };
      }
      return { ...answer, line_count: assembled.split(/\r?\n/).length, source_code: assembled };
    });
  }


  /**
   * The monitoring feeds, parsed.
   *
 * Measured live: `RuntimeListFeeds {max_results: 3}` answered 24 KB of `raw_xml`
   * and `RuntimeGetGatewayErrorLog {max_results: 3}` 56 KB — `max_results` reached nothing and
   * the caller got the feed document instead of its entries. One parser (`atom-feed.ts`) serves
   * all three, and every declared filter is applied to the entries it returns.
   */
  const feedTools: ReadonlyArray<readonly [tool: string, path: string]> = [
    ["RuntimeListFeeds", "/feeds"],
    ["RuntimeListSystemMessages", "/runtime/systemmessages"],
    ["RuntimeGetGatewayErrorLog", "/gw/errorlog"],
  ];
  /** What `feed_type` names, in the words the feed directory uses. */
  const feedKeywords: Readonly<Record<string, string>> = {
    descriptors: "descriptor",
    variants: "variant",
    dumps: "dump",
    system_messages: "message",
    gateway_errors: "error log",
  };
  for (const [tool, path] of feedTools) {
    if (!registry.has(tool)) continue;
    registry.register(tool, async (args, ctx) => {
      const resolved = runtime.resolve(ctx.system, undefined, false);
      // Measured live: these endpoints answer **406** for the bare
      // `application/atom+xml` and name what they take — `application/atom+xml;type=feed`.
      // `requestAcceptingAny` retries with `*/*` if a release disagrees.
      const response = await resolved.session.requestAcceptingAny({
        path,
        accept: "application/atom+xml;type=feed",
      });
      const limit = Number(args["max_results"]);
      const feed = parseAtomFeed(String(response.body ?? ""), {
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(str(args, "user") === undefined ? {} : { user: str(args, "user") }),
        ...(str(args, "from") === undefined ? {} : { from: str(args, "from") }),
        ...(str(args, "to") === undefined ? {} : { to: str(args, "to") }),
      });
      if (feed === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", `${tool}: SAP answered something that is not an Atom feed.`, {
          path,
          nextAction: "Read the raw answer with GetProgram-adjacent debug tools, or retry — this endpoint normally answers a feed.",
        });
      }
      // `feed_type` names one of the feeds the directory lists; filter by its words rather than
      // guessing a path per type (only two of the five have a known route).
      const type = str(args, "feed_type");
      const keyword = type === undefined ? undefined : feedKeywords[type];
      if (keyword === undefined || type === undefined) {
        return { success: true, path, ...feed, session_id: resolved.sessionId };
      }
      const matched = feed.entries.filter((entry) =>
        `${entry.title} ${entry.summary ?? ""} ${entry.id}`.toLowerCase().includes(keyword),
      );
      return {
        success: true,
        path,
        ...feed,
        ...(matched.length === 0
          ? {
              feed_type: type,
              filter_note: `no entry of the feed directory mentions "${keyword}"; the full list is above`,
            }
          : { feed_type: type, count: matched.length, entries: matched }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetEnhancementImpl")) {
    registry.register("GetEnhancementImpl", async (args, ctx) => {
      const spot = str(args, "enhancement_spot");
      const name = str(args, "enhancement_name");
      if (spot === undefined || name === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "enhancement_spot" / "enhancement_name".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const typeCodes = new Set(["enhoxhh", "enhoxhb", "enhoxhc", "enhoxhd", "enhsxsb"]);
      const rawName = name.toUpperCase();
      // The caller may name the BAdI itself, its ENHO (`ZIM_…`) or its SXCI; every
      // shape is reduced to candidate BAdI names before the class is looked up.
      const badiNames = [
        typeCodes.has(spot.toLowerCase()) ? "" : spot.toUpperCase(),
        rawName,
        rawName.replace(/^ZIM_/, ""),
        rawName.replace(/^Z(?=\w)/, ""),
      ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);

      // 1) The native resource. On this stack it answers 404 or a 500 HTML page for
      //    classic BAdI implementations, in which case the class below is the source.
      try {
        const native = await resolved.session.request({
          path: `/enhancements/${encodeURIComponent(spot.toLowerCase())}/${encodeURIComponent(name.toLowerCase())}/source/main`,
          accept: "application/xml, text/plain",
          timeoutMs: 60_000,
        });
        if (!/<html/i.test(native.body) && native.body.trim().length > 0) {
          return {
            success: true,
            via: "enhancement",
            spot,
            name,
            line_count: native.body.split(/\r?\n/).length,
            source_code: native.body,
            session_id: resolved.sessionId,
          };
        }
      } catch {
        /* fall through to the class */
      }

      // 2) A classic BAdI implementation *is* its class (`ZCL_IM_<BAdI>`). Resolve a
      //    candidate list from the BAdI tables and read the first class that answers.
      const runQuery = async (sql: string): Promise<Array<Record<string, string>>> => {
        const response = await resolved.session.request({
          method: "POST",
          path: "/datapreview/freestyle?rowNumber=50",
          accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
          contentType: "text/plain",
          body: sql,
          timeoutMs: 120_000,
        });
        return parseDataPreview(response.body).rows.map((row) => ({ ...row }));
      };
      const candidates: string[] = [];
      const seen = new Set<string>();
      const add = (value: string | undefined): void => {
        const upper = (value ?? "").trim().toUpperCase();
        if (upper.length > 0 && !seen.has(upper)) {
          seen.add(upper);
          candidates.push(upper);
        }
      };
      const escape = (value: string): string => value.replace(/'/g, "''");
      for (const badi of badiNames) {
        try {
          const rows = await runQuery(`SELECT IMP_NAME FROM SXC_EXIT WHERE EXIT_NAME = '${escape(badi)}'`);
          for (const row of rows) add(row["IMP_NAME"]);
        } catch {
          /* no SXC_EXIT access: the name convention below still applies */
        }
        add(`ZCL_IM_${badi}`);
        add(`ZCL_IM_${badi.replace(/^Z(?=\w)/, "")}`);
        try {
          const rows = await runQuery(
            "SELECT OBJ_NAME FROM TADIR WHERE OBJECT = 'CLAS' AND OBJ_NAME LIKE 'ZCL_IM_%'" +
              ` AND OBJ_NAME LIKE '%${escape(badi)}'`,
          );
          for (const row of rows) add(row["OBJ_NAME"]);
        } catch {
          /* ignore */
        }
      }
      for (const candidate of candidates) {
        try {
          const source = await resolved.session.request({
            path: `/oo/classes/${encodeURIComponent(candidate.toLowerCase())}/source/main`,
            accept: "text/plain",
            timeoutMs: 60_000,
          });
          if (source.body.trim().length > 0) {
            return {
              success: true,
              via: "class",
              spot,
              name,
              class_name: candidate,
              line_count: source.body.split(/\r?\n/).length,
              source_code: source.body,
              session_id: resolved.sessionId,
            };
          }
        } catch {
          /* try the next candidate */
        }
      }
      // Nothing answered: the implementation does not exist (or has no source). Measured
      //: this raised `UPSTREAM_FAILED`, so a caller branching on `not-found` for a
      // wrong name read it as a broken system.
      throw new AdtError({
        code: "not-found",
        message:
          `GetEnhancementImpl: no source for ${badiNames.join(" / ")} — the ADT enhancement resource failed and none of ` +
          `${candidates.join(", ") || "(no candidates)"} answered.`,
        nextAction: "read the implementation class with GetClass, or open the enhancement in SE19",
        status: 404,
        method: "GET",
        path: `/enhancements/${spot}/${name}/source/main`,
      });
    });
  }

  if (registry.has("GetWhereUsed")) {
    registry.register("GetWhereUsed", async (args, ctx) => {
      const name = str(args, "object_name");
      if (name === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "object_name".');
      }
      const type = str(args, "object_type");
      const uri = whereUsedUri(name, type);
      if (uri === undefined) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          `Unsupported object_type "${type ?? ""}". Supported: ${Object.keys(WHERE_USED_PATHS).join(", ")}.`,
        );
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const response = await resolved.session.request({
        method: "POST",
        path: `/repository/informationsystem/usageReferences?uri=${encodeURIComponent(uri)}`,
        accept: WHERE_USED_ACCEPT,
        contentType: WHERE_USED_CT,
        body: WHERE_USED_BODY,
        timeoutMs: Number(args["timeout_ms"] ?? 120_000),
      });

      const references = [
        ...response.body.matchAll(
          /<usagereferences:referencedObject\b([^>]*)>([\s\S]*?)<\/usagereferences:referencedObject>/g,
        ),
      ].map((match) => parseUsageReference(match[1] ?? "", match[2] ?? ""));

      const customerOnly = args["customer_only"] === true;
      const packageFilter = str(args, "package");
      let filtered = references;
      if (customerOnly) {
        filtered = filtered.filter(
          (entry) => /^[ZY]/i.test(entry.name) || /^[ZY$]/i.test(entry.package_name),
        );
      }
      if (packageFilter !== undefined) {
        const prefix = packageFilter.endsWith("*");
        const wanted = (prefix ? packageFilter.slice(0, -1) : packageFilter).toLowerCase();
        filtered = filtered.filter((entry) =>
          prefix
            ? entry.package_name.toLowerCase().startsWith(wanted)
            : entry.package_name.toLowerCase() === wanted,
        );
      }
      const cap = num(args, "max_results", 0);
      const total = filtered.length;
      const limited = cap > 0 ? filtered.slice(0, cap) : filtered;

      return {
        success: true,
        object_uri: uri,
        declared_total: Number(/numberOfResults="(\d+)"/.exec(response.body)?.[1] ?? references.length),
        total,
        returned: limited.length,
        truncated: limited.length < total,
        references: limited,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetUsageSnippets")) {
    registry.register("GetUsageSnippets", async (args, ctx) => {
      const identifiers = Array.isArray(args["object_identifiers"])
        ? args["object_identifiers"].map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
        : [];
      let targets = identifiers;
      if (targets.length === 0) {
        const name = str(args, "object_name");
        const type = str(args, "object_type");
        const uri = name === undefined ? undefined : whereUsedUri(name, type);
        if (uri === undefined) {
          throw new GatewayError(
            "INVALID_ARGUMENT",
            'Pass "object_identifiers", or "object_name" together with "object_type".',
          );
        }
        targets = [uri];
      }
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<usagereferences:usageSnippetRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">' +
        "<usagereferences:objectIdentifiers>" +
        targets
          .map(
            (target) =>
              `<usagereferences:objectIdentifier optional="false">${escapeXmlText(target)}</usagereferences:objectIdentifier>`,
          )
          .join("") +
        "</usagereferences:objectIdentifiers><usagereferences:affectedObjects/></usagereferences:usageSnippetRequest>";

      const resolved = runtime.resolve(ctx.system, undefined, false);
      const response = await resolved.session.request({
        method: "POST",
        path: "/repository/informationsystem/usageSnippets",
        accept: USAGE_SNIPPETS_ACCEPT,
        contentType: USAGE_SNIPPETS_CT,
        body,
        timeoutMs: Number(args["timeout_ms"] ?? 120_000),
      });

      const maxObjects = num(args, "max_objects", 200);
      const includeContext = args["include_context"] === true;
      // Shape (measured ):
      // <codeSnippetObject><objectIdentifier>…</objectIdentifier><codeSnippets>
      //   <codeSnippet uri="…start=1,9;end=1,25" matches="9-25,…"><content>…</content><description>…</description>
      const objects = [
        ...response.body.matchAll(
          /<usageReferences:codeSnippetObject\b[^>]*>([\s\S]*?)<\/usageReferences:codeSnippetObject>/g,
        ),
      ].slice(0, maxObjects);
      const snippets = objects.flatMap((objectMatch) => {
        const inner = objectMatch[1] ?? "";
        const identifier = decodeXmlEntities(/<objectIdentifier>([\s\S]*?)<\/objectIdentifier>/.exec(inner)?.[1]?.trim() ?? "");
        return [
          ...inner.matchAll(
            /<usageReferences:codeSnippet\b([^>]*)>([\s\S]*?)<\/usageReferences:codeSnippet>/g,
          ),
        ].map((match) => {
          const attributes = match[1] ?? "";
          const uri = xmlAttrOf(attributes, "uri");
          const matches = xmlAttrOf(attributes, "matches");
          const start = /start=(\d+),(\d+)/.exec(uri);
          const body = match[2] ?? "";
          // The snippet is ABAP source: `<=` and `->` arrive escaped, so the text is
          // decoded once here or the caller reads `&lt;=` in a hit list.
          const content = decodeXmlEntities(/<content>([\s\S]*?)<\/content>/.exec(body)?.[1]?.trim() ?? "");
          const rawDescription = /<description>([\s\S]*?)<\/description>/.exec(body)?.[1]?.trim();
          const description = rawDescription === undefined ? undefined : decodeXmlEntities(rawDescription);
          return {
            object: identifier,
            uri,
            ...(start === null ? {} : { line: Number(start[1]), column: Number(start[2]) }),
            ...(matches.length === 0 ? {} : { matches }),
            text: content,
            ...(includeContext && description !== undefined ? { description } : {}),
          };
        });
      });

      return {
        success: true,
        path: "/repository/informationsystem/usageSnippets",
        status: response.status,
        requested: targets,
        count: snippets.length,
        truncated: objects.length >= maxObjects,
        snippets,
        ...(snippets.length === 0 ? { raw_xml: response.body } : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetScreensList")) {
    registry.register("GetScreensList", async (args, ctx) => {
      const program = (str(args, "program_name") ?? "").toUpperCase();
      if (program.length === 0) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "program_name".');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      // ADT has no dynpro-list resource and the dispatcher bridge exposes READ / INSERT /
      // DELETE only, so the authoritative list is `D020S` (: the route used to
      // answer with the program's object structure, i.e. function modules and includes).
      const response = await resolved.session.request({
        method: "POST",
        path: "/datapreview/freestyle?rowNumber=1000",
        accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
        contentType: "text/plain",
        body: `SELECT DNUM FROM D020S WHERE PROG = '${program.replace(/'/g, "''")}'`,
        timeoutMs: 120_000,
      });
      const screens = parseDataPreview(response.body)
        .rows.map((row) => (row["DNUM"] ?? "").trim())
        .filter((screen) => screen.length > 0)
        .sort();
      return {
        success: true,
        program_name: program,
        count: screens.length,
        screens,
        note: "Screen numbers come from D020S; read one screen with GetScreen(program_name, screen_number).",
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetGuiStatus")) {
    registry.register("GetGuiStatus", async (args, ctx) => {
      const program = (str(args, "program_name") ?? "").toUpperCase();
      if (program.length === 0) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "program_name".');
      }
      const statusFilter = (str(args, "status_name") ?? "").toUpperCase() || undefined;
      const wanted = Array.isArray(args["function_codes"])
        ? args["function_codes"].map((entry) => String(entry).toUpperCase())
        : [];
      const compact = str(args, "format") === "compact";

      const resolved = runtime.resolve(ctx.system, undefined, false);
      // CUA has no ADT resource: the dispatcher bridge returns the whole RSMPE image.
      // A program without a GUI status answers sy-subrc=1; that is an empty CUA, not a
      // failed read — report count 0 / empty tables instead of UPSTREAM_FAILED.
      let raw: Awaited<ReturnType<RfcBridge["dispatch"]>>;
      try {
        raw = await new RfcBridge(resolved.session).dispatch("CUA_FETCH", { program });
      } catch (error) {
        if (!isCuaMissingError(error)) throw error;
        const empty = {
          ADM: {},
          STA: [],
          SET: [],
          FUN: [],
          PFK: [],
          BUT: [],
          MEN: [],
          MTX: [],
          ACT: [],
          DOC: [],
          TIT: [],
          BIV: [],
        };
        if (compact) {
          return {
            success: true,
            transport: "rfc",
            program_name: program,
            format: "compact",
            count: 0,
            statuses: [],
            note: "the program has no GUI status (CUA); CreateGuiStatus can create the first one",
            session_id: resolved.sessionId,
          };
        }
        return {
          success: true,
          transport: "rfc",
          program_name: program,
          result: empty,
          count: 0,
          note: "the program has no GUI status (CUA); CreateGuiStatus can create the first one",
          session_id: resolved.sessionId,
        };
      }
      const result = (raw.result ?? {}) as Record<string, unknown>;
      const rows = (key: string): Array<Record<string, string>> =>
        Array.isArray(result[key]) ? (result[key] as Array<Record<string, string>>) : [];
      const keep = (code: string | undefined): boolean =>
        wanted.length === 0 || wanted.includes((code ?? "").trim().toUpperCase());
      const same = (left: string | undefined, right: string): boolean =>
        (left ?? "").trim().toUpperCase() === right;

      const sta = rows("STA");
      const set = rows("SET");
      const fun = rows("FUN");
      const pfk = rows("PFK");
      const but = rows("BUT");
      const statusNames = (
        statusFilter === undefined ? sta.map((row) => (row["CODE"] ?? "").trim().toUpperCase()) : [statusFilter]
      ).filter((code) => code.length > 0);

      if (!compact) {
        return {
          success: true,
          transport: "rfc",
          program_name: program,
          result: {
            ADM: result["ADM"] ?? {},
            STA: sta.filter((row) => statusFilter === undefined || same(row["CODE"], statusFilter)),
            SET: set.filter(
              (row) =>
                (statusFilter === undefined || same(row["STATUS"], statusFilter)) && keep(row["FUNCTION"]),
            ),
            FUN: fun.filter((row) => keep(row["CODE"])),
            PFK: pfk.filter((row) => keep(row["FUNCODE"])),
            BUT: but,
            MEN: rows("MEN"),
            MTX: rows("MTX"),
            ACT: rows("ACT"),
            DOC: rows("DOC"),
            TIT: rows("TIT"),
            BIV: rows("BIV"),
          },
          session_id: resolved.sessionId,
        };
      }

      const statuses = statusNames.map((code) => {
        // Measured live: `PatchGuiStatus {changes: {FUN: [{CODE: "ZBACK"}]}}` really
        // wrote the row (it is in the full document) but `GetGuiStatus {function_codes:["ZBACK"],
        // format:"compact"}` answered an empty list — this list came from `SET` alone, and a
        // function code that is not yet assigned to the status has no `SET` row. The caller then
        // believed the patch had failed. Codes asked for explicitly are shown even when unlinked,
        // with `linked: false`, which is the fact that matters.
        const linkedCodes = set
          .filter((row) => same(row["STATUS"], code) && keep(row["FUNCTION"]))
          .map((row) => (row["FUNCTION"] ?? "").trim().toUpperCase());
        const askedCodes = wanted.length === 0 ? [] : fun.filter((row) => keep(row["CODE"])).map((row) => (row["CODE"] ?? "").trim().toUpperCase());
        const codes = [...new Set([...linkedCodes, ...askedCodes])];
        const functions = codes.filter((entry) => entry.length > 0).map((functionCode) => {
          const text = fun.find((row) => same(row["CODE"], functionCode));
          const key = pfk.find((row) => same(row["FUNCODE"], functionCode));
          const inToolbar = but.some(
            (row) => same(row["CODE"], functionCode) || same(row["PFK_CODE"], functionCode),
          );
          return {
            code: functionCode,
            text: (text?.["FUN_TEXT"] ?? "").trim(),
            linked: linkedCodes.includes(functionCode),
            ...((text?.["ICON_ID"] ?? "").trim() === "" ? {} : { icon: (text?.["ICON_ID"] ?? "").trim() }),
            ...((key?.["PFNO"] ?? "").trim() === "" ? {} : { fkey: (key?.["PFNO"] ?? "").trim() }),
            ...(inToolbar ? { toolbar: true } : {}),
          };
        });
        const info = sta.find((row) => same(row["CODE"], code));
        return {
          code,
          type: (info?.["MODAL"] ?? "").trim(),
          description: (info?.["INT_NOTE"] ?? "").trim(),
          functions,
        };
      });

      return {
        success: true,
        transport: "rfc",
        program_name: program,
        format: "compact",
        count: statuses.length,
        statuses,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetTransaction")) {
    registry.register("GetTransaction", async (args, ctx) => {
      const single = str(args, "transaction_name");
      const many = Array.isArray(args["transaction_names"])
        ? args["transaction_names"].map((entry) => String(entry))
        : [];
      const names = [...new Set([...(single === undefined ? [] : [single]), ...many])]
        .map((name) => name.trim().toUpperCase())
        .filter((name) => name.length > 0);
      if (names.length === 0) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "transaction_name" (or "transaction_names").');
      }
      const resolved = runtime.resolve(ctx.system, undefined, false);
      // The ADT resource for `TRAN/T` is the object header only (name / type / version /
      // description). Program, screen and the parameter payload live in TSTC / TSTCP, which is
      // what the tool promises — measured: before this, `GetTransaction` answered no
      // `program_name` / `screen_number` / `kind` at all.
      const inList = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(",");
      const readTable = async (sql: string): Promise<Array<Record<string, string>>> => {
        try {
          const response = await resolved.session.request({
            method: "POST",
            path: "/datapreview/freestyle?rowNumber=500",
            accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
            contentType: "text/plain",
            timeoutMs: 120_000,
            body: sql,
          });
          return parseDataPreview(response.body).rows as Array<Record<string, string>>;
        } catch {
          // A system without Data Preview still gets the object header below.
          return [];
        }
      };
      const tstc = new Map(
        (await readTable(`SELECT TCODE, PGMNA, DYPNO FROM TSTC WHERE TCODE IN (${inList})`)).map((row) => [
          String(row["TCODE"] ?? "").trim().toUpperCase(),
          { program: String(row["PGMNA"] ?? "").trim(), screen: String(row["DYPNO"] ?? "").trim() },
        ]),
      );
      const tstcp = new Map(
        (await readTable(`SELECT TCODE, PARAM FROM TSTCP WHERE TCODE IN (${inList})`)).map((row) => [
          String(row["TCODE"] ?? "").trim().toUpperCase(),
          String(row["PARAM"] ?? "").trim(),
        ]),
      );
      const transactions: Array<Record<string, unknown>> = [];
      for (const name of names) {
        const entry = tstc.get(name);
        const parameters = tstcp.get(name);
        const kind =
          parameters === undefined || parameters.length === 0
            ? entry === undefined
              ? "unknown"
              : "program"
            : "parameter";
        try {
          const response = await resolved.session.request({
            path: `/vit/wb/object_type/trant/object_name/${encodeURIComponent(name.toLowerCase())}`,
            accept: "application/vnd.sap.adt.basic.object.properties+xml",
          });
          const attributes = /<adtcore:mainObject\b([^>]*)>/.exec(response.body)?.[1] ?? "";
          const read = (key: string): string | undefined =>
            new RegExp(`${key}="([^"]*)"`).exec(attributes)?.[1];
          transactions.push({
            transaction: name,
            type: read("adtcore:type"),
            state: read("adtcore:version"),
            description: read("adtcore:description"),
            kind,
            ...(entry === undefined ? {} : { program_name: entry.program, screen_number: entry.screen }),
            ...(kind === "parameter" ? { parameters } : {}),
            // The `TRAN/T` object endpoint answers 200 for a name that is not a transaction at
            // all (measured: `ZZZ_NOT_A_TCODE` got a header with no description).
            // TSTC is the honest answer, so its absence is what makes the entry not-found.
            ...(kind === "unknown" ? { found: false, detail: "no TSTC entry for this transaction code" } : {}),
            raw_xml: response.body,
          });
        } catch (error) {
          transactions.push({
            transaction: name,
            kind,
            ...(entry === undefined ? {} : { program_name: entry.program, screen_number: entry.screen }),
            ...(kind === "unknown" ? { found: false } : {}),
            error: String((error as Error).message ?? error),
          });
        }
      }
      return {
        success: transactions.every((entry) => entry["error"] === undefined && entry["kind"] !== "unknown"),
        count: transactions.length,
        transactions,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetAdtTypes")) {
    registry.register("GetAdtTypes", async (args, ctx) => {
      const wanted = str(args, "validate_type");
      const resolved = runtime.resolve(ctx.system, undefined, false);
      // SAP validates the `objectType` filter itself: an unknown code answers
      // 400 "Value XXXX for property TYPE is invalid". That is the only authoritative
      // answer to "is this an ADT object type", so validation is a real search call.
      if (wanted !== undefined) {
        const type = wanted.trim().toUpperCase();
        try {
          await resolved.session.requestAcceptingAny({
            path:
              "/repository/informationsystem/search?operation=quickSearch" +
              `&query=${encodeURIComponent("*")}&maxResults=1&objectType=${encodeURIComponent(type)}`,
            accept: "application/xml",
          });
          return { success: true, validate_type: type, valid: true, session_id: resolved.sessionId };
        } catch (error) {
          const message = String((error as Error).message ?? error);
          const rejected = /property TYPE is invalid|not valid for property/i.test(message);
          if (!rejected) throw error;
          return {
            success: false,
            validate_type: type,
            valid: false,
            detail: message,
            session_id: resolved.sessionId,
          };
        }
      }
      // The discovery document is a service catalogue (126 workspaces / 833 collections /
      // 400 KB with every `app:accept`), not a list of repository type codes. Answering the
      // catalogue is honest; the type codes come from `validate_type` or from a node structure.
      const response = await resolved.session.requestAcceptingAny({
        path: "/discovery",
        accept: "application/atomsvc+xml",
      });
      const doc = parseXml(response.body);
      const workspaces =
        doc === undefined
          ? []
          : findElements(doc, "workspace").map((workspace) => ({
              title: childTextOf(workspace, "title") ?? "",
              collections: findElements(workspace, "collection").map((collection) => ({
                href: attributeOf(collection, "href") ?? "",
                title: childTextOf(collection, "title") ?? "",
              })),
            }));
      return {
        success: true,
        status: response.status,
        workspace_count: workspaces.length,
        collection_count: workspaces.reduce((sum, workspace) => sum + workspace.collections.length, 0),
        workspaces,
        note:
          "This is the ADT service catalogue (workspaces and their collection URIs). For a repository type " +
          'code pass validate_type — SAP rejects an unknown code with "property TYPE is invalid".',
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("SearchObject")) {
    registry.register("SearchObject", async (args, ctx) => {
      const query = str(args, "object_name");
      if (query === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "object_name".');
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const maxResults = num(args, "maxResults", 100);
      const objectType = str(args, "object_type");

      const response = await resolved.session.requestAcceptingAny({
        path:
          "/repository/informationsystem/search?operation=quickSearch" +
          `&query=${encodeURIComponent(query)}&maxResults=${maxResults}` +
          (objectType === undefined ? "" : `&objectType=${encodeURIComponent(objectType)}`),
        accept: "application/xml",
      });

      const objects = objectReferences(response.body);
      return {
        success: true,
        query,
        count: objects.length,
        truncated: objects.length >= maxResults,
        objects,
        ...(args["include_raw_xml"] === true ? { raw_xml: response.body } : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("ListTransports")) {
    registry.register("ListTransports", async (args, ctx) => {
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const user = (str(args, "user") ?? resolved.session.username).toUpperCase();
      const modifiableOnly = args["modifiable_only"] !== false;
      //: the ADT transport organizer answers an empty tree for this user on
      // this stack while `E070` holds the requests, so the list comes from `E070`
      // (+ `E07T` for the text). `GetTransport` still reads the ADT detail.
      const runQuery = async (sql: string): Promise<Array<Record<string, string>>> => {
        const response = await resolved.session.request({
          method: "POST",
          path: "/datapreview/freestyle?rowNumber=500",
          accept: "application/vnd.sap.adt.datapreview.table.v1+xml",
          contentType: "text/plain",
          body: sql,
          timeoutMs: 120_000,
        });
        return parseDataPreview(response.body).rows.map((row) => ({ ...row }));
      };
      const escape = (value: string): string => value.replace(/'/g, "''");
      const rows = await runQuery(
        "SELECT TRKORR, TRFUNCTION, TRSTATUS, AS4USER, AS4DATE, AS4TIME FROM E070" +
          ` WHERE AS4USER = '${escape(user)}'` +
          (modifiableOnly ? " AND TRSTATUS IN ('D', 'L')" : ""),
      );
      // `IN` lists are short-lived on this endpoint; texts are fetched in small chunks.
      const descriptions = new Map<string, string>();
      const numbers = rows.map((row) => (row["TRKORR"] ?? "").trim()).filter((value) => value.length > 0);
      for (let index = 0; index < numbers.length && index < 100; index += 10) {
        const chunk = numbers.slice(index, index + 10);
        const textRows = await runQuery(
          `SELECT TRKORR, AS4TEXT FROM E07T WHERE TRKORR IN (${chunk.map((value) => `'${escape(value)}'`).join(", ")})`,
        );
        for (const textRow of textRows) {
          const key = (textRow["TRKORR"] ?? "").trim();
          if (key.length > 0 && !descriptions.has(key)) {
            descriptions.set(key, (textRow["AS4TEXT"] ?? "").trim());
          }
        }
      }
      const statusText = (status: string): string =>
        status === "D" ? "modifiable" : status === "L" ? "modifiable (locked)" : status === "R" ? "released" : status;
      const transports = rows.map((row) => {
        const number = (row["TRKORR"] ?? "").trim();
        const status = (row["TRSTATUS"] ?? "").trim();
        return {
          transport_number: number,
          type: (row["TRFUNCTION"] ?? "").trim(),
          status,
          status_text: statusText(status),
          owner: (row["AS4USER"] ?? "").trim(),
          date: (row["AS4DATE"] ?? "").trim(),
          time: (row["AS4TIME"] ?? "").trim(),
          description: descriptions.get(number) ?? "",
        };
      });
      return {
        success: true,
        user,
        modifiable_only: modifiableOnly,
        count: transports.length,
        transports,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("UpdateServiceBinding")) {
    registry.register("UpdateServiceBinding", async (args, ctx) => {
      const name = str(args, "service_binding_name");
      if (name === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "service_binding_name".');
      const state = (str(args, "desired_publication_state") ?? "unchanged").toLowerCase();
      if (state === "unchanged") {
        return { success: true, name, publication_state: "unchanged", published: undefined };
      }
      // Measured: publishing is a **job**, not a PUT of the binding
      // document. The generic update path re-uploaded the document and SAP answered
      // "the description of <binding> is missing". The endpoint takes object references
      // and the service name/version as query parameters (upstream client does the same).
      const serviceType = (str(args, "service_type") ?? "ODataV4").toLowerCase();
      const segment = serviceType.includes("2") ? "odatav2" : "odatav4";
      const serviceName = str(args, "service_name") ?? name;
      const serviceVersion = str(args, "service_version") ?? "0001";
      const action = state === "published" ? "publishjobs" : "unpublishjobs";
      const resolved = runtime.resolve(ctx.system, str(args, "session_id"), true);
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
        `<adtcore:objectReference adtcore:uri="/sap/bc/adt/businessservices/bindings/${name.toLowerCase()}" ` +
        `adtcore:name="${name.toUpperCase()}"/>` +
        "</adtcore:objectReferences>";
      const response = await resolved.session.request({
        method: "POST",
        path: `/businessservices/${segment}/${action}?servicename=${encodeURIComponent(serviceName)}&serviceversion=${encodeURIComponent(serviceVersion)}`,
        // Measured: the job answers as AS-XML; anything else is a 406
        // listing `application/vnd.sap.as+xml` as the accepted type.
        accept: "application/vnd.sap.as+xml",
        contentType: "application/xml",
        body,
        timeoutMs: 180_000,
      });
      // Measured: the job answers **200** with `<SEVERITY>ERROR</SEVERITY>`
      // when publishing is refused (e.g. "…in Customizing Client not allowed"). The
      // status code says nothing; the payload does.
      const severity = (/<SEVERITY>([^<]*)<\/SEVERITY>/i.exec(response.body)?.[1] ?? "").trim().toUpperCase();
      const shortText = (/<SHORT_TEXT>([^<]*)<\/SHORT_TEXT>/i.exec(response.body)?.[1] ?? "").trim();
      const longText = (/<LONG_TEXT>([^<]*)<\/LONG_TEXT>/i.exec(response.body)?.[1] ?? "").trim();
      const failed = severity === "ERROR" || severity === "ABORT" || severity === "E";
      return {
        success: !failed,
        name,
        publication_state: state,
        service_name: serviceName,
        service_version: serviceVersion,
        status: response.status,
        ...(failed ? { error: shortText, detail: longText } : {}),
        raw_xml: response.body,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("RuntimeCreateProfilerTraceParameters")) {
    registry.register("RuntimeCreateProfilerTraceParameters", async (args, ctx) => {
      const description = str(args, "description");
      if (description === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "description".');
      // Measured: the endpoint wants `trc:parameters` with one
      // `<trc:<name> value="…"/>` child per option (shape taken from the upstream
      // client). The previous route posted the caller's `body`, an argument no schema
      // declares, and SAP answered "the system expected element '{…}parameters'".
      const flags: readonly (readonly [arg: string, element: string])[] = [
        ["all_misc_abap_statements", "allMiscAbapStatements"],
        ["all_procedural_units", "allProceduralUnits"],
        ["all_internal_table_events", "allInternalTableEvents"],
        ["all_dynpro_events", "allDynproEvents"],
        ["aggregate", "aggregate"],
        ["explicit_on_off", "explicitOnOff"],
        ["with_rfc_tracing", "withRfcTracing"],
        ["all_system_kernel_events", "allSystemKernelEvents"],
        ["sql_trace", "sqlTrace"],
        ["all_db_events", "allDbEvents"],
        ["amdp_trace", "amdpTrace"],
      ];
      const numbers: readonly (readonly [arg: string, element: string])[] = [
        ["max_size_for_trace_file", "maxSizeForTraceFile"],
        ["max_time_for_tracing", "maxTimeForTracing"],
      ];
      const parts: string[] = [];
      for (const [arg, element] of flags) {
        const value = args[arg];
        if (typeof value === "boolean") parts.push(`  <trc:${element} value="${value ? "true" : "false"}"/>`);
      }
      parts.push(`  <trc:description value="${escapeXmlText(description.slice(0, 60))}"/>`);
      for (const [arg, element] of numbers) {
        const value = args[arg];
        if (typeof value === "number" && Number.isFinite(value)) parts.push(`  <trc:${element} value="${Math.trunc(value)}"/>`);
      }
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<trc:parameters xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces">' +
        parts.join("") +
        "</trc:parameters>";
      const resolved = runtime.resolve(ctx.system, str(args, "session_id"), true);
      const response = await resolved.session.request({
        method: "POST",
        path: "/runtime/traces/abaptraces/parameters",
        accept: "application/xml",
        contentType: "application/xml",
        body,
        timeoutMs: 120_000,
      });
      return {
        success: true,
        description,
        status: response.status,
        raw_xml: response.body,
        session_id: resolved.sessionId,
      };
    });
  }

  // Service binding types: `namedItemList` where `name` is the protocol, the *description*
  // is the version index (0/1) and `data` is the label a caller must pass back as
  // `binding_type` ("ODATA V4"). It used to be a fixed route, so `response_format` was
  // ignored and the caller received the raw named-item document (measured ).
  for (const tool of ["ListServiceBindingTypes", "HandlerServiceBindingListTypes"]) {
    if (!registry.has(tool)) continue;
    registry.register(tool, async (args, ctx) => {
      const format = (str(args, "response_format") ?? "xml").toLowerCase();
      const resolved = runtime.resolve(ctx.system, str(args, "session_id"), false);
      const response = await resolved.session.request({
        path: "/businessservices/bindings/bindingtypes",
        accept: "application/xml, application/json",
        timeoutMs: 120_000,
      });
      const doc = parseXml(response.body);
      const items =
        doc === undefined
          ? []
          : findElements(doc, "namedItem").map((item) => {
              const version = Number(childTextOf(item, "description") ?? 0);
              return {
                name: childTextOf(item, "name") ?? "",
                version: Number.isFinite(version) ? version : 0,
                label: childTextOf(item, "data") ?? "",
              };
            });
      const types = items.filter((item) => item.name.length > 0);
      return {
        success: true,
        status: response.status,
        count: types.length,
        types,
        // `binding_type` is what `CreateServiceBinding` takes; the label is the value
        // SAP itself lists ("ODATA V4", "SQL"), the name alone does not pick a version.
        binding_types: [...new Set(types.map((item) => item.label).filter((label) => label.length > 0))],
        ...(format === "plain"
          ? { text: types.map((item) => `${item.label}  (${item.name}, v${item.version})`).join("\n") }
          : {}),
        ...(format === "xml" ? { raw_xml: response.body } : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  // Service binding validation: ADT has no validation resource, but the two questions
  // a caller actually needs answered can be answered with reads — is the binding name
  // free, and does the service definition it points at exist?
  for (const tool of ["ValidateServiceBinding", "HandlerServiceBindingValidate"]) {
    if (!registry.has(tool)) continue;
    registry.register(tool, async (args, ctx) => {
      const name = str(args, "service_binding_name");
      const definition = str(args, "service_definition_name");
      if (name === undefined || definition === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "service_binding_name" / "service_definition_name".');
      }
      const resolved = runtime.resolve(ctx.system, str(args, "session_id"), false);
      const exists = async (path: string, accept: string): Promise<boolean> =>
        resolved.session
          .requestAcceptingAny({ path, accept })
          .then(() => true)
          .catch(() => false);
      const bindingExists = await exists(
        `/businessservices/bindings/${name.toLowerCase()}`,
        "application/vnd.sap.adt.businessservices.servicebinding.v2+xml",
      );
      const definitionExists = await exists(
        `/ddic/srvd/sources/${definition.toLowerCase()}`,
        "application/vnd.sap.adt.ddic.srvd.v1+xml",
      );
      return {
        success: !bindingExists && definitionExists,
        service_binding_name: name,
        service_definition_name: definition,
        available: !bindingExists,
        service_definition_exists: definitionExists,
        ...(bindingExists ? { detail: "a service binding with this name already exists" } : {}),
        ...(definitionExists ? {} : { detail_definition: "the service definition does not exist" }),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("CreateTransport")) {
    registry.register("CreateTransport", async (args, ctx) => {
      const description = str(args, "description");
      if (description === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "description".');
      const kind = (str(args, "transport_type") ?? "workbench").toLowerCase();
      // K = workbench request, W = customizing request.
      const type = kind === "customizing" ? "W" : "K";
      const target = str(args, "target_system")?.trim();
      // A transport without a target is not a transport: SAP stores an empty
      // `TARSYSTEM` and the request is unusable for the landscape (user ruling
      //: "the target system always has to be given"). Ask for it instead of
      // inventing LOCAL.
      if (target === undefined || target.length === 0) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          'CreateTransport needs "target_system" (e.g. the quality system of this landscape).',
          {
            nextAction:
              "Read an existing request (ListTransports, then GetTransport) and pass the same target; SAP keeps it in E070-TARSYSTEM.",
          },
        );
      }
      const resolved = runtime.resolve(ctx.system, str(args, "session_id"), true);
      const owner = str(args, "owner") ?? resolved.session.username;
      // Measured: the endpoint wants a `tm:root` document with
      // `tm:useraction="newrequest"`, an explicit target and a nested `tm:task` that
      // carries the owner. Without the task the call still answers 201 with a
      // `tm:request` element, but **no E070 row is written** — the number it returns
      // does not exist, which is how a "created" transport turned out to be unusable.
      // Shape taken from the upstream client's transport builder.
      const body =
        '<?xml version="1.0" encoding="ASCII"?>' +
        '<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="newrequest">' +
        `<tm:request tm:desc="${escapeXmlText(description.slice(0, 60))}" tm:type="${type}"` +
        ` tm:target="${escapeXmlText(target)}" tm:cts_project="">` +
        `<tm:task tm:owner="${escapeXmlText(owner)}"/>` +
        "</tm:request></tm:root>";
      const media = "application/vnd.sap.adt.transportorganizer.v1+xml";
      const response = await resolved.session.request({
        method: "POST",
        path: "/cts/transportrequests",
        accept: media,
        contentType: media,
        body,
        timeoutMs: 120_000,
      });
      const number = /tm:number="([^"]+)"/i.exec(response.body)?.[1] ?? "";
      // A number in a 201 body is not proof that the request is usable: measured on
      // DS4/100, three creations answered `201` with a fresh number and read back `404` minutes
      // later **because the probe requests had been deleted in SE09** — the same tool's next
      // creation (`<sid>K900513`, with one object recorded into it) stayed readable. So the
      // read-back is a snapshot ("readable right now"), not a verdict on the creation: SAP does
      // write an E070 row, and a person can delete that request at any time.
      let verified = false;
      if (number.length > 0) {
        verified = await resolved.session
          .requestAcceptingAny({
            path: `/cts/transportrequests/${encodeURIComponent(number)}`,
            accept: media,
          })
          .then(() => true)
          .catch(() => false);
      }
      return {
        success: number.length > 0,
        transport_number: number,
        transport_type: type,
        description,
        owner,
        verified,
        ...(number.length === 0 || verified
          ? {}
          : {
              note:
                `SAP answered ${response.status} with request ${number}, but it is not readable now ` +
                "(deleted since, or no E070 row was written) — confirm it in SE09 before recording objects into it.",
            }),
        raw_xml: response.body,
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetTransport")) {
    registry.register("GetTransport", async (args, ctx) => {
      const number = str(args, "transport_number");
      if (number === undefined) throw new GatewayError("INVALID_ARGUMENT", 'Missing "transport_number".');
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const owner = str(args, "owner");
      let body: string;
      try {
        body = (
          await resolved.session.requestAcceptingAny({
            path: `/cts/transportrequests/${encodeURIComponent(number)}`,
            accept: "application/vnd.sap.adt.transportrequests.v1+xml",
          })
        ).body;
      } catch (error) {
        // The path read is scoped to the logon user on some releases; with `owner` the list
        // endpoint answers other users' requests, so one more read can still answer.
        if (owner === undefined) throw error;
        const listed = await resolved.session.requestAcceptingAny({
          path: `/cts/transportrequests?user=${encodeURIComponent(owner)}`,
          accept: "application/vnd.sap.adt.transportrequests.v1+xml",
        });
        body = listed.body;
      }
      // Measured live: this document is 123 KB for a request with 110 objects and
      // was handed over as `raw_xml`, so none of `header` / `tasks` / `objects` — the three
      // things the tool promises — could be read without parsing it by hand.
      const doc = parseXml(body);
      const toEntry = (node: XmlObject): Record<string, string> => ({
        number: attributeOf(node, "number") ?? "",
        owner: attributeOf(node, "owner") ?? "",
        description: attributeOf(node, "desc") ?? "",
        type: attributeOf(node, "type") ?? "",
        status: attributeOf(node, "status") ?? "",
        status_text: attributeOf(node, "status_text") ?? "",
        target: attributeOf(node, "target") ?? "",
        parent: attributeOf(node, "parent") ?? "",
        source_client: attributeOf(node, "source_client") ?? "",
        changed_at: attributeOf(node, "lastchanged_timestamp") ?? "",
        uri: attributeOf(node, "uri") ?? "",
      });
      const requestNode = doc === undefined ? undefined : findElements(doc, "request")[0];
      const header =
        requestNode === undefined
          ? { number }
          : toEntry(requestNode);
      const includeTasks = args["include_tasks"] !== false;
      const includeObjects = args["include_objects"] !== false;
      const tasks =
        includeTasks && doc !== undefined
          ? findElements(doc, "task").map((node) => toEntry(node))
          : [];
      const objects =
        includeObjects && doc !== undefined
          ? findElements(doc, "abap_object").map((node) => ({
              pgmid: attributeOf(node, "pgmid") ?? "",
              type: attributeOf(node, "type") ?? "",
              name: attributeOf(node, "name") ?? "",
              wbtype: attributeOf(node, "wbtype") ?? "",
              object_name: attributeOf(node, "obj_desc") ?? "",
              info: attributeOf(node, "obj_info") ?? "",
              position: attributeOf(node, "position") ?? "",
              locked: (attributeOf(node, "lock_status") ?? "").length > 0,
            }))
          : [];
      return {
        success: true,
        transport_number: number,
        header,
        task_count: tasks.length,
        ...(includeTasks ? { tasks } : {}),
        object_count: objects.length,
        ...(includeObjects ? { objects } : {}),
        session_id: resolved.sessionId,
      };
    });
  }

  if (registry.has("GetInactiveObjects")) {
    registry.register("GetInactiveObjects", async (_args, ctx) => {
      const resolved = runtime.resolve(ctx.system, undefined, false);
      const response = await resolved.session.requestAcceptingAny({
        path: "/activation/inactiveobjects",
        accept: "application/xml",
      });
      const objects = objectReferences(response.body);
      return { success: true, count: objects.length, objects, session_id: resolved.sessionId };
    });
  }

  // Profiler runs are three requests, not one route; see src/tools/profiler.ts.
  registerProfilerTools(registry, runtime);

  // `ReloadProfile` has no SAP resource — it re-reads this gateway's own configuration and
  // restarts the sessions, which is what the upstream server does from `.sc4sap/…`. The
  // server process installs the loader (`runtime.setReloader`); without one (tests, the
  // `--coverage` run) the tool says so instead of pretending.
  if (registry.has("ReloadProfile")) {
    registry.register("ReloadProfile", async () => {
      if (!runtime.canReload) {
        throw new GatewayError(
          "NOT_IMPLEMENTED",
          "This gateway was started without a configuration reloader, so there is no profile to re-read.",
          { nextAction: "Restart the gateway (or reload the VS Code window) after changing the configuration." },
        );
      }
      const result = await runtime.reloadSystems();
      return {
        success: true,
        reloaded: true,
        previous_systems: result.before,
        systems: result.after,
        sessions_closed: result.closed,
        note: "The configuration was read again and every session was ended; the next call logs on with the new settings.",
      };
    });
  }
}
