/**
 * Function module (`FUGR/FF`): has no address of its own, it lives inside a group.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { GatewayError } from "../../engine/errors.js";
import { escapeXml, lower, type ObjectFamily } from "../types.js";

const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

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
    // Measured: the ADT writer for an `FUGR/FF` source rejects the classic
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
    // SAP stores the signature and the implementation as two sections and re-joins them on read,
    // and how it lays the text out (keyword case, where `IMPORTING` starts a line) depends on the
    // system's editor / pretty-printer setup, not on anything the caller controls. So compare the
    // **token stream** — line breaks, whitespace and case outside literals are irrelevant, a missing
    // statement or a changed literal is not (measured: `UpdateFunctionModule` answered
    // `activated: false` on a write that SAP had stored correctly, only reformatted).
    verification: "tokens",
  };
}
