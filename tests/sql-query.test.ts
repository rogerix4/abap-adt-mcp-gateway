/**
 * `GetSqlQuery` runs through ADT Data Preview, whose endpoint wraps the text in
 * `SELECT ... INTO TABLE ... UP TO n ROWS`. A non-SELECT statement or a second
 * statement is not an SAP syntax question; it cannot work by construction.
 */

import { describe, expect, it } from "vitest";

import { precheckSqlQuery } from "../src/tools/read.js";

describe("the GetSqlQuery precheck", () => {
  it("accepts one SELECT and trims the text", () => {
    expect(precheckSqlQuery("  select * from t001  ")).toBe("select * from t001");
  });

  it("rejects statements that are not SELECT", () => {
    expect(() => precheckSqlQuery("UPDATE t001 SET BUTXT = ''")).toThrow(/only runs SELECT/i);
    expect(() => precheckSqlQuery("WITH x AS (SELECT * FROM t001) SELECT * FROM x")).toThrow(/only runs SELECT/i);
  });

  it("rejects a second statement", () => {
    expect(() => precheckSqlQuery("SELECT * FROM t001; DELETE FROM t001")).toThrow(/one statement/i);
  });
});
