/**
 * Remaining tools, registered through a declarative route table.
 *
 * Each entry says what the call is: method, path template, media type, and how to
 * shape the result. Nothing here is invented per-tool code — a family of tools
 * that differs only by path is one row.
 *
 * **Status: not verified against a system yet.** The routes follow the ADT layout
 * the object families in this project already use, but each one still has to be
 * confirmed live; until then a wrong route surfaces as a 404 from SAP, which is
 * exactly how it should fail.
 */

import type { ToolRegistry } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import { GatewayError } from "../engine/errors.js";
import { AdtError } from "../adt/errors.js";
import { lockHandleFromBody } from "../adt/session.js";
import { RfcBridge } from "../adt/rfc.js";
import { attributeOf, decodeXmlEntities, findElements, messageTextOf, nodeTextOf, parseXml, rootNameOf } from "../adt/xml.js";
import { BRIDGE_TOOL_NAMES } from "./bridges.js";
import { parseUnitResult, parseUnitStatus } from "./unit-result.js";
import { legacyUnitTestBody, modernUnitTestBody } from "./unit-test.js";

type Args = Record<string, unknown>;

/**
 * True when SAP answered "that URL is not a resource" rather than "that object is
 * missing" — the only case where asking a different path can help.
 */
function endpointMissing(error: unknown): boolean {
  if (!(error instanceof AdtError)) return false;
  if (error.code === "content-negotiation") return true;
  if (error.code !== "not-found") return false;
  // "No suitable resource found" in the languages this gateway has met so far.
  return /No suitable resource|未找到合适资源|No URI-Mapping defined/i.test(error.sapText ?? "");
}

/** One bridged call: which dispatcher action, and where each parameter comes from. */
interface RfcCall {
  /** Action name understood by `ZMCP_ADT_DISPATCH`. */
  readonly action: string;
  /** Function-module parameter -> argument to read it from. */
  readonly params: Readonly<Record<string, string>>;
}

interface Route {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  /** `{}` placeholders are filled from the arguments of the same name. */
  readonly path?: string;
  readonly accept?: string;
  readonly contentType?: string;
  /** Argument whose value becomes the request body, when the tool sends one. */
  readonly bodyFrom?: string;
  /**
   * Literal request body. `{name}` placeholders are filled from the arguments
   * with their case preserved (names, URIs) and XML-escaped.
   */
  readonly body?: string;
  /**
   * Builds `{object_uri}` from these two arguments (name, type) with the ADT
   * resource layout, the way the ADT clients resolve a where-used target.
   */
  readonly uriFrom?: readonly [name: string, type: string];
  /**
   * Placeholders that are opaque identifiers, not names. The value is reduced to its
   * last path segment (so a full resource URI works), then decoded and percent-encoded,
   * which lets a caller pass either the raw id or the form the feed hands out.
   */
  readonly encode?: readonly string[];
  /**
   * The tool has no usable endpoint on this stack. The text is the reason the
   * caller gets back, so a wrong answer never stands in for a missing one.
   */
  readonly unsupported?: string;
  /**
   * Resolves `{resource}` from an `object_type` argument, for the tools that
   * dispatch to whichever family the caller names.
   */
  readonly resourceFrom?: string;
  /**
   * Resolves `{validation_path}` — the family's name check — from an `object_type`
   * argument. The query parameters differ per family, so the path is built here.
   */
  readonly validationFrom?: string;
  /**
   * Sends the call over the RFC bridge instead of over ADT. Steps run in order
   * and the last one decides the answer.
   */
  readonly rfc?: readonly RfcCall[];
  /** Reads as plain text instead of XML. */
  readonly text?: boolean;
  /** Builds the body from the tool's own arguments (the route cannot express it). */
  readonly bodyOf?: (args: Args) => string;
  /** Media type chosen from the arguments, for tools that offer a result format. */
  readonly acceptOf?: (args: Args) => string | undefined;
  /** Query string appended to a filled path, `?` included, or `""`. */
  readonly queryOf?: (args: Args) => string;
  /**
   * Second endpoint for the same tool: some resources moved between releases (ABAP
   * Unit runs live under `/abapunit/runs` now and under `/abapunit/testruns` before).
   * The primary is tried first; this one when SAP says the path is not a resource or
   * rejects its media type.
   */
  readonly fallback?: {
    readonly path: string;
    readonly accept?: string;
    readonly contentType?: string;
    readonly bodyOf?: (args: Args) => string;
  };
  /**
   * Set when neither the current nor the older endpoint exists on some releases: the
   * tool then answers `NOT_IMPLEMENTED` with this text instead of a bare 404.
   */
  readonly absentBecause?: string;
}

const JSON_XML = "application/xml";
const TEXT = "text/plain";
const ATOM_FEED = "application/atom+xml;type=feed";
const TEXT_ELEMENTS = "application/vnd.sap.adt.textelements.v1+xml";
// Measured: a multi-type Accept, or one carrying `dataname=`, makes the
// nodestructure resource answer 200 with an **empty body**. A single bare media type
// returns the as-xml tree. Do not "improve" this by adding fallbacks.
const NODE_STRUCTURE_ACCEPT = "application/vnd.sap.as+xml";
const NODE_STRUCTURE_CT = "application/vnd.sap.as+xml; charset=UTF-8; dataname=null";
const NODE_STRUCTURE_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">' +
  "<asx:values><DATA><TV_NODEKEY>{node_id}</TV_NODEKEY></DATA></asx:values></asx:abap>";
// Where-used / usage-snippets media types live in `read.ts`, where those tools are parsed.
const VIRTUAL_FOLDERS_ACCEPT = "application/vnd.sap.adt.repository.virtualfolders.result.v1+xml";
const VIRTUAL_FOLDERS_CT = "application/vnd.sap.adt.repository.virtualfolders.request.v1+xml";
const VIRTUAL_FOLDERS_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<vfs:virtualFoldersRequest xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders" objectSearchPattern="*">' +
  "<vfs:facetorder><vfs:facet>package</vfs:facet><vfs:facet>type</vfs:facet></vfs:facetorder></vfs:virtualFoldersRequest>";
const UNIT_TEST_STATUS_ACCEPT = "application/vnd.sap.adt.api.abapunit.run-status.v1+xml";
const UNIT_TEST_RESULT_ACCEPT = "application/vnd.sap.adt.api.abapunit.run-result.v1+xml";
const UNIT_TEST_JUNIT_ACCEPT = "application/vnd.sap.adt.api.junit.run-result.v1+xml";
const UNIT_TEST_RUN_CT = "application/vnd.sap.adt.api.abapunit.run.v2+xml";
/**
 * ABAP Unit runs synchronously on older releases: only `/abapunit/testruns` exists and
 * the answer already carries the result. Both formats are built from the documented
 * `tests` argument, so the fallback is not a second, incompatible request.
 */
const UNIT_TEST_RUN: Route = {
  method: "POST",
  path: "/abapunit/runs",
  accept: JSON_XML,
  contentType: UNIT_TEST_RUN_CT,
  bodyOf: modernUnitTestBody,
  fallback: { path: "/abapunit/testruns", accept: JSON_XML, contentType: JSON_XML, bodyOf: legacyUnitTestBody },
};
const UNIT_TEST_STATUS: Route = {
  path: "/abapunit/runs/{run_id}",
  accept: UNIT_TEST_STATUS_ACCEPT,
  queryOf: (args) => (args.with_long_polling === false ? "" : "?withLongPolling=true"),
  fallback: { path: "/abapunit/testruns/{run_id}", accept: JSON_XML },
  absentBecause:
    "This release runs ABAP Unit synchronously: the run answer already carries the result and hands out no run id, " +
    "so there is nothing to poll. Read the answer of the run tool (POST /abapunit/testruns) instead.",
};
const UNIT_TEST_RESULT: Route = {
  path: "/abapunit/results/{run_id}",
  accept: UNIT_TEST_RESULT_ACCEPT,
  acceptOf: (args) => (args.format === "junit" ? UNIT_TEST_JUNIT_ACCEPT : undefined),
  queryOf: (args) => (args.with_navigation_uris === false ? "?withNavigationUris=false" : ""),
  fallback: { path: "/abapunit/testruns/{run_id}/results", accept: JSON_XML },
  absentBecause:
    "This release has no run-result endpoint: ABAP Unit runs synchronously and the result comes back from the run call. " +
    "Read the answer of the run tool (POST /abapunit/testruns) instead.",
};
// This stack only serves v3; asking for v1 alone is refused with
// "Accepted content types: application/vnd.sap.adt.enhancements.v3+xml".
// The list lives in `read.ts` now (`GetEnhancements` parses the document there).
const TRACE_CALLTREE_ACCEPT = "application/vnd.sap.adt.runtime.traces.abaptraces.aggcalltree+xml, application/xml";
/** Trace ids are `<server>,<timestamp>`; the comma must travel percent-encoded. */
const TRACE_ID: readonly string[] = ["trace_id_or_uri"];
/** The lock verbs answer with an as-xml lock result, not with the object's own type. */
const LOCK_ACCEPT =
  "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, " +
  "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9";
/** Asks the activation endpoint to activate one program by name. */
const ACTIVATION_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/{program_name}" adtcore:name="{program_name}"/>' +
  "</adtcore:objectReferences>";
/** The syntax check takes the object URI in the body; `?_action=CHECK` is not a resource. */
const CHECK_RUN_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<chkrun:checkObject adtcore:uri="{object_uri}" chkrun:version="active"/>' +
  "</chkrun:checkObjectList>";
const ACCEPT_CHECK_MESSAGES = "application/vnd.sap.adt.checkmessages+xml";
const CT_CHECK_OBJECTS = "application/vnd.sap.adt.checkobjects+xml";

/** ADT resource path per object type, as the ADT clients resolve it. */
const OBJECT_PATHS: Readonly<Record<string, string>> = {
  class: "oo/classes",
  "clas/oc": "oo/classes",
  program: "programs/programs",
  "prog/p": "programs/programs",
  include: "programs/includes",
  "prog/i": "programs/includes",
  functiongroup: "functions/groups",
  fugr: "functions/groups",
  "fugr/f": "functions/groups",
  "fugr/ff": "functions/groups",
  "fugr/i": "functions/groups",
  interface: "oo/interfaces",
  "intf/if": "oo/interfaces",
  "intf/oi": "oo/interfaces",
  package: "packages",
  "devc/k": "packages",
  table: "ddic/tables",
  "tabl/dt": "ddic/tables",
  structure: "ddic/structures",
  "stru/dt": "ddic/structures",
  domain: "ddic/domains",
  "doma/dd": "ddic/domains",
  dataelement: "ddic/dataelements",
  dtel: "ddic/dataelements",
  "dtel/de": "ddic/dataelements",
  view: "ddic/ddl/sources",
  "ddls/df": "ddic/ddl/sources",
  serviceDefinition: "ddic/srvd/sources",
  "srvd/srv": "ddic/srvd/sources",
  metadataExtension: "ddic/ddlx/sources",
  "ddlx/ex": "ddic/ddlx/sources",
};

/** ADT resource per `object_type`, for the tools that dispatch by object type. */
const HANDLER_RESOURCES: Readonly<
  Record<
    string,
    {
      readonly segment: string;
      /** Where this family answers a name check, when it is not `{segment}/validation`. */
      readonly validationSegment?: string;
      readonly nameArg: string;
      readonly accept: string;
    }
  >
> = {
  PACKAGE: { segment: "packages", nameArg: "package_name", accept: "application/vnd.sap.adt.packages.v2+xml" },
  DOMAIN: { segment: "ddic/domains", nameArg: "domain_name", accept: "application/vnd.sap.adt.domains.v2+xml" },
  DATA_ELEMENT: {
    segment: "ddic/dataelements",
    nameArg: "data_element_name",
    accept: "application/vnd.sap.adt.dataelements.v2+xml",
  },
  CLASS: { segment: "oo/classes", nameArg: "class_name", accept: "application/vnd.sap.adt.oo.classes.v4+xml" },
  INTERFACE: { segment: "oo/interfaces", nameArg: "interface_name", accept: "application/vnd.sap.adt.oo.interfaces.v5+xml" },
  PROGRAM: {
    segment: "programs/programs",
    validationSegment: "programs",
    nameArg: "program_name",
    accept: "application/vnd.sap.adt.programs.programs.v2+xml",
  },
  TABLE: { segment: "ddic/tables", nameArg: "table_name", accept: "application/vnd.sap.adt.tables.v2+xml" },
  STRUCTURE: { segment: "ddic/structures", nameArg: "structure_name", accept: "application/vnd.sap.adt.structures.v2+xml" },
  VIEW: { segment: "ddic/ddl/sources", nameArg: "view_name", accept: "application/vnd.sap.adt.ddlSource+xml" },
  FUNCTION_GROUP: {
    segment: "functions/groups",
    nameArg: "function_group_name",
    accept: "application/vnd.sap.adt.functions.groups.v2+xml",
  },
  FUNCTION_MODULE: {
    segment: "functions/groups/{function_group_name}/fmodules",
    nameArg: "function_module_name",
    accept: "application/vnd.sap.adt.functions.fmodules+xml",
  },
  METADATA_EXTENSION: {
    segment: "ddic/ddlx/sources",
    nameArg: "metadata_extension_name",
    accept: "application/vnd.sap.adt.ddic.ddlx.v1+xml",
  },
  SERVICE_DEFINITION: {
    segment: "ddic/srvd/sources",
    nameArg: "service_definition_name",
    accept: "application/vnd.sap.adt.ddic.srvd.v1+xml",
  },
  BEHAVIOR_DEFINITION: {
    segment: "behavior/definitions",
    nameArg: "behavior_definition_name",
    accept: "application/vnd.sap.adt.blues.v1+xml",
  },
};

/** ADT type codes accepted in place of the friendly name. */
const HANDLER_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "PROG/P": "PROGRAM",
  "PROG/I": "PROGRAM",
  "CLAS/OC": "CLASS",
  "INTF/OI": "INTERFACE",
  "INTF/IF": "INTERFACE",
  "TABL/DT": "TABLE",
  "STRU/DT": "STRUCTURE",
  "DDLS/DF": "VIEW",
  "DOMA/DD": "DOMAIN",
  "DTEL/DE": "DATA_ELEMENT",
  "DEVC/K": "PACKAGE",
  "FUGR": "FUNCTION_GROUP",
  "FUGR/F": "FUNCTION_GROUP",
  "FUGR/FF": "FUNCTION_MODULE",
  "DDLX/EX": "METADATA_EXTENSION",
  "SRVD/SRV": "SERVICE_DEFINITION",
  "BDEF/BDO": "BEHAVIOR_DEFINITION",
};

/** Resolves the family resource for an `object_type` argument. */
function resourcePath(args: Args, typeArg: string): string {
  const given = (arg(args, typeArg) ?? "").trim().toUpperCase();
  const type = HANDLER_TYPE_ALIASES[given] ?? given;
  const entry = HANDLER_RESOURCES[type];
  if (entry === undefined) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      `Unsupported object_type "${type}". Supported: ${Object.keys(HANDLER_RESOURCES).join(", ")}.`,
    );
  }
  const name = arg(args, entry.nameArg) ?? arg(args, "object_name") ?? arg(args, "name");
  if (name === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `Missing "${entry.nameArg}" for object_type ${type}.`);
  }
  const segment = entry.segment.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = arg(args, key);
    if (value === undefined) {
      throw new GatewayError("INVALID_ARGUMENT", `Missing "${key}" for object_type ${type}.`);
    }
    return encodeURIComponent(lower(value));
  });
  return `/${segment}/${encodeURIComponent(lower(name))}`;
}

/** The family's media type, used when a dispatched route names none of its own. */
function familyAccept(args: Args, typeArg: string): string | undefined {
  const given = (arg(args, typeArg) ?? "").trim().toUpperCase();
  return HANDLER_RESOURCES[HANDLER_TYPE_ALIASES[given] ?? given]?.accept;
}

/** ADT object type code per family, for the requests that want one in a query. */
const HANDLER_TYPE_CODES: Readonly<Record<string, string>> = {
  CLASS: "CLAS/OC",
  INTERFACE: "INTF/OI",
  PROGRAM: "PROG/P",
  TABLE: "TABL/DT",
  STRUCTURE: "STRU/DT",
  VIEW: "DDLS/DF",
  DOMAIN: "DOMA/DD",
  DATA_ELEMENT: "DTEL/DE",
  PACKAGE: "DEVC/K",
  FUNCTION_GROUP: "FUGR/F",
  FUNCTION_MODULE: "FUGR/FF",
  METADATA_EXTENSION: "DDLX/EX",
  SERVICE_DEFINITION: "SRVD/SRV",
  BEHAVIOR_DEFINITION: "BDEF/BDO",
};

/**
 * The name check a family offers before creating an object.
 *
 * Every family publishes `POST <family>/validation?objname=…`; classes are the
 * exception on both counts (`/oo/validation/objectname`, and the package parameter is
 * spelled `packagename`). SAP answers a wrong parameter name with a 400 naming it, so
 * this stays a request-level correction rather than a silent wrong answer.
 */
function validationPath(args: Args, typeArg: string): string {
  const given = (arg(args, typeArg) ?? "").trim().toUpperCase();
  const type = HANDLER_TYPE_ALIASES[given] ?? given;
  const entry = HANDLER_RESOURCES[type];
  if (entry === undefined) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      `Unsupported object_type "${type}". Supported: ${Object.keys(HANDLER_RESOURCES).join(", ")}.`,
    );
  }
  const name = arg(args, entry.nameArg) ?? arg(args, "object_name");
  if (name === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `Missing "${entry.nameArg}" for object_type ${type}.`);
  }
  const query = new URLSearchParams({ objname: name });
  // Several families refuse the check without a description ("description missing" is a 400
  // with no hint that the parameter is the problem); the name is a fair default.
  const description = arg(args, "description") ?? name;
  query.set("description", description);
  const code = HANDLER_TYPE_CODES[type];
  if (code !== undefined) query.set("objtype", code);
  const pkg = arg(args, "package_name") ?? arg(args, "package");
  if (pkg === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `A name check needs "package_name" (object_type ${type}).`);
  }
  // Families disagree on the spelling (`packagename` for classes and programs,
  // `package` for tables); sending both is how one request serves them all.
  query.set("package", pkg);
  query.set("packagename", pkg);
  const base = type === "CLASS" ? "/oo/validation/objectname" : `/${entry.validationSegment ?? entry.segment}/validation`;
  return `${base}?${query.toString()}`;
}

/** The tool names this table owns, for the route probe. */
let registeredRouteNames: readonly string[] = [];
export function routeToolNames(): readonly string[] {
  return registeredRouteNames;
}

/** The subset that goes over the RFC bridge, which the ADT probe cannot reach. */
let bridgedRouteNames: readonly string[] = [];
export function bridgedRouteToolNames(): readonly string[] {
  return bridgedRouteNames;
}

const lower = (value: string): string => value.trim().toLowerCase();
const arg = (args: Args, name: string): string | undefined => {
  const value = args[name];
  // Numbers are legal for every `{placeholder}` that ends up in a query string
  // (`max_rows`, `max_results`, `top`); the schema says number, so accept it here
  // instead of answering a misleading `Missing "max_rows".`
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** Builds the ADT resource URI for an object name/type pair. */
export function objectUri(args: Args, [nameArg, typeArg]: readonly [string, string]): string {
  const name = arg(args, nameArg);
  const type = arg(args, typeArg) ?? arg(args, "objecttype") ?? arg(args, "object_type");
  if (name === undefined || type === undefined) {
    return "";
  }
  const segment = OBJECT_PATHS[type.toLowerCase()] ?? OBJECT_PATHS[type];
  if (segment === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `Unsupported object type "${type}" for a where-used URI.`);
  }
  return `/sap/bc/adt/${segment}/${encodeURIComponent(lower(name))}`;
}

/**
 * Opaque ids travel as one path segment. A full resource URI is accepted for the
 * `_or_uri` arguments, so only the last segment is kept; decoding then re-encoding
 * makes the raw id and the percent-encoded form the feed returns equally valid input.
 */
function opaqueSegment(value: string): string {
  const trimmed = value.trim().split(/[?#]/)[0] ?? "";
  const id = trimmed.split("/").filter((part) => part !== "").pop() ?? trimmed;
  try {
    return encodeURIComponent(decodeURIComponent(id));
  } catch {
    return encodeURIComponent(id);
  }
}

/**
 * Placeholders that are tokens, not names. ADT lower-cases object names in its
 * paths, but these change meaning when folded: a lock handle, a run id, a dump
 * id and a trace id are all case-sensitive.
 */
const CASE_SENSITIVE = new Set([
  "lock_handle",
  "run_id",
  "dump_id",
  "session_id",
  "trace_id_or_uri",
  "object_uri",
  "validation_path",
  // ADT type codes in a query are case-sensitive on this stack: `parent_type=devc%2Fk`
  // answers 200 with an **empty** tree, `DEVC%2FK` answers with the nodes
  // (measured ).
  "parent_type",
  "objecttype",
  "object_type",
]);

/** Values a `{placeholder}` falls back to when the schema marks it optional. */
const PLACEHOLDER_DEFAULTS: Readonly<Record<string, string>> = {
  node_id: "000000",
  max_results: "50",
  max_rows: "20",
};

/** `{}` placeholders are filled from the call arguments, lower-casing object names. */
function fill(path: string | undefined, args: Args, encode: readonly string[] = []): string {
  if (path === undefined) {
    throw new GatewayError("NOT_IMPLEMENTED", "This route has neither a path nor an RFC call.");
  }
  return path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = arg(args, name) ?? PLACEHOLDER_DEFAULTS[name];
    if (value === undefined) {
      throw new GatewayError("INVALID_ARGUMENT", `Missing "${name}".`);
    }
    if (encode.includes(name)) {
      return opaqueSegment(value);
    }
    return CASE_SENSITIVE.has(name) ? value.trim() : lower(value);
  });
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fills `{name}` placeholders in a request body, keeping case and escaping XML. */
function fillBody(body: string, args: Args): string {
  return body.replace(/\{(\w+)\}/g, (_match, name: string) =>
    // `{node_id}` is the root node key in every tree request; without a value the body
    // carries `<TV_NODEKEY></TV_NODEKEY>` and SAP answers 200 with an empty tree
    // (measured: the whole nodestructure family looked "broken").
    escapeXml(arg(args, name) ?? PLACEHOLDER_DEFAULTS[name] ?? ""),
  );
}

const ROUTES: Readonly<Record<string, Route>> = {
  // ---- dumps, traces, profiler -------------------------------------------
  // `RuntimeListDumps` is implemented in `read.ts`: the schema exposes `top` / `skip` /
  // `orderby` / `user` / `include_summary`, which a fixed `$top={max_results}` route ignored.
  // `RuntimeGetDumpById` / `RuntimeAnalyzeDump` / `HandlerDumpView` are implemented in
  // `read.ts`: their `view` / `response_mode` / `chapters` arguments need the structured
  // dump resource, which a fixed `/formatted` route could not honour (it answered the full
  // long text — 166 KB measured — for every mode).
  // `RuntimeListProfilerTraceFiles` is implemented in `profiler.ts`: the feed is 564 KB of XML
  // and its description promises a parsed payload, so the route would only flood the caller.
  RuntimeListFeeds: { path: "/feeds", accept: ATOM_FEED },
  RuntimeListSystemMessages: { path: "/runtime/systemmessages", accept: ATOM_FEED },
  RuntimeGetGatewayErrorLog: { path: "/gw/errorlog", accept: ATOM_FEED },

  // ---- where-used, type info, usage --------------------------------------
  // `GetWhereUsed` / `GetUsageSnippets` are implemented in `read.ts` (parsed
  // `references[]` / `snippets[]`, and `object_identifiers` actually used).

  // ---- program composition ----------------------------------------------
  // `GetProgFullCode` is implemented in `read.ts`: it assembles the program **and its
  // includes** (the tree, then `D010INC`), which a single `source/main` route cannot do.
  GetIncludesList: {
    method: "POST",
    path: "/repository/nodestructure?parent_type={object_type}&parent_name={object_name}&parent_tech_name={object_name}&withShortDescriptions=true&node_id=000000",
    accept: NODE_STRUCTURE_ACCEPT,
    contentType: NODE_STRUCTURE_CT,
    body: NODE_STRUCTURE_BODY,
  },

  // ---- unit tests --------------------------------------------------------
  RunUnitTest: UNIT_TEST_RUN,
  GetUnitTestStatus: UNIT_TEST_STATUS,
  GetUnitTestResult: UNIT_TEST_RESULT,
  GetUnitTest: UNIT_TEST_STATUS,
  CreateUnitTest: UNIT_TEST_RUN,
  UpdateUnitTest: { method: "PUT", path: "/abapunit/runs/{run_id}", accept: JSON_XML, contentType: JSON_XML, bodyFrom: "body" },
  DeleteUnitTest: { method: "DELETE", path: "/abapunit/runs/{run_id}", accept: JSON_XML },

  // ---- class-local members ----------------------------------------------
  GetLocalDefinitions: { path: "/oo/classes/{class_name}/includes/definitions", accept: TEXT, text: true },
  GetLocalMacros: { path: "/oo/classes/{class_name}/includes/macros", accept: TEXT, text: true },
  GetLocalTestClass: { path: "/oo/classes/{class_name}/includes/testclasses", accept: TEXT, text: true },
  // ADT has no `includes/types` (400 "URI-Mapping cannot be performed due to invalid URI"):
  // local types are written to the implementations include, so they are read from there too.
  GetLocalTypes: { path: "/oo/classes/{class_name}/includes/implementations", accept: TEXT, text: true },
  // The `Update*` and `Delete*` halves of this family need a lock, and a delete is an empty
  // PUT (ADT answers 405 to DELETE on an include) — those live in `bridges.ts`.

  // ---- screens and GUI status (RFC bridge) -------------------------------
  // Dynpros and the CUA have no ADT resource; they go through the dispatcher
  // function module. The locks, though, are plain ADT locks on the *program*.
  GetScreen: { rfc: [{ action: "DYNPRO_READ", params: { program: "program_name", dynpro: "screen_number" } }] },
  ReadScreen: { rfc: [{ action: "DYNPRO_READ", params: { program: "program_name", dynpro: "screen_number" } }] },
  CreateScreen: {
    rfc: [
      {
        action: "DYNPRO_INSERT",
        params: { program: "program_name", dynpro: "screen_number", dynpro_data: "dynpro_data" },
      },
    ],
  },
  UpdateScreen: {
    rfc: [
      { action: "DYNPRO_DELETE", params: { program: "program_name", dynpro: "screen_number" } },
      {
        action: "DYNPRO_INSERT",
        params: { program: "program_name", dynpro: "screen_number", dynpro_data: "dynpro_data" },
      },
    ],
  },
  DeleteScreen: { rfc: [{ action: "DYNPRO_DELETE", params: { program: "program_name", dynpro: "screen_number" } }] },
  // `GetScreensList` is implemented in `read.ts`: ADT has no dynpro-list resource and
  // the bridge has no LIST action, so the list comes from `D020S`.
  // `GetGuiStatus` is implemented in `read.ts`: the schema advertises `status_name` /
  // `function_codes` / `format`, which a raw bridge call cannot honour.
  GetGuiStatusList: { rfc: [{ action: "CUA_FETCH", params: { program: "program_name" } }] },
  ReadGuiStatus: { rfc: [{ action: "CUA_FETCH", params: { program: "program_name" } }] },
  UpdateGuiStatus: {
    rfc: [
      { action: "CUA_FETCH", params: { program: "program_name" } },
      { action: "CUA_WRITE", params: { program: "program_name", cua_data: "cua_data" } },
    ],
  },
  // Create / Patch / Delete compute the new document, so they live in
  // `src/tools/bridges.ts` rather than in this table.

  // ---- text elements -----------------------------------------------------
  GetTextElement: { path: "/textelements/programs/{program_name}", accept: TEXT_ELEMENTS },
  UpdateTextElement: { method: "PUT", path: "/textelements/programs/{program_name}", accept: TEXT_ELEMENTS, contentType: TEXT_ELEMENTS, bodyFrom: "text_elements" },
  CreateTextElement: { method: "POST", path: "/textelements/programs/{program_name}", accept: TEXT_ELEMENTS, contentType: TEXT_ELEMENTS, bodyFrom: "text_elements" },
  DeleteTextElement: { method: "DELETE", path: "/textelements/programs/{program_name}", accept: TEXT_ELEMENTS },

  // ---- transports --------------------------------------------------------
  CreateTransport: { method: "POST", path: "/cts/transportrequests", accept: JSON_XML, contentType: JSON_XML, bodyFrom: "body" },

  // ---- repository navigation --------------------------------------------
  GetPackageTree: { method: "POST", path: "/repository/nodestructure?parent_type=DEVC%2FK&parent_name={package_name}&parent_tech_name={package_name}&withShortDescriptions=true&node_id=000000", accept: NODE_STRUCTURE_ACCEPT, contentType: NODE_STRUCTURE_CT, body: NODE_STRUCTURE_BODY },
  GetObjectsByType: { method: "POST", path: "/repository/nodestructure?parent_type={parent_type}&parent_name={parent_name}&parent_tech_name={parent_tech_name}&withShortDescriptions=true&node_id={node_id}", accept: NODE_STRUCTURE_ACCEPT, contentType: NODE_STRUCTURE_CT, body: NODE_STRUCTURE_BODY },
  GetObjectsList: { method: "POST", path: "/repository/nodestructure?parent_type={parent_type}&parent_name={parent_name}&parent_tech_name={parent_tech_name}&withShortDescriptions=true&node_id=000000", accept: NODE_STRUCTURE_ACCEPT, contentType: NODE_STRUCTURE_CT, body: NODE_STRUCTURE_BODY },
  GetObjectStructure: { method: "POST", path: "/repository/nodestructure?parent_type={objecttype}&parent_name={objectname}&parent_tech_name={objectname}&withShortDescriptions=true&node_id=000000", accept: NODE_STRUCTURE_ACCEPT, contentType: NODE_STRUCTURE_CT, body: NODE_STRUCTURE_BODY },
  GetNodeStructureLow: { method: "POST", path: "/repository/nodestructure?parent_type={parent_type}&parent_name={parent_name}&parent_tech_name={parent_name}&withShortDescriptions=true&node_id={node_id}", accept: NODE_STRUCTURE_ACCEPT, contentType: NODE_STRUCTURE_CT, body: NODE_STRUCTURE_BODY },

  // ---- object-level helpers ---------------------------------------------
  ActivateObjects: { method: "POST", path: "/activation?method=activate&preauditRequested=false", accept: JSON_XML, contentType: "application/vnd.sap.adt.activation+xml", bodyOf: activationBody },
  GetObjectInfo: {
    method: "POST",
    path: "/repository/nodestructure?parent_type={parent_type}&parent_name={parent_name}&parent_tech_name={parent_name}&withShortDescriptions=true&node_id=000000",
    accept: NODE_STRUCTURE_ACCEPT,
    contentType: NODE_STRUCTURE_CT,
    body: NODE_STRUCTURE_BODY,
  },
  // `GetAdtTypes` is implemented in `read.ts`: the discovery document is a 400 KB service
  // catalogue, and `validate_type` is a real search call that SAP validates.
  // `GetAbapSystemSymbols`, `GetAbapAST` and `GetAbapSemanticAnalysis` are computed from the
  // ABAP source text with a real parser in `src/tools/abap-analysis.ts` — ADT has no AST
  // endpoint, and a route can only fill one path anyway.
  DescribeByList: { path: "/repository/informationsystem/search?operation=quickSearch&query={name}&maxResults={max_results}", accept: JSON_XML },
  GetTypeInfo: { path: "/ddic/dataelements/{type_name}", accept: "application/vnd.sap.adt.dataelements.v2+xml" },
  // `GetUsageSnippets` is implemented in `read.ts`.
  // `GetTransaction` is implemented in `read.ts`: the contract takes a list
  // (`transaction_names`) and the route table can only fill one path.
  // Both are served by the ECC workload bridge, which has no ADT resource and is
  // not installed here.
  GetVirtualFoldersLow: {
    method: "POST",
    path: "/repository/informationsystem/virtualfolders/contents",
    accept: VIRTUAL_FOLDERS_ACCEPT,
    contentType: VIRTUAL_FOLDERS_CT,
    body: VIRTUAL_FOLDERS_BODY,
  },
  // `ReloadProfile` is implemented in `read.ts`: it re-reads this gateway's own
  // configuration and restarts the sessions, so it needs no SAP resource and no row here.

  // ---- unit-test style runners on classes -------------------------------
  RunClassUnitTestsLow: UNIT_TEST_RUN,
  GetClassUnitTestStatusLow: UNIT_TEST_STATUS,
  GetClassUnitTestResultLow: UNIT_TEST_RESULT,

  // ---- CDS unit tests ----------------------------------------------------
  CreateCdsUnitTest: { method: "POST", path: "/oo/classes?objtype=CLAS%2FOC&package={package_name}", accept: JSON_XML, contentType: "application/vnd.sap.adt.oo.classes.v4+xml", bodyFrom: "body" },
  // `UpdateCdsUnitTest` / `DeleteCdsUnitTest` need a lock (write) or the deletion
  // framework (delete), so they live in `bridges.ts`.
  GetCdsUnitTest: UNIT_TEST_STATUS,
  GetCdsUnitTestStatus: UNIT_TEST_STATUS,
  GetCdsUnitTestResult: UNIT_TEST_RESULT,

  // ---- enhancements, services, smartforms --------------------------------
  // `GetEnhancements` and `GetEnhancementSpot` are implemented in `read.ts`: the first decodes the
  // base64 `<enh:source>` of every implementation, the second parses the spot document (package,
  // tool type, usages, BAdI definitions) instead of handing over the XML.
  // `{spot}` is the enhancement type (`enhoxhh` for a source-code plugin) or a spot
  // name; only source-code plugins carry `source/main`.
  GetEnhancementImpl: {
    path: "/enhancements/{enhancement_spot}/{enhancement_name}/source/main",
    accept: "application/xml, text/plain",
  },
  // Implemented by `read.ts` from the classic BAdI tables (SXC_EXIT / SXS_ATTR +
  // TADIR): the ECC bridge this used to need does not exist on this stack.
  // `ListServiceBindingTypes` / `HandlerServiceBindingListTypes` are implemented in
  // `read.ts`: `response_format` needs the parsed named-item list, which a fixed route
  // could not produce.
  // SmartForm content / layout / create / delete / render live in `src/tools/smartforms.ts`:
  // they need the ZMCP_SSF_* bridge, which is a call plus XML work, not a route.
};

/**
 * Low-level variants that only differ by the extra `lock_handle` / `_action`.
 *
 * A `*Low` verb is the same route as its high-level sibling, with the handle the
 * caller obtained from `Lock*Low` — so they are generated instead of listed.
 */
function lowVariants(): Record<string, Route> {
  const generated: Record<string, Route> = {};
  const resources: ReadonlyArray<readonly [string, string]> = [
    // low verb suffix, base path (placeholders filled from the arguments)
    ["Transport", "/cts/transportrequests/{transport_number}"],
  ];

  for (const [suffix, base] of resources) {
    generated[`Lock${suffix}Low`] = {
      method: "POST",
      path: `${base}?_action=LOCK&accessMode=MODIFY`,
      accept: JSON_XML,
    };
    generated[`Unlock${suffix}Low`] = {
      method: "POST",
      path: `${base}?_action=UNLOCK&lockHandle={lock_handle}`,
      accept: JSON_XML,
    };
    generated[`Activate${suffix}Low`] = {
      method: "POST",
      path: `${base}?_action=ACTIVATE`,
      accept: JSON_XML,
    };
    generated[`Check${suffix}Low`] = {
      method: "POST",
      path: `${base}?_action=CHECK`,
      accept: JSON_XML,
    };
    generated[`Delete${suffix}Low`] = {
      method: "DELETE",
      path: `${base}?lockHandle={lock_handle}`,
      accept: JSON_XML,
    };
    generated[`Create${suffix}Low`] = {
      method: "POST",
      path: base,
      accept: JSON_XML,
      contentType: JSON_XML,
      bodyFrom: "body",
    };
  }

  // The `*Object*` verbs take an `object_type`, so their resource is resolved per
  // type — `/object/{name}` is not an ADT resource at all.
  const objectVerbs: ReadonlyArray<readonly [string, Route]> = [
    ["LockObjectLow", { method: "POST", path: "{resource}?_action=LOCK&accessMode=MODIFY", accept: LOCK_ACCEPT }],
    [
      "UnlockObjectLow",
      { method: "POST", path: "{resource}?_action=UNLOCK&lockHandle={lock_handle}", accept: LOCK_ACCEPT },
    ],
    // `ActivateObjectLow` takes the documented `objects` array; the old row built a single
    // reference from `object_name`/`object_type`, which this tool does not have, and SAP
    // answered "condition check failed" for the empty URI.
    [
      "ActivateObjectLow",
      {
        method: "POST",
        path: "/activation?method=activate&preauditRequested=true",
        accept: JSON_XML,
        contentType: "application/vnd.sap.adt.activation+xml",
        bodyOf: (args) => activationBody(args, "ActivateObjectLow"),
      },
    ],
    ["CheckObjectLow", { method: "POST", path: "/checkruns?reporters=abapCheckRun", accept: ACCEPT_CHECK_MESSAGES, contentType: CT_CHECK_OBJECTS, body: CHECK_RUN_BODY, uriFrom: ["object_name", "object_type"] }],
    ["DeleteObjectLow", { method: "DELETE", path: "{resource}?lockHandle={lock_handle}", accept: JSON_XML }],
    ["ValidateObjectLow", { method: "POST", path: "{validation_path}", accept: "application/vnd.sap.as+xml", contentType: "application/vnd.sap.as+xml", validationFrom: "object_type" }],
  ];
  for (const [tool, route] of objectVerbs) {
    // The verbs that already carry their own URI take it from the body instead.
    // A route that builds its own body (or pulls a URI from one) needs no `{resource}` from
    // `object_type`: `ActivateObjectLow` takes the documented `objects` array.
    const dispatched = route.validationFrom !== undefined || route.uriFrom !== undefined || route.bodyOf !== undefined;
    generated[tool] = dispatched ? route : { ...route, resourceFrom: "object_type" };
  }

  // Remaining singletons whose route is the same shape with a different path.
  // `ActivateClassTestClassesLow` is an activation of the class, which no
  // `?_action` on the include resource does — it lives in `bridges.ts`.
  generated["LockClassTestClassesLow"] = {
    method: "POST",
    path: "/oo/classes/{class_name}/includes/testclasses?_action=LOCK&accessMode=MODIFY",
    accept: JSON_XML,
  };
  generated["UnlockClassTestClassesLow"] = {
    method: "POST",
    path: "/oo/classes/{class_name}/includes/testclasses?_action=UNLOCK&lockHandle={lock_handle}",
    accept: JSON_XML,
  };
  generated["UpdateClassTestClassesLow"] = {
    method: "PUT",
    path: "/oo/classes/{class_name}/includes/testclasses?lockHandle={lock_handle}",
    accept: TEXT,
    contentType: TEXT,
    // The contract spells the body `test_class_source` (measured live: with
    // `bodyFrom: "test_class_code"` the PUT carried an empty body and SAP answered
    // `Not found: Resource CLASS_INCLUDE ZCL_MCP_T01 does not exist`, which says nothing
    // about the argument that was actually missing).
    bodyFrom: "test_class_source",
  };
  generated["CreateTransportLow"] = {
    method: "POST",
    path: "/cts/transportrequests",
    accept: JSON_XML,
    contentType: JSON_XML,
    bodyFrom: "body",
  };
  // ADT advertises `/businessservices/bindings/validation` but accepts no media type
  // for it (the answer is 415 even for the type it names). The archived client never
  // called it either: its pre-create check reads the binding types and then runs the
  // CTS transport check. Until that is implemented, say so instead of sending a body
  // SAP cannot parse.
  const serviceBindingValidationUnsupported =
    "ADT has no usable validation resource for service bindings (its advertised " +
    "/businessservices/bindings/validation rejects every content type with 415). " +
    "Check the binding by creating it in a transport-enabled package, or read the binding " +
    "types with ListServiceBindingTypes and run the CTS transport check for the package.";
  generated["ValidateServiceBinding"] = { unsupported: serviceBindingValidationUnsupported };
  generated["HandlerServiceBindingValidate"] = { unsupported: serviceBindingValidationUnsupported };

  // The `Handler*` tools are the same operations under their handler names; the
  // contract keeps both spellings, so they share a route. The generic ones
  // dispatch to whichever family `object_type` names.
  const dispatched = (method: "GET" | "POST" | "PUT" | "DELETE", suffix: string): Route => ({
    method,
    path: `{resource}${suffix}`,
    resourceFrom: "object_type",
  });
  generated["HandlerGet"] = dispatched("GET", "");
  generated["HandlerCreate"] = {
    method: "POST",
    path: "{resource}",
    accept: JSON_XML,
    contentType: JSON_XML,
    bodyFrom: "body",
    resourceFrom: "object_type",
  };
  generated["HandlerUpdate"] = {
    method: "PUT",
    path: "{resource}?lockHandle={lock_handle}",
    accept: JSON_XML,
    contentType: JSON_XML,
    bodyFrom: "body",
    resourceFrom: "object_type",
  };
  generated["HandlerDelete"] = dispatched("DELETE", "?lockHandle={lock_handle}");
  // A lock answers with the as-xml lock result, never with the object's own type.
  generated["HandlerLock"] = { ...dispatched("POST", "?_action=LOCK&accessMode=MODIFY"), accept: LOCK_ACCEPT };
  generated["HandlerUnlock"] = { ...dispatched("POST", "?_action=UNLOCK&lockHandle={lock_handle}"), accept: LOCK_ACCEPT };
  // Validation has no single endpoint shape across families, so it targets the
  // family resource and lets SAP say what it does not like.
  generated["HandlerValidate"] = dispatched("POST", "?_action=VALIDATE");
  generated["HandlerActivate"] = { method: "POST", path: "/activation?method=activate&preauditRequested=false", accept: JSON_XML, contentType: "application/vnd.sap.adt.activation+xml", bodyFrom: "body" };
  generated["HandlerCheckRun"] = { method: "POST", path: "/checkruns?reporters=abapCheckRun", accept: "application/vnd.sap.adt.checkmessages+xml", contentType: "application/vnd.sap.adt.checkobjects+xml", bodyFrom: "body" };
  generated["HandlerDumpList"] = { path: "/runtime/dumps?$top={max_results}", accept: ATOM_FEED };
  // `HandlerDumpView` is implemented in `read.ts`: its `view` argument selects the structured
  // resource, which this fixed `/formatted` route ignored.
  generated["HandlerProfileList"] = { path: "/runtime/traces/abaptraces", accept: ATOM_FEED };
  generated["HandlerProfileRun"] = { method: "POST", path: "/runtime/traces/abaptraces/requests", accept: JSON_XML, contentType: JSON_XML, bodyFrom: "body" };
  generated["HandlerProfileView"] = {
    path: "/runtime/traces/abaptraces/{trace_id_or_uri}/hitlist",
    accept: JSON_XML,
    encode: TRACE_ID,
  };
  generated["HandlerTransportCreate"] = { method: "POST", path: "/cts/transportrequests", accept: JSON_XML, contentType: JSON_XML, bodyFrom: "body" };
  generated["HandlerUnitTestRun"] = UNIT_TEST_RUN;
  generated["HandlerUnitTestStatus"] = UNIT_TEST_STATUS;
  generated["HandlerUnitTestResult"] = UNIT_TEST_RESULT;
  generated["HandlerCdsUnitTestStatus"] = UNIT_TEST_STATUS;
  generated["HandlerCdsUnitTestResult"] = UNIT_TEST_RESULT;

  // Screen and GUI status read/write pairs that need no computation.
  generated["ReadScreen"] = {
    rfc: [{ action: "DYNPRO_READ", params: { program: "program_name", dynpro: "screen_number" } }],
  };
  generated["ReadGuiStatus"] = { rfc: [{ action: "CUA_FETCH", params: { program: "program_name" } }] };

  // Screens and GUI status: the lock belongs to the program, the payload to the
  // bridge, and activating either one is an activation of that program.
  for (const suffix of ["Screen", "GuiStatus"]) {
    generated[`Lock${suffix}Low`] = {
      method: "POST",
      path: "/programs/programs/{program_name}?_action=LOCK&accessMode=MODIFY",
      accept: LOCK_ACCEPT,
    };
    generated[`Unlock${suffix}Low`] = {
      method: "POST",
      path: "/programs/programs/{program_name}?_action=UNLOCK&lockHandle={lock_handle}",
      accept: LOCK_ACCEPT,
    };
    generated[`Activate${suffix}Low`] = {
      method: "POST",
      path: "/activation?method=activate&preauditRequested=true",
      accept: JSON_XML,
      contentType: "application/vnd.sap.adt.activation+xml",
      body: ACTIVATION_BODY,
    };
  }
  generated["CreateScreenLow"] = {
    rfc: [
      {
        action: "DYNPRO_INSERT",
        params: { program: "program_name", dynpro: "screen_number", dynpro_data: "dynpro_data" },
      },
    ],
  };
  generated["UpdateScreenLow"] = {
    rfc: [
      { action: "DYNPRO_DELETE", params: { program: "program_name", dynpro: "screen_number" } },
      {
        action: "DYNPRO_INSERT",
        params: { program: "program_name", dynpro: "screen_number", dynpro_data: "dynpro_data" },
      },
    ],
  };
  generated["DeleteScreenLow"] = {
    rfc: [{ action: "DYNPRO_DELETE", params: { program: "program_name", dynpro: "screen_number" } }],
  };
  generated["UpdateGuiStatusLow"] = {
    rfc: [
      { action: "CUA_FETCH", params: { program: "program_name" } },
      { action: "CUA_WRITE", params: { program: "program_name", cua_data: "cua_data" } },
    ],
  };

  // Text elements, in bulk.
  generated["ReadTextElementsBulk"] = { path: "/textelements/programs/{program_name}", accept: TEXT_ELEMENTS };
  generated["WriteTextElementsBulk"] = { method: "PUT", path: "/textelements/programs/{program_name}", accept: TEXT_ELEMENTS, contentType: TEXT_ELEMENTS, bodyFrom: "text_elements" };

  // Read-only analysis.
  // Measured: the query parameter is `ddicEntityName`, not `tableName` —
  // with `tableName` SAP answers 400 "Parameter ddicEntityName could not be found".
  generated["GetTableContents"] = { method: "POST", path: "/datapreview/ddic?rowNumber={max_rows}&ddicEntityName={table_name}", accept: "application/vnd.sap.adt.datapreview.table.v1+xml", contentType: "text/plain" };
  generated["GetPackageContents"] = { method: "POST", path: "/repository/nodestructure?parent_type=DEVC%2FK&parent_name={package_name}&parent_tech_name={package_name}&withShortDescriptions=true&node_id=000000", accept: NODE_STRUCTURE_ACCEPT, contentType: NODE_STRUCTURE_CT, body: NODE_STRUCTURE_BODY };
  // `GetObjectStructureLow` is implemented in `read.ts`: the root node answers only the category
  // list, so the tool expands each category itself instead of returning an empty tree.
  generated["GetObjectNodeFromCache"] = {
    method: "POST",
    path: "/repository/nodestructure?parent_type={object_type}&parent_name={object_name}&parent_tech_name={tech_name}&withShortDescriptions=true&node_id=000000",
    accept: NODE_STRUCTURE_ACCEPT,
    contentType: NODE_STRUCTURE_CT,
    body: NODE_STRUCTURE_BODY,
  };
  // `GetAbapAST` and `GetAbapSemanticAnalysis` parse the source with `@abaplint/core` in
  // `src/tools/abap-analysis.ts`: there is no ADT resource that returns a syntax tree.
  // Profiler.
  generated["RuntimeCreateProfilerTraceParameters"] = { method: "POST", path: "/runtime/traces/abaptraces/parameters", accept: JSON_XML, contentType: JSON_XML, bodyFrom: "body" };
  generated["RuntimeGetProfilerTraceData"] = {
    path: "/runtime/traces/abaptraces/{trace_id_or_uri}/hitlist",
    accept: JSON_XML,
    encode: TRACE_ID,
  };
  generated["RuntimeAnalyzeProfilerTrace"] = {
    path: "/runtime/traces/abaptraces/{trace_id_or_uri}/statements",
    accept: TRACE_CALLTREE_ACCEPT,
    encode: TRACE_ID,
  };
  generated["RuntimeRunProgramWithProfiling"] = { method: "POST", path: "/runtime/traces/abaptraces/requests?objectType=PROG/P&objectName={program_name}", accept: JSON_XML };
  generated["RuntimeRunClassWithProfiling"] = { method: "POST", path: "/runtime/traces/abaptraces/requests?objectType=CLAS/OC&objectName={class_name}", accept: JSON_XML };
  return generated;
}

/**
 * The trace id of a profiler answer.
 *
 * A profiler run answers an Atom feed that names the trace only inside itself, as
 * `/sap/bc/adt/runtime/traces/abaptraces/requests/90%2c20261104114752` — comma encoded,
 * which is why it is decoded here (`{trace_id_or_uri}` encodes it again on the way out).
 * Without it the hit list and the analysis could not be reached at all.
 */
export function traceIdOf(body: string): string {
  const parsed = parseXml(body);
  const node = parsed === undefined ? undefined : findElements(parsed, "id")[0];
  const id = node === undefined ? "" : nodeTextOf(node);
  if (id.length === 0) return "";
  const tail = id.split("/").filter((part) => part.length > 0).pop() ?? "";
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/**
 * `ActivateObjects` takes a list of objects, not a prepared document.
 *
 * The body SAP wants is `<adtcore:objectReferences>` with one reference per object; a
 * function module needs its group in the URI, and the type decides the collection. Sending
 * nothing (what this tool effectively did) answers 400 "expected element objectReferences",
 * which reads like a malformed request rather than a missing body.
 */
export function activationBody(args: Args, tool = "ActivateObjects"): string {
  const list = Array.isArray(args["objects"]) ? args["objects"] : [];
  if (list.length === 0) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool} needs "objects": at least one entry.`);
  }
  const references = list.map((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = String(entry["name"] ?? "").toUpperCase();
    if (name.length === 0) {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: an entry has no name.`);
    }
    const explicit = typeof entry["uri"] === "string" ? entry["uri"] : undefined;
    const type = typeof entry["type"] === "string" ? entry["type"] : "";
    let uri = explicit;
    if (uri === undefined) {
      const segment = OBJECT_PATHS[type.toLowerCase()] ?? OBJECT_PATHS[type];
      if (segment === undefined) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          `${tool}: unsupported type "${type}" for ${name}. Pass "uri" instead.`,
        );
      }
      // A function module lives below its group, not beside it.
      const parent = typeof entry["parent_name"] === "string" ? entry["parent_name"].toLowerCase() : "";
      uri =
        (type.toUpperCase() === "FUGR/FF" || type.toUpperCase() === "FUGR/I") && parent.length > 0
          ? `/sap/bc/adt/${segment}/${encodeURIComponent(parent)}/fmodules/${encodeURIComponent(name.toLowerCase())}`
          : `/sap/bc/adt/${segment}/${encodeURIComponent(name.toLowerCase())}`;
    }
    const escapedUri = uri.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const escapedName = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const typeAttribute = type.length === 0 ? "" : ` adtcore:type="${type}"`;
    return `<adtcore:objectReference adtcore:uri="${escapedUri}"${typeAttribute} adtcore:name="${escapedName}"/>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    references.join("") +
    "</adtcore:objectReferences>"
  );
}

/**
 * SAP's "the object is locked / currently being edited" answer.
 *
 * Not a bad request: the enqueue belongs to the session that ran the previous step, so the
 * same request in a fresh session is accepted. Measured after an RFC screen
 * delete and after every package write.
 */
function isLockConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const sapText = (error as { sapText?: string } | undefined)?.sapText ?? "";
  // Lock conflicts are matched in the logon language (this system answers in Chinese).
  return /is locked|已锁定|currently edit|当前编辑/i.test(`${text} ${sapText}`);
}

/**
 * Fills `dynpro_data` for a screen write.
 *
 * The contract advertises it as optional, but the dispatcher's `DYNPRO_INSERT` refuses an
 * empty one (`DYNPRO_DATA is required`). Measured on a report program, three
 * payloads: a minimal header alone answered `RPY_DYNPRO_INSERT sy-subrc=8`, and so did the
 * header plus the `SCREEN` container; the same document **with the two PROCESS blocks in
 * its flow logic** inserted cleanly (`subrc=0`). Header component names come from a real
 * `DYNPRO_READ` answer (`SAPLKKBL/0500`) — they are `PROGRAM`/`SCREEN`, not `DYNPRO`/`DYNNR`.
 */
function screenDefaults(args: Args, writing: boolean): Args {
  if (args["screen_number"] === undefined || args["dynpro_data"] !== undefined || !writing) return args;
  const program = String(args["program_name"] ?? "").toUpperCase();
  const dynpro = String(args["screen_number"] ?? "").padStart(4, "0");
  const description = String(args["description"] ?? `Screen ${dynpro}`).slice(0, 60);
  return {
    ...args,
    dynpro_data: JSON.stringify({
      HEADER: {
        PROGRAM: program,
        SCREEN: dynpro,
        LANGUAGE: "E",
        DESCRIPT: description,
        TYPE: "N",
        NEXTSCREEN: dynpro,
        LINES: 21,
        COLUMNS: 83,
      },
      CONTAINERS: [{ TYPE: "SCREEN", NAME: "SCREEN" }],
      FIELDS_TO_CONTAINERS: [],
      FLOW_LOGIC: [{ LINE: "PROCESS BEFORE OUTPUT." }, { LINE: "PROCESS AFTER INPUT." }],
    }),
  };
}

/**
 * The route table as it will be registered.
 *
 * Exported so a test can check every `{placeholder}` and every `bodyFrom` against the
 * contract's own argument list — measured live: `UpdateClassTestClassesLow`
 * read its body from `test_class_code` while the contract calls that argument
 * `test_class_source`, so the PUT went out empty and SAP answered a confusing
 * "Resource CLASS_INCLUDE … does not exist".
 */
export function routeTable(): Readonly<Record<string, Route>> {
  return { ...ROUTES, ...lowVariants() };
}

export function registerTableToolRoutes(registry: ToolRegistry, runtime: GatewayRuntime): void {
  const routes: Record<string, Route> = { ...routeTable() };
  // Only the rows the contract knows become handlers, and nothing the bridge
  // module already implemented — registering twice is a programming error.
  const owns = (tool: string): boolean =>
    registry.has(tool) && !BRIDGE_TOOL_NAMES.has(tool) && !registry.hasHandler(tool);
  registeredRouteNames = Object.keys(routes).filter((tool) => owns(tool));
  bridgedRouteNames = registeredRouteNames.filter((tool) => routes[tool]?.rfc !== undefined);
  /** Any verb that is not a plain GET changes the system. */
  const routeWrites = (route: Route): boolean =>
    (route.method ?? "GET") !== "GET" ||
    // `insert`/`delete` are the dispatcher's own names for the dynpro and CUA writes, so a
    // `DYNPRO_INSERT` route used to count as a read: no default payload was filled in, and a
    // read-only tier accepted it. The verb sits behind the resource name (`DYNPRO_INSERT`,
    // `CUA_WRITE`), so the suffix counts as well as the prefix.
    (route.rfc ?? []).some((step) => /(^|_)(create|update|delete|patch|activate|set|reset|insert|add|remove|write|lock|unlock)$/i.test(step.action));
  for (const [tool, route] of Object.entries(routes)) {
    if (!owns(tool)) continue;
    // Skip anything a family or the read-only module already owns.
    registry.register(tool, async (args: Args, ctx) => {
      if (route.unsupported !== undefined) {
        throw new GatewayError("NOT_IMPLEMENTED", route.unsupported);
      }
      // The tier boundary is decided here, not by the name of the tool: a route whose
      // method writes must be treated as a write, or a read-only system accepts it.
      const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), routeWrites(route));
      const writes = routeWrites(route);
      const effective =
        route.validationFrom !== undefined
          ? { ...args, validation_path: validationPath(args, route.validationFrom) }
          : route.uriFrom === undefined
          ? screenDefaults(args, writes)
          : (() => {
              const uri = arg(args, "object_uri") ?? objectUri(args, route.uriFrom);
              return {
                ...screenDefaults(args, writes),
                object_uri: uri,
                object_uri_encoded: encodeURIComponent(uri),
                object_path: uri.replace(/^\/sap\/bc\/adt/, ""),
              };
            })();
      const path =
        route.rfc !== undefined
          ? ""
          : route.resourceFrom === undefined
            ? fill(route.path, effective, route.encode)
            : fill(
                route.path,
                { ...effective, resource: resourcePath(args, route.resourceFrom) },
                route.encode,
              );

      if (route.rfc !== undefined) {
        const bridge = new RfcBridge(resolved.session);
        const steps = [];
        let last: { subrc: number; message: string; result: unknown } = { subrc: 0, message: "", result: undefined };
        for (const step of route.rfc) {
          const params: Record<string, unknown> = {};
          for (const [paramName, argName] of Object.entries(step.params)) {
            // `effective`, not `args`: screen writes get their `dynpro_data` default there.
            const value = arg(effective, argName);
            if (value === undefined) continue;
            // The dispatcher takes the payload as text; a caller that read a screen or a CUA gets
            // an object back now, so it is serialised here instead of asking every caller to do it.
            params[paramName] = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
          }
          last = await bridge.dispatch(step.action, params);
          steps.push({ action: step.action, subrc: last.subrc, message: last.message });
        }
        // The dispatcher returns its payload as an XML-escaped JSON string (`&#34;HEADER&#34;…`),
        // which a caller cannot use: read it back as an object. Measured — ReadScreen
        // answered `&#34;HEADER&#34;:…`, and feeding that to UpdateScreen failed with subrc=5.
        let result = last.result;
        if (typeof result === "string") {
          const decoded = decodeXmlEntities(result);
          try {
            const parsed: unknown = JSON.parse(decoded);
            result = parsed;
          } catch {
            result = decoded;
          }
        }
        return {
          success: true,
          transport: "rfc",
          steps,
          result,
          session_id: resolved.sessionId,
        };
      }

      const body =
        route.bodyOf !== undefined
          ? route.bodyOf(effective)
          : route.bodyFrom !== undefined
            ? arg(args, route.bodyFrom)
            : route.body === undefined
              ? undefined
              : fillBody(route.body, effective);
      const query = route.queryOf === undefined ? "" : route.queryOf(effective);
      const accept =
        route.acceptOf?.(args) ??
        route.accept ??
        (route.resourceFrom === undefined ? JSON_XML : (familyAccept(args, route.resourceFrom) ?? JSON_XML));
      const send = async (spec: {
        path: string;
        accept: string;
        contentType?: string;
        body?: string;
      }): Promise<Awaited<ReturnType<typeof resolved.session.request>>> =>
        resolved.session.request({
          method: route.method ?? "GET",
          path: `${spec.path}${query}`,
          accept: spec.accept,
          ...(spec.contentType === undefined ? {} : { contentType: spec.contentType }),
          ...(spec.body === undefined ? {} : { body: spec.body }),
          timeoutMs: 120_000,
        });
      let answeredPath = path;
      let response;
      try {
        response = await send({ path, accept, ...(route.contentType === undefined ? {} : { contentType: route.contentType }), ...(body === undefined ? {} : { body }) });
      } catch (error: unknown) {
        // A lock conflict is a session-owned enqueue, not a bad request: measured
        //, an RFC screen delete leaves the program enqueued to the session that
        // ran it, so the next activation answers "The object is locked: … currently
        // editing ZDEMO_REPORT". One retry in a fresh session clears it.
        if (isLockConflict(error) && routeWrites(route)) {
          await runtime.closeAll();
          const retry = runtime.resolve(ctx.system, arg(args, "session_id"), true);
          response = await retry.session.request({
            method: route.method ?? "GET",
            path: `${path}${query}`,
            accept,
            ...(route.contentType === undefined ? {} : { contentType: route.contentType }),
            ...(body === undefined ? {} : { body }),
            timeoutMs: 120_000,
          });
        } else if (route.fallback === undefined || !endpointMissing(error)) {
          // The ADT layer already classified the answer (`not-found`, `already-exists`,
          // `invalid-lock`, `content-negotiation`, …). Wrapping it in `UPSTREAM_FAILED` threw that
          // away: measured, `GetEnhancementSpot` on a name that does not exist answered
          // `UPSTREAM_FAILED` for a plain 404, so a caller branching on `not-found` missed it. Only
          // an unclassified failure is the gateway giving up on SAP.
          if (error instanceof AdtError) throw error;
          throw new GatewayError("UPSTREAM_FAILED", `${tool} failed: ${String((error as Error).message ?? error)}`, {
            path,
            nextAction: "check the route in src/tools/routes.ts against the system's discovery document",
          });
        } else {
          // The resource lives under another path on this release; the answer decides.
          const other = route.fallback;
          answeredPath = fill(other.path, effective, route.encode);
          const retryContentType = other.contentType ?? route.contentType;
          const retryBody = other.bodyOf === undefined ? body : other.bodyOf(effective);
          response = await send({
            path: answeredPath,
            accept: other.accept ?? accept,
            ...(retryContentType === undefined ? {} : { contentType: retryContentType }),
            ...(retryBody === undefined ? {} : { body: retryBody }),
          }).catch((retryError: unknown) => {
            if (route.absentBecause !== undefined && endpointMissing(retryError)) {
              throw new GatewayError("NOT_IMPLEMENTED", route.absentBecause, { path: answeredPath });
            }
            if (retryError instanceof AdtError) throw retryError;
            throw new GatewayError("UPSTREAM_FAILED", `${tool} failed: ${String((retryError as Error).message ?? retryError)}`, {
              path: answeredPath,
              nextAction:
                "both the current and the older endpoint answered; read the SAP text to see which one this system has",
            });
          });
        }
      }

      const lockHandle = lockHandleFromBody(String(response.body ?? ""));
      const answerBody = String(response.body ?? "");
      const checklist = parseChecklist(answerBody);
      // A unit-test **result** answers its own document; `success` has to come from it, not
      // from the HTTP status (measured live: a failing test answered
      // `success: true` and buried `severity="critical"` in `raw_xml`).
      const unitResult = route === UNIT_TEST_RESULT ? parseUnitResult(answerBody) : undefined;
      // The status document says whether the run is still going; `percentage` and
      // `FINISHED` were already in the body and invisible to a caller reading fields.
      const unitStatus = route === UNIT_TEST_STATUS ? parseUnitStatus(answerBody) : undefined;
      // A 201 with an empty body still carries its identity in `Location` — measured
      // on `/abapunit/runs`, where the caller had no run id and every
      // Status/Result call was unusable.
      const location = String(response.headers["location"] ?? "");
      const runId = /\/abapunit\/runs\//i.test(location)
        ? (location.split("/").filter((part) => part.length > 0).pop() ?? "")
        : "";
      // The profiler run answers an Atom feed and names the trace only inside it
      // (`<atom:id>/…/requests/90%2c20261104114752</atom:id>`), so the trace id used to be
      // invisible and neither the hit list nor the analysis could be reached.
      const traceId = /\/abaptraces\/requests(\?|$)/i.test(answeredPath)
        ? traceIdOf(answerBody)
        : "";
      return {
        // A checklist answer is a report, not a success: measured,
        // `ActivateScreenLow` answered HTTP 200 with `activationExecuted="false"` and
        // was returned as `success: true`.
        success: unitResult !== undefined ? unitResult.success : (checklist === undefined ? true : checklist.errors === 0),
        path: answeredPath,
        status: response.status,
        ...(checklist === undefined ? {} : checklist),
        ...(unitResult === undefined ? {} : { unit_result: unitResult }),
        ...(unitStatus === undefined ? {} : { unit_status: unitStatus }),
        ...(location.length === 0 ? {} : { location }),
        ...(runId.length === 0 ? {} : { run_id: runId }),
        ...(traceId.length === 0 ? {} : { trace_id: traceId }),
        ...(lockHandle === undefined ? {} : { lock_handle: lockHandle }),
        ...(route.text === true ? { source_code: answerBody } : { raw_xml: answerBody }),
        session_id: resolved.sessionId,
      };
    });
  }
}

/**
 * Reads an ADT `chkl:messages` answer — the shape activation and check runs return.
 *
 * Two attribute spellings carry the severity (`severity="error"` and `type="E"`), and
 * the `<chkl:properties>` element says what actually happened; a caller that only
 * looks at the HTTP status sees "200" for a cancelled activation.
 *
 * Read structurally, through the same helpers as `lifecycle.activate`: the message text
 * nests one level deeper than the check report (`<msg><shortText><txt>`), and a regex
 * over markup lost it there once already.
 */
export function parseChecklist(
  body: string,
): { readonly activation_executed: boolean; readonly generation_executed: boolean; readonly errors: number; readonly warnings: number; readonly messages: readonly { severity: string; text: string }[] } | undefined {
  const parsed = parseXml(body);
  if (parsed === undefined) return undefined;
  const root = rootNameOf(parsed) ?? "";
  const nodes = findElements(parsed, "msg");
  if (root !== "messages" && root !== "msg" && nodes.length === 0) return undefined;

  const messages = nodes.map((msg) => ({
    severity: (attributeOf(msg, "severity") ?? attributeOf(msg, "type") ?? "").toLowerCase(),
    text: messageTextOf(msg),
  }));
  const isError = (severity: string): boolean => severity === "e" || severity === "a" || severity === "error";
  const properties = findElements(parsed, "properties")[0];
  const flag = (name: string): boolean =>
    properties !== undefined && (attributeOf(properties, name) ?? "").toLowerCase() === "true";
  return {
    activation_executed: flag("activationExecuted"),
    generation_executed: flag("generationExecuted"),
    errors: messages.filter((message) => isError(message.severity)).length,
    warnings: messages.filter((message) => message.severity === "w" || message.severity === "warning").length,
    messages,
  };
}
