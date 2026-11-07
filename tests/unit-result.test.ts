/**
 * Reading an ABAP Unit result.
 *
 * Both fixtures are the documents SAP actually answered on DS4/100 on for
 * `ZCL_MCP_T01` / `LTCL_GREET->RETURNS_TEXT` — one passing, one failing. Before the
 * summary existed, **both** came back as `success: true`: the failure lived only inside
 * `raw_xml`, and nothing a caller branches on said the test had failed.
 */

import { describe, expect, it } from "vitest";

import { parseUnitResult, parseUnitStatus } from "../src/tools/unit-result.ts";

const PASSING = `<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program adtcore:uri="/sap/bc/adt/oo/classes/zcl_mcp_t01" adtcore:type="CLAS/OC" adtcore:name="ZCL_MCP_T01" uriType="semantic" xmlns:adtcore="http://www.sap.com/adt/core"><testClasses><testClass adtcore:uri="/sap/bc/adt/oo/classes/zcl_mcp_t01#testclass=LTCL_GREET" adtcore:type="CLAS/OP" adtcore:name="LTCL_GREET" uriType="semantic" durationCategory="short" riskLevel="harmless"><testMethods><testMethod adtcore:uri="/sap/bc/adt/oo/classes/zcl_mcp_t01#testclass=LTCL_GREET;testmethod=RETURNS_TEXT" adtcore:type="CLAS/OLI" adtcore:name="RETURNS_TEXT" executionTime="0" uriType="semantic" unit="s"/></testMethods></testClass></testClasses></program></aunit:runResult>`;

const FAILING = `<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program adtcore:uri="/sap/bc/adt/oo/classes/zcl_mcp_t01" adtcore:type="CLAS/OC" adtcore:name="ZCL_MCP_T01" uriType="semantic" xmlns:adtcore="http://www.sap.com/adt/core"><testClasses><testClass adtcore:uri="/sap/bc/adt/oo/classes/zcl_mcp_t01#testclass=LTCL_GREET" adtcore:type="CLAS/OP" adtcore:name="LTCL_GREET" uriType="semantic" durationCategory="short" riskLevel="harmless"><testMethods><testMethod adtcore:uri="/sap/bc/adt/oo/classes/zcl_mcp_t01#testclass=LTCL_GREET;testmethod=RETURNS_TEXT" adtcore:type="CLAS/OLI" adtcore:name="RETURNS_TEXT" executionTime="0.03" uriType="semantic" unit="s"><alerts><alert kind="failedAssertion" severity="critical"><title>严重断言错误：'Returns_Text: ASSERT_EQUALS'</title><details><detail text="字符串从头开始不同"><details><detail text="  预期 [definitely not hello] 实际 [hello from low]"/></details></detail><detail text="主程序 'ZCL_MCP_T01===================CP' 中的测试 'LTCL_GREET-&gt;RETURNS_TEXT'"/></details></alert></alerts></testMethod></testMethods></testClass></testClasses></program></aunit:runResult>`;

describe("parseUnitResult", () => {
  it("reports a passing run as success with its counts", () => {
    expect(parseUnitResult(PASSING)).toMatchObject({
      success: true,
      programs: 1,
      test_classes: 1,
      tests: 1,
      failures: 0,
      alerts: [],
    });
  });

  it("reports a failing run as not success, and carries the assertion message", () => {
    const summary = parseUnitResult(FAILING);
    expect(summary?.success).toBe(false);
    expect(summary?.failures).toBe(1);
    expect(summary?.tests).toBe(1);
    expect(summary?.alerts[0]).toMatchObject({
      kind: "failedAssertion",
      severity: "critical",
      method: "RETURNS_TEXT",
    });
    expect(summary?.alerts[0]?.title).toContain("ASSERT_EQUALS");
  });

  it("reports an empty result document as zero tests, not as a pass", () => {
    // What SAP answers when nothing ran — e.g. the test include is still inactive.
    expect(parseUnitResult('<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"/>')).toEqual({
      success: true,
      programs: 0,
      test_classes: 0,
      tests: 0,
      failures: 0,
      alerts: [],
    });
  });

  it("ignores a body that is not a result document", () => {
    expect(parseUnitResult("<html>not this</html>")).toBeUndefined();
  });
});

describe("parseUnitStatus", () => {
  it("reads the progress element", () => {
    expect(
      parseUnitStatus('<aunit:run xmlns:aunit="http://www.sap.com/adt/api/aunit"><aunit:progress status="FINISHED" percentage="100"/></aunit:run>'),
    ).toEqual({ finished: true, status: "FINISHED", percentage: 100 });
  });

  it("answers undefined when the document has no progress element", () => {
    expect(parseUnitStatus("<aunit:run/>")).toBeUndefined();
  });
});
