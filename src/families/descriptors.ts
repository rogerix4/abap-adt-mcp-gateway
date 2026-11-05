/**
 * Object families, one table entry each.
 *
 * Every value here was measured on the reference system (BASIS 754): the path by
 * reading a standard object, the media type from the discovery document, and the
 * root element from the body that read returned. Nothing is copied from memory.
 *
 * Note the type codes: a structure is `TABL/DS`, not `STRU/DT`; a data element is
 * `DTEL/DE`, a domain `DOMA/DD`.
 */

import { escapeXml, lower, renderCreateBody, type CreateContext, type ObjectFamily } from "./types.js";
import { GatewayError } from "../engine/errors.js";
import { activate, lockObject, readSource, runCheck, unlockObject, writeSource } from "../adt/lifecycle.js";
import { patchAttribute, patchBlock, patchElement } from "../adt/xml-patch.js";

const ADTPATH = (path: string) => path;
const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

/** Classes and interfaces share the OO shape; only root element and path differ. */
function ooFamily(config: {
  readonly id: string;
  readonly nameParam: string;
  readonly adtType: string;
  readonly collection: string;
  readonly root: string;
  readonly namespace: string;
  readonly media: string;
  readonly extraAttributes?: (args: Readonly<Record<string, unknown>>) => readonly (readonly [string, string])[];
  /** Elements that must be declared at creation, e.g. the includes to create. */
  readonly children?: (context: CreateContext) => string;
}): ObjectFamily {
  const envelope = {
    root: config.root,
    namespaces: [[config.root.split(":")[0] ?? "class", config.namespace] as const],
    ...(config.children === undefined ? {} : { children: config.children }),
    ...(config.extraAttributes === undefined
      ? {}
      : {
          attributes: (context: { readonly args: Readonly<Record<string, unknown>> }) =>
            config.extraAttributes!(context.args),
        }),
  };

  return {
    id: config.id,
    nameParam: config.nameParam,
    adtType: config.adtType,
    objectPath: (name) => `${config.collection}/${lower(name)}`,
    collectionPath: config.collection,
    sourcePath: sourceOf,
    media: { accept: config.media, contentType: config.media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, config.adtType),
    update: { kind: "source" },
  };
}

/** DDIC objects whose content is a DDL body on the object URI (tables, structures). */
function ddlFamily(config: {
  readonly id: string;
  readonly nameParam: string;
  readonly adtType: string;
  readonly collection: string;
  /** Measured per collection: tables and structures advertise different types. */
  readonly media: string;
}): ObjectFamily {
  const envelope = {
    root: "blue:blueSource",
    namespaces: [["blue", "http://www.sap.com/wbobj/blue"] as const],
  };

  return {
    id: config.id,
    nameParam: config.nameParam,
    // The contract spells the DDL argument `ddl_code` for tables and structures.
    // Reading `source_code` here answered `Missing "source_code"` to a caller that
    // sent exactly what the schema told it to send.
    sourceParam: "ddl_code",
    adtType: config.adtType,
    objectPath: (name) => `${config.collection}/${lower(name)}`,
    collectionPath: config.collection,
    sourcePath: sourceOf,
    media: { accept: config.media, contentType: config.media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, config.adtType),
    // Measured 2026-11-04: the DDL travels to `source/main` as `text/plain`.
    // The object document of a table has no content element at all (reading T000
    // returns `blue:blueSource` metadata plus a packageRef and nothing else), so the
    // earlier base64 `blue:content` body was accepted with **200 and then ignored**:
    // the table kept its generated skeleton while the call reported success.
    update: { kind: "source" },
    // SAP re-formats the DDL it stored (blank lines between the field blocks), so
    // byte equality can never hold — but ignoring blank lines must.
    verification: "normalized",
  };
}

export const classFamily = (): ObjectFamily =>
  ooFamily({
    id: "Class",
    nameParam: "class_name",
    adtType: "CLAS/OC",
    collection: "/oo/classes",
    root: "class:abapClass",
    namespace: "http://www.sap.com/adt/oo/classes",
    media: "application/vnd.sap.adt.oo.classes.v2+xml",
    extraAttributes: (args) => [
      ["class:final", args["final"] === true ? "true" : "false"],
      ["class:abstract", args["abstract"] === true ? "true" : "false"],
      ["class:visibility", args["create_protected"] === true ? "protected" : "public"],
      ["class:category", "generalObjectType"],
    ],
    // Declaring the include here is what makes the testclasses include exist: a PUT to
    // it later answers "<name>=CCAU does not have any inactive version" without this.
    children: (context) =>
      "<class:include adtcore:name=\"CLAS/OC\" adtcore:type=\"CLAS/OC\" class:includeType=\"testclasses\"/>" +
      (typeof context.args["superclass"] === "string" && context.args["superclass"].length > 0
        ? `<class:superClassRef adtcore:name="${escapeXml(context.args["superclass"] as string)}"/>`
        : ""),
  });

export const interfaceFamily = (): ObjectFamily =>
  ooFamily({
    id: "Interface",
    nameParam: "interface_name",
    adtType: "INTF/OI",
    collection: "/oo/interfaces",
    root: "intf:abapInterface",
    namespace: "http://www.sap.com/adt/oo/interfaces",
    media: "application/vnd.sap.adt.oo.interfaces.v2+xml",
  });

export const tableFamily = (): ObjectFamily =>
  ddlFamily({
    id: "Table",
    nameParam: "table_name",
    adtType: "TABL/DT",
    collection: "/ddic/tables",
    media: "application/vnd.sap.adt.tables.v2+xml",
  });

export const structureFamily = (): ObjectFamily =>
  ddlFamily({
    id: "Structure",
    nameParam: "structure_name",
    // Measured: a structure reports TABL/DS, not STRU/DT.
    adtType: "TABL/DS",
    collection: "/ddic/structures",
    // Measured: posting a structure with the tables media type answers 415.
    media: "application/vnd.sap.adt.structures.v2+xml",
  });

/**
 * Data elements, domains, views and metadata extensions need their own payload
 * shape (XML body instead of a DDL source) and are implemented in the route table
 * rather than here.
 */
export const textFamilies: readonly ObjectFamily[] = [
  classFamily(),
  interfaceFamily(),
  tableFamily(),
  structureFamily(),
];

/** Data element: XML body on the object URI, children measured from a read. */
export function dataElementFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.dataelements.v2+xml";
  const build = (context: CreateContext): string => {
    const arg = (key: string): string | undefined => {
      const value = context.args[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const dataType = arg("data_type") ?? "CHAR";
    const length = (arg("length") ?? "40").padStart(6, "0");
    const decimals = (arg("decimals") ?? "0").padStart(6, "0");
    const typeKind = arg("type_kind") ?? "predefinedAbapType";
    // Only a type that *refers* to something carries a type name. A predefined
    // type carries its identity in `dataType` alone; putting "CHAR" in `typeName`
    // makes SAP's SBD_DATAELEMENT transformation fail with a deserialisation
    // error and no hint about which element is wrong.
    const predefined = typeKind === "predefinedAbapType" || typeKind === "refToPredefinedAbapType";
    const typeName = predefined ? "" : (arg("type_name") ?? arg("data_type") ?? "");
    const effectiveDataType = predefined ? dataType : (arg("data_type") ?? "");

    /** Measured: each label is a triple — Label, Length, MaxLength — with fixed lengths. */
    const labelLengths: Readonly<Record<string, readonly [number, number]>> = {
      shortField: [10, 10],
      mediumField: [20, 20],
      longField: [40, 40],
      headingField: [55, 55],
    };
    const label = (value: string | undefined, base: string) => {
      const [size, max] = labelLengths[base] ?? [30, 30];
      const text = escapeXml((value ?? context.description).slice(0, size));
      return (
        `<dtel:${base}Label>${text}</dtel:${base}Label>` +
        `<dtel:${base}Length>${size}</dtel:${base}Length>` +
        `<dtel:${base}MaxLength>${max}</dtel:${base}MaxLength>`
      );
    };

    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" ' +
      'xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:description="${escapeXml(context.description.slice(0, 60))}" adtcore:language="${escapeXml(context.language)}" ` +
      `adtcore:name="${escapeXml(context.name)}" adtcore:type="DTEL/DE" adtcore:masterLanguage="${escapeXml(context.language)}">` +
      `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
      "<dtel:dataElement>" +
      `<dtel:typeKind>${escapeXml(typeKind)}</dtel:typeKind>` +
      `<dtel:typeName>${escapeXml(typeName)}</dtel:typeName>` +
      `<dtel:dataType>${escapeXml(effectiveDataType)}</dtel:dataType>` +
      `<dtel:dataTypeLength>${escapeXml(length)}</dtel:dataTypeLength>` +
      `<dtel:dataTypeDecimals>${escapeXml(decimals)}</dtel:dataTypeDecimals>` +
      label(arg("short_label") ?? arg("field_label_short"), "shortField") +
      label(arg("medium_label") ?? arg("field_label_medium"), "mediumField") +
      label(arg("long_label") ?? arg("field_label_long"), "longField") +
      label(arg("heading_label") ?? arg("field_label_heading"), "headingField") +
      // The platform demands the full element set in order, not just the ones we
      // care about: omitting any of these answers
      // "expected element ...searchHelp" and so on.
      `<dtel:searchHelp>${escapeXml(arg("search_help") ?? "")}</dtel:searchHelp>` +
      `<dtel:searchHelpParameter>${escapeXml(arg("search_help_parameter") ?? "")}</dtel:searchHelpParameter>` +
      `<dtel:setGetParameter>${escapeXml(arg("set_get_parameter") ?? "")}</dtel:setGetParameter>` +
      "<dtel:defaultComponentName></dtel:defaultComponentName>" +
      "<dtel:deactivateInputHistory>false</dtel:deactivateInputHistory>" +
      "<dtel:changeDocument>false</dtel:changeDocument>" +
      "<dtel:leftToRightDirection>false</dtel:leftToRightDirection>" +
      "<dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering>" +
      "</dtel:dataElement></blue:wbobj>"
    );
  };

  return {
    id: "DataElement",
    nameParam: "data_element_name",
    adtType: "DTEL/DE",
    objectPath: (name) => `/ddic/dataelements/${lower(name)}`,
    collectionPath: "/ddic/dataelements",
    media: { accept: media, contentType: media },
    createBody: build,
    // The contract takes structured fields (no `source_code`), so the update is
    // read-modify-write: SAP-managed attributes survive, and only what the caller
    // set changes.
    update: {
      kind: "patch",
      contentType: media,
      patch: (current, context) => {
        const arg = (key: string): string | undefined => {
          const value = context.args[key];
          return typeof value === "string" && value.length > 0 ? value : undefined;
        };
        let xml = current;
        if (arg("description") !== undefined) {
          xml = patchAttribute(xml, "adtcore:description", context.description.slice(0, 60));
        }
        const typeKind = arg("type_kind");
        if (typeKind !== undefined) xml = patchElement(xml, "dtel:typeKind", typeKind);
        const typeName = arg("type_name");
        if (typeName !== undefined) xml = patchElement(xml, "dtel:typeName", typeName);
        const dataType = arg("data_type");
        if (dataType !== undefined) xml = patchElement(xml, "dtel:dataType", dataType);
        const length = arg("length");
        if (length !== undefined) xml = patchElement(xml, "dtel:dataTypeLength", length.padStart(6, "0"));
        const decimals = arg("decimals");
        if (decimals !== undefined) xml = patchElement(xml, "dtel:dataTypeDecimals", decimals.padStart(6, "0"));

        const labels: readonly (readonly [string, number, string])[] = [
          ["shortField", 10, arg("field_label_short") ?? arg("short_label") ?? ""],
          ["mediumField", 20, arg("field_label_medium") ?? arg("medium_label") ?? ""],
          ["longField", 40, arg("field_label_long") ?? arg("long_label") ?? ""],
          ["headingField", 55, arg("field_label_heading") ?? arg("heading_label") ?? ""],
        ];
        for (const [base, size, value] of labels) {
          if (value.length === 0) continue;
          xml = patchElement(xml, `dtel:${base}Label`, value.slice(0, size));
          xml = patchElement(xml, `dtel:${base}Length`, String(size));
          xml = patchElement(xml, `dtel:${base}MaxLength`, String(size));
        }
        return xml;
      },
    },
    updateTarget: "object",
    verification: "readable",
  };
}

/** Domain: same shape as a data element, different content element. */
export function domainFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.domains.v2+xml";

  const build = (context: CreateContext, withFixedValues: boolean): string => {
    // Numbers are part of this tool's contract (`length`, `decimals`), and a caller
    // that passes 10 instead of "10" must not silently get the default 40.
    const arg = (key: string): string | undefined => {
      const value = context.args[key];
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const datatype = arg("datatype") ?? "CHAR";
    const length = (arg("length") ?? "40").padStart(6, "0");
    const decimals = (arg("decimals") ?? "0").padStart(6, "0");
    const valueTable = arg("value_table");
    const fixedValues = Array.isArray(context.args["fixed_values"]) ? (context.args["fixed_values"] as unknown[]) : [];

    const fixValuesXml = withFixedValues
      ? fixedValues
          .map((entry) => {
            const item = (typeof entry === "string" ? { low: entry } : entry) as Record<string, unknown>;
            const low = typeof item["low"] === "string" ? item["low"] : "";
            const high = typeof item["high"] === "string" ? item["high"] : "";
            const description = typeof item["description"] === "string" ? item["description"] : low;
            const text = typeof item["text"] === "string" ? item["text"] : description;
            // Measured: the fixed-value text element is `doma:text`. `doma:description`
            // is accepted and then dropped — the value keeps an empty text.
            return `<doma:fixValue><doma:low>${escapeXml(low)}</doma:low><doma:high>${escapeXml(high)}</doma:high><doma:text>${escapeXml(text.slice(0, 60))}</doma:text></doma:fixValue>`;
          })
          .join("")
      : "";

    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:description="${escapeXml(context.description.slice(0, 60))}" adtcore:language="${escapeXml(context.language)}" ` +
      `adtcore:name="${escapeXml(context.name)}" adtcore:type="DOMA/DD" adtcore:masterLanguage="${escapeXml(context.language)}">` +
      `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
      "<doma:content>" +
      "<doma:typeInformation>" +
      `<doma:datatype>${escapeXml(datatype)}</doma:datatype>` +
      `<doma:length>${escapeXml(length)}</doma:length>` +
      `<doma:decimals>${escapeXml(decimals)}</doma:decimals>` +
      "</doma:typeInformation>" +
      "<doma:outputInformation>" +
      `<doma:length>${escapeXml(length)}</doma:length>` +
      "<doma:style>00</doma:style>" +
      `<doma:conversionExit>${escapeXml(arg("conversion_exit") ?? "")}</doma:conversionExit>` +
      `<doma:signExists>${context.args["sign_exists"] === true}</doma:signExists>` +
      `<doma:lowercase>${context.args["lowercase"] === true}</doma:lowercase>` +
      "<doma:ampmFormat>false</doma:ampmFormat>" +
      "</doma:outputInformation>" +
      "<doma:valueInformation>" +
      (valueTable === undefined ? "" : `<doma:valueTableRef adtcore:type="TABL/DT" adtcore:name="${escapeXml(valueTable)}"/>`) +
      "<doma:appendExists>false</doma:appendExists>" +
      (fixValuesXml.length === 0 ? "<doma:fixValues/>" : `<doma:fixValues>${fixValuesXml}</doma:fixValues>`) +
      "</doma:valueInformation>" +
      "</doma:content></doma:domain>"
    );
  };

  return {
    id: "Domain",
    nameParam: "domain_name",
    adtType: "DOMA/DD",
    objectPath: (name) => `/ddic/domains/${lower(name)}`,
    collectionPath: "/ddic/domains",
    media: { accept: media, contentType: media },
    // Measured: fixed values in the create body answer
    // "400 internal error while writing"; the same payload through a later update
    // stores them.
    createBody: (context) => build(context, false),
    afterCreate: async (session, context, objectPath) => {
      const fixedValues = context.args["fixed_values"];
      if (!Array.isArray(fixedValues) || fixedValues.length === 0) return;

      const lock = await lockObject(session, objectPath);
      try {
        await writeSource(session, objectPath, build(context, true), {
          lockHandle: lock.lockHandle,
          accept: media,
          contentType: media,
        });
      } finally {
        await unlockObject(session, objectPath, lock.lockHandle);
      }
    },
    update: {
      kind: "patch",
      contentType: media,
      patch: (current, context) => {
        const arg = (key: string): string | undefined => {
          const value = context.args[key];
          return typeof value === "string" && value.length > 0 ? value : undefined;
        };
        let xml = current;
        if (arg("description") !== undefined) {
          xml = patchAttribute(xml, "adtcore:description", context.description.slice(0, 60));
        }
        const datatype = arg("datatype");
        if (datatype !== undefined) xml = patchElement(xml, "doma:datatype", datatype);
        const length = arg("length");
        if (length !== undefined) {
          const padded = length.padStart(6, "0");
          xml = patchElement(xml, "doma:length", padded);
          // A domain carries its length twice: the type length and the output (screen)
          // length. `patchElement` rewrites the first match only, so the second one is
          // addressed inside its own block — otherwise a 10 -> 20 change left the
          // output length at 10.
          const block = /<doma:outputInformation>[\s\S]*?<\/doma:outputInformation>/.exec(xml)?.[0];
          if (block !== undefined) {
            const updated = patchElement(block, "doma:length", padded);
            if (updated !== block) xml = patchBlock(xml, "doma:outputInformation", updated);
          }
        }
        const decimals = arg("decimals");
        if (decimals !== undefined) xml = patchElement(xml, "doma:decimals", decimals.padStart(6, "0"));
        if (context.args["conversion_exit"] !== undefined) {
          xml = patchElement(xml, "doma:conversionExit", arg("conversion_exit") ?? "");
        }
        if (context.args["sign_exists"] !== undefined) {
          xml = patchElement(xml, "doma:signExists", String(context.args["sign_exists"] === true));
        }
        if (context.args["lowercase"] !== undefined) {
          xml = patchElement(xml, "doma:lowercase", String(context.args["lowercase"] === true));
        }

        const valueTable = arg("value_table");
        if (valueTable !== undefined) {
          xml = patchBlock(
            xml,
            "doma:valueTableRef",
            `<doma:valueTableRef adtcore:uri="/sap/bc/adt/ddic/tables/${lower(valueTable)}" adtcore:type="TABL/DT" adtcore:name="${escapeXml(valueTable)}"/>`,
          );
        }

        const fixedValues = Array.isArray(context.args["fixed_values"]) ? (context.args["fixed_values"] as unknown[]) : undefined;
        if (fixedValues !== undefined) {
          // Measured: the fixed-value text element is `doma:text`; using
          // `high`/`description` answers "internal error while writing".
          const items = fixedValues
            .map((entry) => {
              const item = (typeof entry === "string" ? { low: entry } : entry) as Record<string, unknown>;
              const lowValue = typeof item["low"] === "string" ? item["low"] : "";
              const text = typeof item["text"] === "string" ? item["text"] : typeof item["description"] === "string" ? item["description"] : lowValue;
              return `<doma:fixValue><doma:low>${escapeXml(lowValue)}</doma:low><doma:text>${escapeXml(text.slice(0, 60))}</doma:text></doma:fixValue>`;
            })
            .join("");
          xml = patchBlock(xml, "doma:fixValues", items.length === 0 ? "<doma:fixValues/>" : `<doma:fixValues>${items}</doma:fixValues>`);
        }
        return xml;
      },
    },
    updateTarget: "object",
    verification: "readable",
  };
}

/** CDS data definition (DDLS): text source, created with the DDL inline. */
export function viewFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.ddlSource+xml";
  const envelope = {
    // Measured: the root element is `ddls:ddlSource` (singular).
    root: "ddls:ddlSource",
    namespaces: [["ddls", "http://www.sap.com/adt/ddic/ddlsources"] as const],
  };

  return {
    // 2026-11-04: the family id is `CdsView` (not `View`) so every tool name says what
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

/** Function group (FUGR/F): a container with its own generated source; only its description is updatable. */
export function functionGroupFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.functions.groups.v2+xml";
  const envelope = {
    root: "group:abapFunctionGroup",
    namespaces: [["group", "http://www.sap.com/adt/functions/groups"] as const],
  };

  return {
    id: "FunctionGroup",
    nameParam: "function_group_name",
    adtType: "FUGR/F",
    // Measured 2026-11-04: `/checkruns` on a function group checks the *generated*
    // include and always answers `The REPORT/PROGRAM statement is missing, or the
    // program type is INCLUDE` — a complaint about SAP's own generated source, not
    // about the group. A tool that reports that as an error is unusable.
    checkUnavailable:
      "The ABAP check runs on a function group's generated include and always reports a missing REPORT statement; check the function modules instead (CheckFunctionModuleLow).",
    objectPath: (name) => `/functions/groups/${lower(name)}`,
    collectionPath: "/functions/groups",
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, "FUGR/F"),
    // The contract's UpdateFunctionGroup takes a description and nothing else —
    // a function group's source is generated from its includes, so the only
    // editable part is the metadata. That makes this a read-modify-write, same
    // shape as the DDIC families: keep every field SAP owns, replace one.
    update: {
      kind: "patch",
      contentType: media,
      patch: (currentXml, context) => patchAttribute(currentXml, "adtcore:description", context.description),
    },
    updateTarget: "object",
    verification: "readable",
  };
}

/**
 * Function module (FUGR/FF): no address of its own, it lives inside a group.
 *
 * Measured: `POST /functions/groups/<group>/fmodules` answers 201 and the module
 * is readable immediately — no extra activation needed before use, unlike a
 * class. The signature is not in the source text but in the module's own
 * interface, which `CreateFunctionModule` leaves empty ("initial state") and
 * `UpdateFunctionModule` fills by writing `source/main`.
 */
export function functionModuleFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.functions.fmodules.v2+xml";

  return {
    id: "FunctionModule",
    nameParam: "function_module_name",
    parentParam: "function_group_name",
    adtType: "FUGR/FF",
    objectPath: (name, parent) => `/functions/groups/${lower(parent ?? "")}/fmodules/${lower(name)}`,
    collectionPath: (parent) => `/functions/groups/${lower(parent ?? "")}/fmodules`,
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    createBody: (context) =>
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<fmodule:abapFunctionModule xmlns:fmodule="http://www.sap.com/adt/functions/fmodules" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:description="${escapeXml(context.description.slice(0, 74))}" ` +
      `adtcore:language="${escapeXml(context.language)}" ` +
      `adtcore:name="${escapeXml(context.name)}" ` +
      `adtcore:type="FUGR/FF" ` +
      `adtcore:masterLanguage="${escapeXml(context.language)}" ` +
      `fmodule:processingType="${escapeXml(String(context.args["processing_type"] ?? "normal"))}" ` +
      'fmodule:releaseState="notReleased">' +
      // No packageRef: a function module is placed by its container.
      `<adtcore:containerRef adtcore:uri="/sap/bc/adt/functions/groups/${lower(context.parent ?? "")}" ` +
      `adtcore:type="FUGR/F" adtcore:name="${escapeXml(context.parent ?? "")}"/>` +
      "</fmodule:abapFunctionModule>",
    update: { kind: "source" },
    // Measured 2026-11-04: the ADT writer for an `FUGR/FF` source rejects the classic
    // interface comment block with `Parameter comment blocks are not allowed`, so a
    // caller copying a function module out of SE37 got a cryptic 400. The interface has
    // to be declared in the `FUNCTION … IMPORTING/EXPORTING … .` header instead — both
    // shapes below were measured, the comment one fails and the header one activates.
    beforeUpdate: async (_session, context) => {
      const source = typeof context.args["source_code"] === "string" ? context.args["source_code"] : "";
      if (/^\s*\*"/m.test(source)) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          "A function module source written over ADT must not carry an interface comment block (`*\"` lines): SAP answers \"Parameter comment blocks are not allowed\".",
          {
            nextAction:
              "Declare the interface in the FUNCTION header instead, e.g. FUNCTION zfm_x IMPORTING iv_count TYPE i EXPORTING ev_sum TYPE i. … ENDFUNCTION.",
          },
        );
      }
    },
    // SAP stores the signature and the implementation as two sections and
    // re-joins them with blank lines on read, so the active source never matches
    // what was written line for line.
    verification: "normalized",
  };
}

/**
 * Include (PROG/I): a source-only member of the program tree.
 *
 * Measured: it has its own collection (`/programs/includes`), its own media type
 * and its own root element — posting the program envelope there answers
 * `system expected element ...abapInclude`. Creating it alone leaves it outside
 * the program tree: `D010INC` has no row, the `PROG/I` node never appears in
 * `GetIncludesList`, and the include is dead weight. The row appears only when
 * the main program carries `INCLUDE <name>.` **and** is activated, so the three
 * contract flags are implemented in that order:
 *
 * - `insert_into_main` (default true) — append the statement to the main source.
 * - `activate_main_program` (default true) — activate the main program, which is
 *   what registers the include in `D010INC`.
 * - `skip_program_tree_check` (default false) — run a syntax check on the main
 *   program afterwards and report it.
 */
export function includeFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.programs.includes.v2+xml";
  const envelope = {
    root: "include:abapInclude",
    namespaces: [["include", "http://www.sap.com/adt/programs/includes"] as const],
  };

  /** The main program as the caller named it, or `undefined` when it was not given. */
  const mainOf = (context: CreateContext): string | undefined => {
    const main = context.args["main_program"];
    const value = typeof main === "string" ? main.trim() : "";
    return value.length === 0 ? undefined : value;
  };
  const mainPathOf = (main: string) => `${ADTPATH("/programs/programs")}/${lower(main)}`;

  /**
   * `INCLUDE <name>.` appended at the very end of the main program.
   *
   * Measured on the reference system (2026-11-04): putting the statement right after `REPORT`
   * makes the statement that follows it uncompilable — activating the main
   * program then answers `E "Statement is not accessible."` on that line, and the
   * include itself never activates because the program it belongs to does not
   * compile. Appended at the end it compiles and activates cleanly. This is also
   * the layout SAP's own generated programs use: `_TOP` includes carry the
   * declarations, `_F01`-style form includes sit at the bottom.
   */
  const withInclude = (source: string, name: string): string => {
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const statement = `INCLUDE ${lower(name)}.`;
    const present = source.trimEnd();
    return `${present}${eol}${eol}${statement}${eol}`;
  };

  return {
    id: "Include",
    nameParam: "include_name",
    adtType: "PROG/I",
    objectPath: (name) => `/programs/includes/${lower(name)}`,
    collectionPath: "/programs/includes",
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, "PROG/I"),
    afterCreate: async (session, context, objectPath) => {
      // `CreateInclude` takes an optional `source_code`, so the include exists with
      // its text instead of being an empty shell.
      const source = typeof context.args["source_code"] === "string" ? context.args["source_code"] : undefined;
      if (source !== undefined && source.trim().length > 0) {
        const lock = await lockObject(session, objectPath);
        try {
          await writeSource(session, sourceOf(objectPath), source, {
            lockHandle: lock.lockHandle,
            corrNr: lock.corrNr,
          });
        } finally {
          await unlockObject(session, objectPath, lock.lockHandle);
        }
      }

      if (context.args["insert_into_main"] === false) return { inserted_into_main: false };
      const main = mainOf(context);
      if (main === undefined) {
        return { inserted_into_main: false, insert_note: "main_program is required to register the include" };
      }
      const mainPath = mainPathOf(main);
      const mainSourcePath = sourceOf(mainPath);
      const current = await readSource(session, mainSourcePath, "active");
      const present = new RegExp(`^\\s*INCLUDE\\s+${lower(context.name)}\\s*\\.`, "im").test(current);
      if (present) {
        return { inserted_into_main: true, main_program: main, insert_note: "INCLUDE statement already present" };
      }
      const lock = await lockObject(session, mainPath);
      try {
        await writeSource(session, mainSourcePath, withInclude(current, context.name), {
          lockHandle: lock.lockHandle,
          corrNr: lock.corrNr,
        });
      } finally {
        await unlockObject(session, mainPath, lock.lockHandle);
      }
      return { inserted_into_main: true, main_program: main };
    },
    afterActivate: async (session, context) => {
      const main = mainOf(context);
      if (main === undefined) return {};
      if (context.args["insert_into_main"] === false) {
        return { main_program: main, main_program_activated: false };
      }
      const mainPath = mainPathOf(main);
      if (context.args["activate_main_program"] === false) {
        return {
          main_program: main,
          main_program_activated: false,
          d010inc_note: "not registered until the main program is activated",
        };
      }
      const report = await activate(session, [{ uri: `/sap/bc/adt${mainPath}`, name: main, adtType: "PROG/P" }]);
      const info: Record<string, unknown> = { main_program: main, main_program_activated: report.ok };
      if (!report.ok) info.main_activation_status = report.status;
      if (context.args["skip_program_tree_check"] !== true) {
        const check = await runCheck(session, `/sap/bc/adt${mainPath}`, "active");
        info.program_tree_check = {
          errors: check.errors,
          warnings: check.warnings,
          ...(check.unavailable === undefined ? {} : { unavailable: check.unavailable }),
          messages: check.messages,
        };
      }
      return info;
    },
    // `UpdateInclude.main_program`: an include only compiles inside its program, so
    // the check the caller asked for has to run on the main program.
    afterUpdate: async (session, context) => {
      const main = mainOf(context);
      if (main === undefined) return {};
      const mainPath = mainPathOf(main);
      const check = await runCheck(session, `/sap/bc/adt${mainPath}`, "active");
      return {
        main_program: main,
        program_tree_check: {
          errors: check.errors,
          warnings: check.warnings,
          ...(check.unavailable === undefined ? {} : { unavailable: check.unavailable }),
          messages: check.messages,
        },
      };
    },
    update: { kind: "source" },
  };
}

/** Service definition (SRVD): text source, same shape as a CDS view. */
export function serviceDefinitionFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.ddic.srvd.v1+xml";
  const envelope = {
    root: "srvd:srvdSource",
    namespaces: [["srvd", "http://www.sap.com/adt/ddic/srvdsources"] as const],
    // Measured 2026-11-04: without `srvd:srvdSourceType` the endpoint answers
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
    // No packageRef-only envelope: measured 2026-11-04, the endpoint answers
    // "the system expected element '{http://www.sap.com/adt/packages}attributes'" for a
    // flat document (SAP replies in the logon language; this system is Chinese).
    // The shape below (attributes / superPackage / transport / its software
    // component and layer as child elements) is the one the upstream client sends.
    createBody: (context) => {
      const requested = typeof context.args["software_component"] === "string" ? context.args["software_component"] : undefined;
      const transportLayer = typeof context.args["transport_layer"] === "string" ? context.args["transport_layer"] : "";
      // Measured 2026-11-04 on DS4/100, six combinations, none accepted (SAP answers in
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
    // Measured 2026-11-04: SAP's package write enqueues the package under the **current**
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

/**
 * Behaviour definition (BDEF).
 *
 * The create body is a `blue:blueSource` with an `adtTemplate` carrying
 * `implementation_type`. Without that property the server has no implementation
 * type to create from and rejects the request.
 */
export function behaviorDefinitionFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.blues.v1+xml";

  return {
    id: "BehaviorDefinition",
    nameParam: "name",
    nameParamByVerb: {
      Read: "behavior_definition_name",
      Get: "behavior_definition_name",
      Delete: "behavior_definition_name",
      Update: "name",
    },
    // The contract spells this one `CheckBdefLow`, not CheckBehaviorDefinitionLow.
    verbToolName: { "CheckBehaviorDefinitionLow": "CheckBdefLow" },
    adtType: "BDEF/BDO",
    objectPath: (name) => `/bo/behaviordefinitions/${lower(name)}`,
    collectionPath: "/bo/behaviordefinitions",
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    createBody: (context) =>
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:description="${escapeXml(context.description.slice(0, 60))}" ` +
      `adtcore:language="${escapeXml(context.language)}" ` +
      `adtcore:name="${escapeXml(context.name)}" ` +
      `adtcore:type="BDEF/BDO" ` +
      `adtcore:masterLanguage="${escapeXml(context.language)}">` +
      // No `adtTemplate`: measured 2026-11-04, any `adtProperty` here (`implementation_type`,
      // `root_entity`, both, with or without `abapLanguageVersion`) makes the server answer
      // 500 "Access using a 'ZERO' object reference is not possible". Without a template SAP
      // creates the skeleton `unmanaged; define behavior for <name> { }`, which is what the
      // caller then fills in with UpdateBehaviorDefinition.
      `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
      "</blue:blueSource>",
    update: { kind: "source" },
    verification: "readable",
  };
}

/**
 * Behaviour implementation (BIMP).
 *
 * Not an object of its own: the implementation text lives in a class include
 * (`/oo/classes/<name>/includes/implementations`), so this family writes a class
 * include rather than creating something new.
 */
export function behaviorImplementationFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.oo.classes.v2+xml";

  return {
    id: "BehaviorImplementation",
    nameParam: "behavior_implementation_name",
    // The contract names this argument `class_name` on every verb (measured 2026-11-04:
    // `CreateBehaviorImplementation {class_name}` answered `Missing "name"`).
    nameParamByVerb: {
      Create: "class_name",
      Update: "class_name",
      Read: "class_name",
      Get: "class_name",
      Delete: "class_name",
      Lock: "class_name",
      Unlock: "class_name",
      Activate: "class_name",
      Check: "class_name",
      Validate: "class_name",
    },
    // `UpdateBehaviorImplementation` takes `implementation_code` — the body of the
    // implementations include, not the whole class source.
    sourceParam: "implementation_code",
    adtType: "CLAS/OC",
    objectPath: (name) => `/oo/classes/${lower(name)}`,
    collectionPath: "/oo/classes",
    // The implementation body is a class include, not `source/main`.
    sourcePath: (objectPath) => `${objectPath}/includes/implementations`,
    media: { accept: media, contentType: media },
    // A behaviour implementation is a class whose definition says which behaviour it
    // implements. The create payload cannot express that, so the main source is written
    // right after: without the `FOR BEHAVIOR OF` clause the definition that references
    // this class cannot be activated.
    afterCreate: async (session, context, objectPath) => {
      const behaviour = typeof context.args["behavior_definition"] === "string" ? context.args["behavior_definition"].trim() : "";
      if (behaviour.length === 0) return { behaviour_note: "behavior_definition missing: the class is a plain class" };
      const definition = behaviourMainSource(context.name, behaviour);
      // `source/main` carries the whole class text (definition **and** the empty
      // implementation section); the implementations include holds only the method
      // bodies — measured 2026-11-04, sending the implementation section through the
      // include answered "The source code of this class is incomplete".
      const lock = await lockObject(session, objectPath);
      try {
        await writeSource(session, `${objectPath}/source/main`, definition, {
          lockHandle: lock.lockHandle,
          corrNr: lock.corrNr,
        });
      } finally {
        await unlockObject(session, objectPath, lock.lockHandle);
      }
      return { behaviour_implementation_for: behaviour };
    },
    // `UpdateBehaviorImplementation` carries the implementation body; the definition
    // clause that binds the class to its behaviour must already be in `source/main`
    // before activation, so it is written first.
    beforeUpdate: async (session, context, objectPath) => {
      const behaviour = typeof context.args["behavior_definition"] === "string" ? context.args["behavior_definition"].trim() : "";
      if (behaviour.length === 0) return;
      const mainSource = behaviourMainSource(context.name, behaviour);
      const lock = await lockObject(session, objectPath);
      try {
        await writeSource(session, `${objectPath}/source/main`, mainSource, {
          lockHandle: lock.lockHandle,
          corrNr: lock.corrNr,
        });
      } finally {
        await unlockObject(session, objectPath, lock.lockHandle);
      }
    },
    createBody: (context) =>
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:description="${escapeXml(context.description.slice(0, 60))}" ` +
      `adtcore:language="${escapeXml(context.language)}" ` +
      `adtcore:name="${escapeXml(context.name)}" ` +
      `adtcore:type="CLAS/OC" ` +
      `adtcore:masterLanguage="${escapeXml(context.language)}" ` +
      'class:final="false" class:abstract="false" class:visibility="public" class:category="generalObjectType">' +
      `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
      "</class:abapClass>",
    update: { kind: "source" },
    verification: "normalized",
  };
}

/**
 * The class text of a behaviour implementation.
 *
 * Measured 2026-11-04 against the upstream client: `source/main` holds the complete
 * class (definition plus an empty implementation section), while the implementations
 * include only carries method bodies. Sending the implementation section through the
 * include answers "The source code of this class is incomplete".
 */
function behaviourMainSource(className: string, behaviour: string): string {
  const name = lower(className);
  return (
    `CLASS ${name} DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF ${lower(behaviour)}.\n\n` +
    "ENDCLASS.\n\n" +
    `CLASS ${name} IMPLEMENTATION.\n\n` +
    "ENDCLASS."
  );
}

/** Service binding (SRVB): a document plus publish/unpublish jobs. */
export function serviceBindingFamily(): ObjectFamily {
  // Measured 2026-11-04: v1 is rejected ("Unsupported Media Type"); v2 is accepted,
  // and the document's namespace is `http://www.sap.com/adt/ddic/ServiceBindings`
  // (read from an existing standard binding, not guessed).
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
    // Measured shape: `srvb:services` (one `srvb:content` with the service definition
    // reference) and `srvb:binding` (type + implementation) are **siblings** — nesting
    // the binding inside `bindingTypeData` answers "the system expected the end of element
    // '{...}bindingTypeData'".
    createBody: (context) => {
      const serviceDefinition = String(context.args["service_definition_name"] ?? context.name);
      const version = String(context.args["binding_type"] ?? "").toUpperCase() === "ODATAV2" ? "V2" : "V4";
      const contentVersion = String(context.args["service_version"] ?? "0001");
      return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" ' +
        'xmlns:adtcore="http://www.sap.com/adt/core" ' +
        `adtcore:name="${escapeXml(context.name)}" adtcore:type="SRVB/SVB" ` +
        `adtcore:description="${escapeXml(context.description.slice(0, 60))}" ` +
        `adtcore:language="${escapeXml(context.language)}" adtcore:masterLanguage="${escapeXml(context.language)}" ` +
        'srvb:contract="C1" srvb:releaseSupported="true" srvb:published="false" ' +
        'srvb:bindingCreated="true" srvb:allowedAction="PUBLISH">' +
        `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
        `<srvb:services srvb:name="${escapeXml(context.name)}">` +
        `<srvb:content srvb:version="${escapeXml(contentVersion)}" srvb:minorVersion="0" srvb:patchVersion="0" ` +
        'srvb:buildVersion="" srvb:releaseState="NOT_RELEASED">' +
        `<srvb:serviceDefinition adtcore:uri="/sap/bc/adt/ddic/srvd/sources/${lower(serviceDefinition)}" ` +
        `adtcore:type="SRVD/SRV" adtcore:name="${escapeXml(serviceDefinition)}"/>` +
        '<srvb:bindingTypeData><adtcore:content adtcore:encoding="base64"/></srvb:bindingTypeData>' +
        "</srvb:content></srvb:services>" +
        `<srvb:binding srvb:type="ODATA" srvb:version="${version}" srvb:category="0">` +
        `<srvb:implementation adtcore:name="${escapeXml(context.name)}"/>` +
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

/** Families whose payload shape has been measured on the reference system. */
export const xmlFamilies: readonly ObjectFamily[] = [
  dataElementFamily(),
  domainFamily(),
  viewFamily(),
  metadataExtensionFamily(),
  functionGroupFamily(),
  functionModuleFamily(),
  includeFamily(),
  serviceDefinitionFamily(),
  packageFamily(),
  behaviorDefinitionFamily(),
  behaviorImplementationFamily(),
  serviceBindingFamily(),
];

export { ADTPATH };
