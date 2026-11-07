/**
 * dataElement family.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { patchAttribute, patchElement } from "../../adt/xml-patch.js";
import { propertyValues } from "../spec/properties.js";
import { escapeXml, lower, type CreateContext, type ObjectFamily } from "../types.js";

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
        // Same two layers as the domain patch: the contract puts the payload in `properties`, and
        const values = propertyValues(context.args);
        const arg = (key: string): string | undefined => values[key];
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
