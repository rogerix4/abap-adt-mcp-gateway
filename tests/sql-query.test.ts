/**
 * `GetSqlQuery` runs through ADT Data Preview, whose endpoint wraps the text in
 * `SELECT ... INTO TABLE ... UP TO n ROWS`. A non-SELECT statement or a second
 * statement is not an SAP syntax question; it cannot work by construction.
 */

import { describe, expect, it } from "vitest";

import { classifySqlQueryFailure, precheckSqlQuery } from "../src/tools/read.js";

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

  it("points AS4TEXT at E07T instead of E070", () => {
    const failure = classifySqlQueryFailure('ADT answered HTTP 400: Unknown column name "AS4TEXT".', 400);
    expect(failure).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(failure?.nextAction).toContain("E07T");
  });

  it("explains that header fields belong to E070, not E07T", () => {
    const failure = classifySqlQueryFailure('ADT answered HTTP 400: Unknown column name "AS4USER".', 400);
    expect(failure).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(failure?.nextAction).toContain("E070");
    expect(failure?.nextAction).toContain("separately");
  });

  it("explains that Data Preview rejects joins", () => {
    const failure = classifySqlQueryFailure("ADT answered HTTP 400: 仅允许一个 SELECT 语句。", 400);
    expect(failure).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(failure?.nextAction).toContain("JOIN");
    expect(failure?.nextAction).toContain("separately");
  });

  it("does not turn an ADT internal 500 into an invalid-SQL verdict", () => {
    const failure = classifySqlQueryFailure(
      "SAP reported a server error: Application Server Error 500 Internal Server Error Invalid access with negative length to a string",
      500,
    );
    expect(failure).toMatchObject({ code: "UPSTREAM_FAILED" });
    expect(failure?.nextAction).toMatch(/simplify|GetTableContents/i);
  });

  it("explains the one-character language key", () => {
    const failure = classifySqlQueryFailure("ADT answered HTTP 400: 'ZH' 不是 C(1,0) 的有效值。", 400);
    expect(failure).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(failure?.nextAction).toContain("'1'");
  });
});
