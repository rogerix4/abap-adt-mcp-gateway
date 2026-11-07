/**
 * CDS-side families that are a text source with an inline body on create: a data
 * definition (`DDLS`), a metadata extension (`DDLX`) and a service definition
 * (`SRVD`). All three share one shape, so they live together.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the bodies are unchanged.
 */
import { lockObject, unlockObject, writeSource } from "../../adt/lifecycle.js";
import { lower, renderCreateBody, type ObjectFamily } from "../types.js";

const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

/** CDS data definition (DDLS): text source, created with the DDL inline. */
export function viewFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.ddlSource+xml";
  const envelope = {
    // Measured: the root element is `ddls:ddlSource` (singular).
    root: "ddls:ddlSource",
    namespaces: [["ddls", "http://www.sap.com/adt/ddic/ddlsources"] as const],
  };

  return {
    //: the family id is `CdsView` (not `View`) so every tool name says what
    // it reads: a CDS DDL source (`DDLS/DF`). A DDIC view (`VIEW/DV`) has no ADT
    // resource on this stack, so there is no tool for it.
    id: "CdsView",
    nameParam: "view_name",
    // The contract calls the source `ddl_source` on both create and update.
    sourceParam: "ddl_source",
    adtType: "DDLS/DF",
    objectPath: (name) => `/ddic/ddl/sources/${lower(name)}`,
    collectionPath: "/ddic/ddl/sources",
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, "DDLS/DF"),
    // `CreateCdsView` takes an optional `ddl_source`, so a view can be created with
    // its definition in one call. ADT itself only accepts metadata on the POST,
    // so the DDL goes in as a write right after — inside the same call, before
    // activation, so the caller never sees an empty view.
    afterCreate: async (session, context, objectPath) => {
      const ddl = typeof context.args["ddl_source"] === "string" ? context.args["ddl_source"] : undefined;
      if (ddl === undefined || ddl.trim().length === 0) return;
      const lock = await lockObject(session, objectPath);
      try {
        await writeSource(session, sourceOf(objectPath), ddl, {
          lockHandle: lock.lockHandle,
          corrNr: lock.corrNr,
        });
      } finally {
        await unlockObject(session, objectPath, lock.lockHandle);
      }
    },
    update: { kind: "source" },
  };
}

/** Metadata extension (DDLX): text source; read uses a different name argument. */
export function metadataExtensionFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.ddic.ddlx.v1+xml";
  const envelope = {
    root: "ddlx:ddlxSource",
    // Measured: the namespace is `ddlxsources`, not `ddlx`.
    namespaces: [["ddlx", "http://www.sap.com/adt/ddic/ddlxsources"] as const],
  };

  return {
    id: "MetadataExtension",
    nameParam: "name",
    // Measured: Read/Get/Delete take `metadata_extension_name`, the rest `name`.
    nameParamByVerb: {
      Read: "metadata_extension_name",
      Get: "metadata_extension_name",
      Delete: "metadata_extension_name",
    },
    adtType: "DDLX/EX",
    objectPath: (name) => `/ddic/ddlx/sources/${lower(name)}`,
    collectionPath: "/ddic/ddlx/sources",
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, "DDLX/EX"),
    update: { kind: "source" },
  };
}

/** Service definition (SRVD): text source, same shape as a CDS view. */
export function serviceDefinitionFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.ddic.srvd.v1+xml";
  const envelope = {
    root: "srvd:srvdSource",
    namespaces: [["srvd", "http://www.sap.com/adt/ddic/srvdsources"] as const],
    // Measured: without `srvd:srvdSourceType` the endpoint answers
    // `Service Definition type '' does not exist`. `S` is the service-definition kind.
    attributes: (context: { readonly responsible?: string }) =>
      [
        ["srvd:srvdSourceType", "S"] as const,
        ...(context.responsible === undefined ? [] : [["adtcore:responsible", context.responsible] as const]),
      ],
  };

  return {
    id: "ServiceDefinition",
    nameParam: "service_definition_name",
    adtType: "SRVD/SRV",
    objectPath: (name) => `/ddic/srvd/sources/${lower(name)}`,
    collectionPath: "/ddic/srvd/sources",
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, "SRVD/SRV"),
    afterCreate: async (session, context, objectPath) => {
      const source = typeof context.args["source_code"] === "string" ? context.args["source_code"] : undefined;
      if (source === undefined || source.trim().length === 0) return;
      const lock = await lockObject(session, objectPath);
      try {
        await writeSource(session, sourceOf(objectPath), source, { lockHandle: lock.lockHandle, corrNr: lock.corrNr });
      } finally {
        await unlockObject(session, objectPath, lock.lockHandle);
      }
    },
    update: { kind: "source" },
  };
}
