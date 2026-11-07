/**
 * Behaviour definition (`BDEF`, `BDEF/BDO`).
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { escapeXml, lower, type ObjectFamily } from "../types.js";

const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

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
      // No `adtTemplate`: measured, any `adtProperty` here (`implementation_type`,
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
