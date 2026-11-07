/**
 * Service binding (`SRVB/SVB`): a document plus publish / unpublish jobs.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import {
  generateServiceBinding,
  preflightServiceBinding,
  transportCheckServiceBinding,
  unpublishServiceBinding,
} from "../service-binding.js";
import { escapeXml, lower, type ObjectFamily } from "../types.js";

/** Service binding (SRVB): a document plus publish/unpublish jobs. */
export function serviceBindingFamily(): ObjectFamily {
  // Newer releases accept POST with the v2 media type. Release 754 answers GET
  // with v2 but rejects the POST with 415; its POST accepts v1, and that is
  // exactly the schema the archived client sent. Keep the v2 media for reads
  // and try it first for writes.
  const v1 = "application/vnd.sap.adt.businessservices.servicebinding.v1+xml";
  const media = "application/vnd.sap.adt.businessservices.servicebinding.v2+xml";

  return {
    id: "ServiceBinding",
    nameParam: "service_binding_name",
    // Publishing is a job on `/businessservices/<type>/publishjobs`; the dedicated
    // handler in `read.ts` owns the verb, so the family must not register it.
    skipVerbs: ["Update", "UpdateLow"],
    adtType: "SRVB/SVB",
    objectPath: (name) => `/businessservices/bindings/${lower(name)}`,
    collectionPath: "/businessservices/bindings",
    media: { accept: media, contentType: media },
    createMediaFallbacks: [{ accept: "*/*", contentType: v1 }],
    beforeCreate: async (session, context) => ({
      ...(await preflightServiceBinding(session, context)),
      ...(await transportCheckServiceBinding(session, context)),
    }),
    afterActivate: async (session, context) => generateServiceBinding(session, context),
    beforeDelete: async (session, context) => unpublishServiceBinding(session, context),
    // Shape taken from the archived client: `srvb:services/srvb:content` carries
    // one `srvb:serviceDefinition` by name, and `srvb:binding` is a sibling.
    // Measured: the v2-only shape (extra content attributes plus
    // `srvb:bindingTypeData`) makes release 754 answer "expected end of element
    // '{...}content'".
    createBody: (context) => {
      const serviceDefinition = String(context.args["service_definition_name"] ?? context.name);
      const serviceName = String(context.args["service_name"] ?? context.name);
      const version = String(context.args["binding_type"] ?? "").toUpperCase() === "ODATAV2" ? "V2" : "V4";
      const contentVersion = String(context.args["service_version"] ?? "0001");
      return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" ' +
        'xmlns:adtcore="http://www.sap.com/adt/core" ' +
        `adtcore:description="${escapeXml(context.description.slice(0, 60))}" ` +
        `adtcore:language="${escapeXml(context.language)}" adtcore:name="${escapeXml(context.name)}" ` +
        'adtcore:type="SRVB/SVB" ' +
        `adtcore:masterLanguage="${escapeXml(context.language)}">` +
        `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
        `<srvb:services srvb:name="${escapeXml(serviceName)}">` +
        `<srvb:content srvb:version="${escapeXml(contentVersion)}">` +
        `<srvb:serviceDefinition adtcore:name="${escapeXml(serviceDefinition)}"/>` +
        "</srvb:content></srvb:services>" +
        `<srvb:binding srvb:category="1" srvb:type="ODATA" srvb:version="${version}">` +
        '<srvb:implementation adtcore:name=""/>' +
        "</srvb:binding></srvb:serviceBinding>"
      );
    },
    // Publication is not a PUT of the document: it is a job on
    // /businessservices/<type>/publishjobs (or unpublishjobs).
    update: {
      kind: "patch",
      contentType: media,
      patch: (currentXml) => currentXml,
    },
    updateTarget: "object",
    verification: "readable",
  };
}
