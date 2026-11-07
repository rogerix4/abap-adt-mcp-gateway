/**
 * Function group (`FUGR/F`): a container whose source is generated from its includes,
 * so only its description is editable.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { patchAttribute } from "../../adt/xml-patch.js";
import { lower, renderCreateBody, type ObjectFamily } from "../types.js";

const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

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
    // Measured: `/checkruns` on a function group checks the *generated*
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
