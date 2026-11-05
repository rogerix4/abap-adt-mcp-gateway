/**
 * Data preview parsing.
 *
 * The answer is column-major, and `totalRows` lies — both measured on the
 * reference system, and both are the kind of thing that silently yields zero
 * rows if read like a normal table.
 */

import { describe, expect, it } from "vitest";

import { parseDataPreview } from "../src/adt/datapreview.js";

const answer =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  "<dataPreview:totalRows>0</dataPreview:totalRows>" +
  "<dataPreview:executedQueryString>SELECT TABNAME FROM DD02L   UP TO 5  ROWS</dataPreview:executedQueryString>" +
  "<dataPreview:columns>" +
  '<dataPreview:metadata dataPreview:name="TABNAME" dataPreview:type="C"/>' +
  "<dataPreview:dataSet><dataPreview:data>TADIR</dataPreview:data><dataPreview:data>DD02L</dataPreview:data></dataPreview:dataSet>" +
  "</dataPreview:columns>" +
  "<dataPreview:columns>" +
  '<dataPreview:metadata dataPreview:name="TABCLASS" dataPreview:type="C"/>' +
  "<dataPreview:dataSet><dataPreview:data>TRANSP</dataPreview:data><dataPreview:data>TRANSP</dataPreview:data></dataPreview:dataSet>" +
  "</dataPreview:columns>" +
  "</dataPreview:tableData>";

describe("parseDataPreview", () => {
  it("zips column blocks into rows", () => {
    const preview = parseDataPreview(answer);
    expect(preview.columns).toEqual(["TABNAME", "TABCLASS"]);
    expect(preview.rows).toEqual([
      { TABNAME: "TADIR", TABCLASS: "TRANSP" },
      { TABNAME: "DD02L", TABCLASS: "TRANSP" },
    ]);
  });

  it("trusts the row set, not totalRows", () => {
    // The counter says 0 while two rows are present; reading it would report an
    // empty result for a query that returned data.
    expect(answer).toContain("<dataPreview:totalRows>0</dataPreview:totalRows>");
    expect(parseDataPreview(answer).rows).toHaveLength(2);
    expect(parseDataPreview(answer).executedQuery).toContain("UP TO 5");
  });
});
