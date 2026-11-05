/**
 * The stale-session check answer.
 *
 * Measured on a live system: an object that was just written and activated comes back
 * from `/checkruns` with a string of `fixed point arithmetic` errors and `Field "X" is
 * unknown` for every inline `@DATA(...)`. Nothing is wrong with the source — the session
 * reads an outdated attribute — and the same request in a fresh session answers clean.
 * Handing those nine errors to the caller sends it off to change working code.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { runCheck } from "../src/adt/lifecycle.js";
import { AdtSession } from "../src/adt/session.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-check-${process.pid}.json`);

const message = (text: string, severity = "E"): string =>
  `<chkrun:message chkrun:type="${severity}" chkrun:uri="/sap/bc/adt/programs/programs/zz_probe">` +
  `<chkrun:shortText>${text}</chkrun:shortText></chkrun:message>`;

const answer = (...messages: string[]): string =>
  '<?xml version="1.0" encoding="utf-8"?><chkrun:checkMessages xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
  messages.join("") +
  "</chkrun:checkMessages>";

function sessionAnswering(...bodies: string[]): { session: AdtSession; checks: number[] } {
  const checks: number[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/discovery")) {
      return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "token" } });
    }
    checks.push(index);
    const body = bodies[Math.min(index, bodies.length - 1)] ?? answer();
    index += 1;
    return new Response(body, { status: 200, headers: { "x-csrf-token": "token" } });
  }) as typeof fetch;
  return {
    checks,
    session: new AdtSession({
      url: "https://sap.example.com:44300",
      client: "100",
      language: "EN",
      username: "U",
      password: "P",
      fetchImpl,
    }),
  };
}

const URI = "/sap/bc/adt/programs/programs/zz_probe";

describe("the check answer", () => {
  it("is retried once after a reset when it is the stale-session shape", async () => {
    const { session, checks } = sessionAnswering(
      answer(
        message(
          "This Open SQL statement uses additions that can only be used when fixed point arithmetic is switched on",
        ),
        message('Field "LT_X" is unknown'),
      ),
      answer(message("real problem only", "W")),
    );

    const result = await runCheck(session, URI);

    expect(checks).toHaveLength(2);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(1);
    expect(result.messages[0]?.text).toBe("real problem only");
  });

  it("is retried once when several errors carry identical text", async () => {
    const { session, checks } = sessionAnswering(
      answer(message("Field \"<FS>\" is unknown"), message('Field "<FS>" is unknown'), answer()),
      answer(),
    );

    const result = await runCheck(session, URI);

    expect(checks).toHaveLength(2);
    expect(result.errors).toBe(0);
  });

  it("is taken at face value when the errors are distinct", async () => {
    const { session, checks } = sessionAnswering(
      answer(message("Syntax error in line 3"), message("Method X is not implemented")),
    );

    const result = await runCheck(session, URI);

    expect(checks).toHaveLength(1);
    expect(result.errors).toBe(2);
  });

  it("is retried only once, even when the second answer looks the same", async () => {
    const same = answer(message("... fixed point arithmetic ..."), message("other"));
    const { session, checks } = sessionAnswering(same, same, same);

    const result = await runCheck(session, URI);

    expect(checks).toHaveLength(2);
    expect(result.errors).toBe(2);
  });

  it("is read when SAP spells the message as a self-closing checkMessage", async () => {
    // Measured 2026-11-04 on a CDS view: the reporter answers
    // `<chkrun:checkMessage chkrun:type="E" chkrun:shortText="…" …/>` — a different
    // element name with the text in an attribute. The parser demanded
    // `<chkrun:message>` with an inner `<chkrun:shortText>` and saw nothing, so a view
    // SAP refused to activate was reported as `errors: 0`.
    const { session } = sessionAnswering(
      '<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
        '<chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="/sap/bc/adt/ddic/ddl/sources/zi_probe" chkrun:status="processed">' +
        "<chkrun:checkMessageList>" +
        '<chkrun:checkMessage chkrun:uri="/sap/bc/adt/ddic/ddl/sources/zi_probe/source/main#start=6,6;end=6,11"' +
        ' chkrun:type="E" chkrun:shortText="The column landx is unknown" chkrun:code="SDDL_PARSER_MSG(010)"/>' +
        "</chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>",
    );

    const result = await runCheck(session, URI);

    expect(result.errors).toBe(1);
    expect(result.messages[0]?.text).toBe("The column landx is unknown");
    expect(result.messages[0]?.line).toBe(6);
  });
});
