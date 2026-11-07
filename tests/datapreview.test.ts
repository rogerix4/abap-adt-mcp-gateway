/**
 * Data preview parsing.
 *
 * The answer is column-major, and `totalRows` lies — both measured on the
 * reference system, and both are the kind of thing that silently yields zero
 * rows if read like a normal table.
 */

import { describe, expect, it } from "vitest";

import { parseDataPreview, parseDataPreviewDetailed } from "../src/adt/datapreview.js";

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

  it("reads metadata attributes in any order and decodes cell values", () => {
    // `name` used to have to come first in the metadata element, and a cell holding
    // `<FS>` was returned still escaped (`&lt;FS&gt;`) — a wrong answer, silently.
    const markedUp =
      '<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
      "<dataPreview:columns>" +
      '<dataPreview:metadata dataPreview:type="C" dataPreview:name="FIELD"/>' +
      "<dataPreview:dataSet><dataPreview:data>&lt;FS&gt; &amp; &quot;quoted&quot;</dataPreview:data></dataPreview:dataSet>" +
      "</dataPreview:columns>" +
      "</dataPreview:tableData>";

    const preview = parseDataPreview(markedUp);
    expect(preview.columns).toEqual(["FIELD"]);
    expect(preview.rows).toEqual([{ FIELD: '<FS> & "quoted"' }]);
  });

  it("keeps a row whose only cell is empty", () => {
    // One `<data/>` is one row with an empty value, not zero rows: the cell missing
    // from the parsed tree must not shrink the result set.
    const empty =
      '<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
      "<dataPreview:columns>" +
      '<dataPreview:metadata dataPreview:name="FIELD"/>' +
      "<dataPreview:dataSet><dataPreview:data/></dataPreview:dataSet>" +
      "</dataPreview:columns>" +
      "</dataPreview:tableData>";

    expect(parseDataPreview(empty).rows).toEqual([{ FIELD: "" }]);
  });
});

/** Trimmed from the live answer of `GetTableContents T000` on DS4/100. */
const T000 = `<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"><dataPreview:totalRows>0</dataPreview:totalRows><dataPreview:name>T000</dataPreview:name><dataPreview:columns><dataPreview:metadata dataPreview:name="MANDT" dataPreview:type="C" dataPreview:description="客户端" dataPreview:keyAttribute="false" dataPreview:colType="CLNT" dataPreview:length="3"/><dataPreview:dataSet><dataPreview:data>000</dataPreview:data><dataPreview:data>100</dataPreview:data></dataPreview:dataSet></dataPreview:columns><dataPreview:columns><dataPreview:metadata dataPreview:name="MTEXT" dataPreview:type="C" dataPreview:description="名称" dataPreview:keyAttribute="false" dataPreview:colType="CHAR" dataPreview:length="25"/><dataPreview:dataSet><dataPreview:data>SAP SE</dataPreview:data><dataPreview:data>Custom Client</dataPreview:data></dataPreview:dataSet></dataPreview:columns></dataPreview:tableData>`;

describe("parseDataPreviewDetailed", () => {
  it("keeps the metadata GetTableContents promises", () => {
    const detailed = parseDataPreviewDetailed(T000);
    expect(detailed.columns.map((column) => column.name)).toEqual(["MANDT", "MTEXT"]);
    expect(detailed.columns[1]).toMatchObject({ type: "CHAR", description: "名称", length: 25, key: false });
  });

  it("uses the rows, not the unreliable totalRows counter", () => {
    // The live document says totalRows=0 while two rows are present.
    expect(parseDataPreviewDetailed(T000).rows).toEqual([
      { MANDT: "000", MTEXT: "SAP SE" },
      { MANDT: "100", MTEXT: "Custom Client" },
    ]);
  });

  it("reads the key flag in either boolean spelling SAP uses", () => {
    // The DDIC preview sends `keyAttribute="false"` for every column — even for the client
    // key of T000 (measured ), so a caller cannot read keys off this document.
    // AS-XML answers spell the same flag `X`; both spellings are understood.
    const withKey = T000.replace(/dataPreview:keyAttribute="false" dataPreview:colType="CLNT"/, 'dataPreview:keyAttribute="X" dataPreview:colType="CLNT"');
    expect(parseDataPreviewDetailed(withKey).columns[0]?.key).toBe(true);
    expect(parseDataPreviewDetailed(T000).columns[0]?.key).toBe(false);
  });
});
