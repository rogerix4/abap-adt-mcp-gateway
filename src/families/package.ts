/**
 * Package (`DEVC/K`).
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { GatewayError } from "../engine/errors.js";
import { patchAttribute } from "../adt/xml-patch.js";
import { escapeXml, lower, type ObjectFamily } from "./types.js";

/**
 * Package (DEVC/K).
 *
 * Measured: it reads as `pak:package` on `/packages/<name>`. Creating one needs a
 * transportable super package plus a transport request, so `CreatePackage`
 * forwards `transport_request` when the caller has one — a local package cannot
 * be created, `$TMP` can never be its parent.
 */
export function packageFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.packages.v2+xml";

  return {
    id: "Package",
    nameParam: "package_name",
    parentParam: "super_package",
    // Get / Check / Validate / Lock address a package by its own name; only Create
    // needs the super package.
    parentOptional: true,
    adtType: "DEVC/K",
    objectPath: (name) => `/packages/${lower(name)}`,
    collectionPath: "/packages",
    media: { accept: media, contentType: media },
    // No packageRef-only envelope: measured, the endpoint answers
    // "the system expected element '{http://www.sap.com/adt/packages}attributes'" for a
    // flat document (SAP replies in the logon language; this system is Chinese).
    // The shape below (attributes / superPackage / transport / its software
    // component and layer as child elements) is the one the upstream client sends.
    createBody: (context) => {
      const requested = typeof context.args["software_component"] === "string" ? context.args["software_component"] : undefined;
      const transportLayer = typeof context.args["transport_layer"] === "string" ? context.args["transport_layer"] : "";
      // Measured on DS4/100, six combinations, none accepted (SAP answers in
      // Chinese on this system; the English meaning is in brackets):
      //   component `HOME` + no layer  -> "package X cannot be assigned to software component HOME"
      //   component ``     + no layer  -> "enter a software component (use the input help)"
      //   component `LOCAL`/`HOME` + layer `LOCAL` -> deserialisation error
      // ADT cannot create a package *below* a local package on this system, and its own
      // two messages say nothing about what to do. Say it here; a caller that knows
      // better can still pass `software_component` explicitly.
      if ((context.parent ?? "").startsWith("$") && requested === undefined) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          `ADT refuses to create a package below the local package "${context.parent}": a software component is required and the local parent has none.`,
          {
            nextAction:
              'Create it below a transportable package instead, e.g. super_package: "ZMCP_RAP" with software_component, transport_layer and transport_request.',
          },
        );
      }
      const softwareComponent = requested ?? "HOME";
      const applicationComponent =
        typeof context.args["application_component"] === "string" ? context.args["application_component"] : "";
      const recordChanges = context.args["record_changes"] !== false;
      // Measured: an empty `transportLayer` makes SAP answer
      // `HTTP 409: request <n> is not a local request` — a message about the request that
      // says nothing about the actual cause. `HOME` alone was accepted by SAP's own package
      // (read back from `/packages/…`: softwareComponent `HOME`, transportLayer `ZDS4`), so
      // the layer is what decides; ask for it instead of sending an empty element.
      if (transportLayer.length === 0) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          "CreatePackage needs the transport layer of the super package; sending an empty one makes SAP answer 409 \"not a local request\".",
          {
            nextAction:
              'Read the super package first (GetPackage) and pass its pak:transportLayer as `transport_layer` — e.g. "ZDS4" — together with its `software_component` (usually "HOME").',
          },
        );
      }
      return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core" ' +
        `adtcore:description="${escapeXml(context.description.slice(0, 60))}" adtcore:language="${escapeXml(context.language)}" ` +
        `adtcore:name="${escapeXml(context.name)}" adtcore:type="DEVC/K" adtcore:version="active" ` +
        `adtcore:masterLanguage="${escapeXml(context.language)}"` +
        (context.responsible === undefined ? "" : ` adtcore:responsible="${escapeXml(context.responsible)}"`) +
        ">" +
        `<adtcore:packageRef adtcore:name="${escapeXml(context.name)}"/>` +
        '<pak:attributes pak:isEncapsulated="false" ' +
        `pak:packageType="${escapeXml(String(context.args["package_type"] ?? "development"))}" ` +
        `pak:recordChanges="${recordChanges ? "true" : "false"}"/>` +
        (context.parent === undefined ? "<pak:superPackage/>" : `<pak:superPackage adtcore:name="${escapeXml(context.parent)}"/>`) +
        (applicationComponent.length === 0
          ? "<pak:applicationComponent/>"
          : `<pak:applicationComponent pak:name="${escapeXml(applicationComponent)}"/>`) +
        "<pak:transport>" +
        (softwareComponent.length === 0
          ? "<pak:softwareComponent/>"
          : `<pak:softwareComponent pak:name="${escapeXml(softwareComponent)}"/>`) +
        (transportLayer.length === 0 ? "<pak:transportLayer/>" : `<pak:transportLayer pak:name="${escapeXml(transportLayer)}"/>`) +
        "</pak:transport>" +
        "<pak:translation/><pak:useAccesses/><pak:packageInterfaces/><pak:subPackages/>" +
        "</pak:package>"
      );
    },
    // Measured: SAP's package write enqueues the package under the **current**
    // session and never gives that enqueue back, so the next LOCK/PUT/DELETE on the same
    // package in the same session answers "package X is locked" (with a fresh lock handle
    // in hand). Dropping the session after every successful write is what makes the chain work.
    dropSessionAfterWrite: true,
    // Only the description is editable through the contract's update verb.
    update: {
      kind: "patch",
      contentType: media,
      patch: (currentXml, context) =>
        patchAttribute(
          currentXml,
          "adtcore:description",
          String(context.args["updated_description"] ?? context.description),
        ),
    },
    updateTarget: "object",
    verification: "readable",
  };
}
