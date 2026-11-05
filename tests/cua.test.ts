/**
 * CUA create: copy one status, not the reference program's whole status list.
 *
 * Measured on a live system: `CreateGuiStatus` copied all 40 SAPLKKBL statuses and
 * then added the new one, so the target program's SE41 status list was polluted. The
 * reference document has ~40 `STA` rows; only `STANDARD_FULLSCREEN` (and the rows it
 * needs) may be carried over.
 */

import { describe, expect, it } from "vitest";

import { narrowReferenceStatus } from "../src/tools/bridges.js";

function referenceDocument(): Record<string, unknown> {
  return {
    ADM: { MENCODE: "000102", PFKCODE: "000045" },
    STA: [
      { CODE: "STANDARD_FULLSCREEN", MODAL: "D", PFKCODE: "000045", INT_NOTE: "Standard" },
      { CODE: "OTHER_STATUS", MODAL: "D", PFKCODE: "000046", INT_NOTE: "Other" },
    ],
    SET: [
      { STATUS: "STANDARD_FULLSCREEN", FUNCTION: "F1" },
      { STATUS: "STANDARD_FULLSCREEN", FUNCTION: "F2" },
      { STATUS: "OTHER_STATUS", FUNCTION: "F3" },
    ],
    FUN: [{ CODE: "F1" }, { CODE: "F2" }, { CODE: "F3" }],
    PFK: [{ PFK_CODE: "000045", CODE: "0001" }, { PFK_CODE: "000046", CODE: "0001" }],
    BUT: [{ PFK_CODE: "000045", CODE: "0001" }, { PFK_CODE: "000046", CODE: "0001" }],
    MEN: [{ CODE: "000102" }],
    MTX: [{ CODE: "000102", TEXT: "Menu" }],
    ACT: [{ CODE: "000102", NO: "01" }],
    DOC: [{ OBJ_TYPE: "X", OBJ_CODE: "Y" }],
    TIT: [{ CODE: "003", TEXT: "&" }],
    BIV: [],
  };
}

describe("the CUA reference copy", () => {
  it("keeps only the copied status and the rows it refers to", () => {
    const result = narrowReferenceStatus(referenceDocument(), "0001", "My status", "D");

    expect(result).toBeDefined();
    expect(result?.STA).toHaveLength(1);
    expect((result?.STA as Array<Record<string, unknown>>)[0]).toMatchObject({
      CODE: "0001",
      MODAL: "D",
      INT_NOTE: "My status",
    });
    expect((result?.SET as Array<Record<string, unknown>>).map((row) => row["STATUS"])).toEqual(["0001", "0001"]);
    expect((result?.FUN as Array<Record<string, unknown>>).map((row) => row["CODE"])).toEqual(["F1", "F2"]);
    expect((result?.PFK as Array<Record<string, unknown>>).map((row) => row["PFK_CODE"])).toEqual(["000045"]);
    expect((result?.BUT as Array<Record<string, unknown>>).map((row) => row["PFK_CODE"])).toEqual(["000045"]);
    // These are not status rows and stay as they are.
    expect(result?.TIT).toEqual([{ CODE: "003", TEXT: "&" }]);
    expect(result?.MEN).toEqual([{ CODE: "000102" }]);
  });

  it("answers undefined when the reference has no STANDARD_FULLSCREEN status", () => {
    const document = referenceDocument();
    document["STA"] = [{ CODE: "OTHER_STATUS" }];

    expect(narrowReferenceStatus(document, "0001", undefined, "D")).toBeUndefined();
  });
});
