/**
 * Service-binding lifecycle pieces that the generic family verbs cannot express.
 *
 * The old powerup handler did more than POST the binding document:
 *   - it checked that the requested OData version is installed,
 *   - it ran a CTS transport check for a transportable package,
 *   - it read/checked/generated the binding after activation,
 *   - and it unpublished a published binding before deleting it.
 *
 * Those steps are kept here instead of hidden inside `CreateServiceBinding`, so the
 * generic family code stays one shape for every object type.
 */

import type { AdtSession } from "../adt/session.js";
import { AdtError } from "../adt/errors.js";
import { GatewayError } from "../engine/errors.js";
import { childTextOf, decodeXmlEntities, findElements, nodeTextOf, parseXml } from "../adt/xml.js";
import { escapeXml, lower, type CreateContext } from "./types.js";

const BINDING_TYPES_PATH = "/businessservices/bindings/bindingtypes";
const SERVICE_BINDING_ACCEPT = "application/vnd.sap.adt.businessservices.servicebinding.v2+xml";
const SERVICE_DEFINITION_ACCEPT = "application/vnd.sap.adt.ddic.srvd.v1+xml";
const AS_XML = "application/vnd.sap.as+xml";

interface BindingType {
  readonly name: string;
  readonly description: string;
  readonly data: string;
}

function decodeXml(value: string): string {
  return decodeXmlEntities(value);
}

function bindingTypes(xml: string): BindingType[] {
  // Structural: the answer nests `nameditem:namedItem` inside `nameditem:namedItems`, and
  // a regex over that had to spell the namespace prefix exactly and could not decode an
  // escaped description.
  const parsed = parseXml(xml);
  if (parsed === undefined) return [];
  return findElements(parsed, "namedItem")
    .map((item) => ({
      name: (childTextOf(item, "name") ?? "").toUpperCase(),
      description: childTextOf(item, "description") ?? "",
      data: (childTextOf(item, "data") ?? "").toUpperCase(),
    }))
    .filter((entry) => entry.name.length > 0);
}

function wantedType(args: Readonly<Record<string, unknown>>): { readonly type: string; readonly version: string } {
  const raw = String(args["binding_type"] ?? "ODataV4").trim().toUpperCase();
  return raw.includes("V2") ? { type: "ODATA", version: "V2" } : { type: "ODATA", version: "V4" };
}

/** Checks the service definition and the OData version before the POST creates a shell. */
export async function preflightServiceBinding(
  session: AdtSession,
  context: CreateContext,
): Promise<Readonly<Record<string, unknown>>> {
  const definition = String(context.args["service_definition_name"] ?? context.name).trim().toUpperCase();
  const definitionExists = await session
    .request({ path: `/ddic/srvd/sources/${lower(definition)}`, accept: SERVICE_DEFINITION_ACCEPT })
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof AdtError && error.status === 404) return false;
      throw error;
    });
  if (!definitionExists) {
    throw new GatewayError("INVALID_ARGUMENT", `Service definition ${definition} does not exist.`, {
      nextAction: "Create the service definition first, then create the binding.",
    });
  }

  const response = await session.requestAcceptingAny({ path: BINDING_TYPES_PATH, accept: "application/xml" });
  const available = bindingTypes(response.body);
  const wanted = wantedType(context.args);
  const found = available.find(
    (entry) =>
      entry.name === wanted.type &&
      entry.description === "1" &&
      entry.data === (wanted.version === "V2" ? "ODATA V2" : "ODATA V4"),
  );
  if (found === undefined) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      `Binding type OData${wanted.version} is not available on this system.`,
      {
        available: available.map((entry) => `${entry.name}:${entry.description}:${entry.data}`),
        nextAction: "Use binding_type ODataV2 when the system only publishes the V2 service type.",
      },
    );
  }

  return {
    binding_type: `OData${wanted.version}`,
    service_definition: definition,
    binding_types: available.map((entry) => `${entry.name}:${entry.description}:${entry.data}`),
  };
}

/**
 * CTS preflight for a transportable package.
 *
 * `$TMP` has no transport request, so the check is skipped there; sending it would
 * turn a legitimate local probe into a "request required" failure.
 */
export async function transportCheckServiceBinding(
  session: AdtSession,
  context: CreateContext,
): Promise<Readonly<Record<string, unknown>>> {
  if (context.packageName.toUpperCase() === "$TMP") {
    return { transport_check: "skipped: $TMP" };
  }
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">' +
    "<asx:values><DATA>" +
    "<PGMID>R3TR</PGMID><OBJECT>SRVB</OBJECT>" +
    `<OBJECTNAME>${escapeXml(context.name)}</OBJECTNAME>` +
    "<OPERATION>I</OPERATION>" +
    `<DEVCLASS>${escapeXml(context.packageName)}</DEVCLASS>` +
    `<CTEXT>${escapeXml(context.description.slice(0, 60))}</CTEXT>` +
    "</DATA></asx:values></asx:abap>";
  const response = await session.request({
    method: "POST",
    path: "/cts/transportchecks",
    accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData",
    contentType: "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData",
    body,
  });
  return { transport_check: "passed", transport_status: response.status };
}

function versionOf(context: CreateContext): string {
  return wantedType(context.args).version;
}

function serviceTypeOf(context: CreateContext): "odatav2" | "odatav4" {
  return versionOf(context) === "V2" ? "odatav2" : "odatav4";
}

function serviceNameOf(context: CreateContext): string {
  return String(context.args["service_name"] ?? context.name).trim().toUpperCase();
}

function serviceVersionOf(context: CreateContext): string {
  return String(context.args["service_version"] ?? "0001").trim();
}

/**
 * Generates the OData service metadata for a newly activated binding.
 *
 * This is the step that makes `CreateServiceBinding` usable as a service, rather
 * than merely as a repository object; the old client performed it after activation.
 */
export async function generateServiceBinding(
  session: AdtSession,
  context: CreateContext,
): Promise<Readonly<Record<string, unknown>>> {
  const serviceType = serviceTypeOf(context);
  const accept =
    serviceType === "odatav2"
      ? "application/vnd.sap.adt.businessservices.odatav2.v2+xml, application/vnd.sap.adt.businessservices.odatav2.v3+xml"
      : "application/vnd.sap.adt.businessservices.odatav4.v1+xml, application/vnd.sap.adt.businessservices.odatav4.v2+xml";
  const query = new URLSearchParams({
    servicename: serviceNameOf(context),
    serviceversion: serviceVersionOf(context),
    srvdname: String(context.args["service_definition_name"] ?? context.name).trim().toUpperCase(),
  });
  const response = await session.request({
    method: "GET",
    path: `/businessservices/${serviceType}/${encodeURIComponent(context.name.toUpperCase())}?${query.toString()}`,
    accept,
  });
  return {
    generated_info: response.body,
    generated_info_status: response.status,
    generated_service_type: serviceType,
    generated_service_name: serviceNameOf(context),
    generated_service_version: serviceVersionOf(context),
  };
}

function attr(xml: string, tag: string, name: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, "i").exec(xml);
  return decodeXml(match?.[1] ?? "");
}

/** Reads a published binding and unpublishes it before the generic delete. */
export async function unpublishServiceBinding(
  session: AdtSession,
  context: CreateContext,
): Promise<Readonly<Record<string, unknown>>> {
  const path = `/businessservices/bindings/${lower(context.name)}`;
  const current = await session.requestAcceptingAny({ path, accept: SERVICE_BINDING_ACCEPT }).catch((error: unknown) => {
    if (error instanceof AdtError && error.status === 404) return undefined;
    throw error;
  });
  if (current === undefined) return { unpublished: false, reason: "binding not readable" };

  const xml = current.body;
  const published = attr(xml, "srvb:serviceBinding", "srvb:published").toLowerCase() === "true";
  const allowed = attr(xml, "srvb:serviceBinding", "srvb:allowedAction").toUpperCase();
  if (!published || allowed !== "UNPUBLISH") return { unpublished: false, published };

  const bindingVersion = attr(xml, "srvb:binding", "srvb:version").toUpperCase();
  const serviceType = bindingVersion === "V2" ? "odatav2" : "odatav4";
  const serviceName =
    attr(xml, "srvb:services", "srvb:name") || String(context.args["service_name"] ?? context.name).toUpperCase();
  const serviceVersion = attr(xml, "srvb:content", "srvb:version") || "0001";
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<adtcore:objectReference adtcore:uri="/sap/bc/adt${path}" adtcore:name="${escapeXml(context.name.toUpperCase())}"/>` +
    "</adtcore:objectReferences>";
  const response = await session.request({
    method: "POST",
    path: `/businessservices/${serviceType}/unpublishjobs?servicename=${encodeURIComponent(serviceName)}&serviceversion=${encodeURIComponent(serviceVersion)}`,
    accept: AS_XML,
    contentType: "application/xml",
    body,
  });
  const severityNode = findElements(parseXml(response.body) ?? {}, "SEVERITY")[0];
  const severity = (severityNode === undefined ? "" : nodeTextOf(severityNode)).toUpperCase();
  if (severity === "ERROR" || severity === "ABORT" || severity === "E") {
    throw new GatewayError("UPSTREAM_FAILED", "The binding could not be unpublished before deletion.", {
      severity,
      response: response.body.slice(0, 800),
    });
  }
  return {
    unpublished: true,
    published_before: true,
    service_type: serviceType,
    service_name: serviceName,
    service_version: serviceVersion,
  };
}
