/**
 * Program family: URI, media types and create payload.
 *
 * Measured against BASIS 754; see docs/evidence/activation.md for the lifecycle
 * behaviour that the handlers rely on.
 */

import { escapeXml, lower, type ObjectFamily } from "./types.js";

const ACCEPT = "application/vnd.sap.adt.programs.programs.v2+xml";

/**
 * ADT program type codes, as the upstream baseline sends them (1 / I / M / F / K / J).
 *
 * Measured 2026-11-04: this attribute is **ignored** by the create endpoint on our
 * stack — a program requested as `module_pool` is created as `executableProgram`
 * (`TRDIR-SUBC = 1`), with either the numeric code or the document's own vocabulary
 * (`programType="modulePool"`), and a later PUT of the document does not change it
 * either. Kept as-is for parity with the upstream client; callers must not assume the
 * type took effect. Screens can still be created on such a program (measured: dynpro
 * insert answers subrc=0).
 */
const PROGRAM_TYPE_CODES: Record<string, string> = {
  executable: "1",
  include: "I",
  module_pool: "M",
  function_group: "F",
  class_pool: "K",
  interface_pool: "J",
};

export const programFamily: ObjectFamily = {
  id: "Program",
  nameParam: "program_name",
  adtType: "PROG/P",
  objectPath: (name) => `/programs/programs/${lower(name)}`,
  collectionPath: "/programs/programs",
  sourcePath: (objectPath) => `${objectPath}/source/main`,
  media: { accept: ACCEPT, contentType: ACCEPT },
  createBody: ({ name, description, packageName, language, args }) => {
    const programType = typeof args["program_type"] === "string" ? args["program_type"] : "executable";
    const application = typeof args["application"] === "string" ? args["application"] : "*";
    const code = PROGRAM_TYPE_CODES[programType] ?? "1";
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:description="${escapeXml(description.slice(0, 60))}" adtcore:language="${escapeXml(language)}" ` +
      `adtcore:name="${escapeXml(name)}" adtcore:masterLanguage="${escapeXml(language)}" adtcore:type="PROG/P" ` +
      `program:programType="${code}" program:application="${escapeXml(application)}">` +
      `<adtcore:packageRef adtcore:name="${escapeXml(packageName)}"/></program:abapProgram>`
    );
  },
  update: { kind: "source" },
};
