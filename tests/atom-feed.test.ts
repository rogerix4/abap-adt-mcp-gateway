/**
 * Atom feeds, parsed.
 *
 * Measured live on DS4/100: `RuntimeListFeeds {max_results: 3}` answered 24 KB of
 * `raw_xml`, `RuntimeGetGatewayErrorLog {max_results: 3}` 56 KB and
 * `RuntimeListProfilerTraceFiles` 564 KB — three tools whose `max_results` reached nothing and
 * whose description promised a parsed payload. One parser serves all three now.
 */

import { describe, expect, it } from "vitest";

import { parseAtomFeed } from "../src/tools/atom-feed.ts";

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
  <atom:title>ABAP System Monitoring</atom:title>
  <atom:updated>2026-11-06T18:52:47Z</atom:updated>
  <atom:entry>
    <atom:author><atom:name>CON_DP</atom:name></atom:author>
    <atom:content type="application/atom+xml" src="/sap/bc/adt/gw/errorlog"/>
    <atom:id>/sap/bc/adt/gw/errorlog</atom:id>
    <atom:published>2026-10-01T08:00:00Z</atom:published>
    <atom:summary>SAP Gateway Error Log</atom:summary>
    <atom:title>SAP Gateway Error Log</atom:title>
  </atom:entry>
  <atom:entry>
    <atom:author><atom:name>CON_YHB</atom:name></atom:author>
    <atom:id>/sap/bc/adt/runtime/systemmessages</atom:id>
    <atom:published>2026-11-05T09:00:00Z</atom:published>
    <atom:title>System Messages</atom:title>
  </atom:entry>
</atom:feed>`;

describe("parseAtomFeed", () => {
  it("answers entries newest first, with the resource each one points at", () => {
    const feed = parseAtomFeed(FEED);
    expect(feed?.title).toBe("ABAP System Monitoring");
    expect(feed?.count).toBe(2);
    expect(feed?.truncated).toBe(false);
    expect(feed?.entries[0]).toMatchObject({
      title: "System Messages",
      author: "CON_YHB",
      published: "2026-11-05T09:00:00Z",
    });
    expect(feed?.entries[1]).toMatchObject({ content_src: "/sap/bc/adt/gw/errorlog", summary: "SAP Gateway Error Log" });
  });

  it("honours the limit and says whether it cut anything", () => {
    const feed = parseAtomFeed(FEED, { limit: 1 });
    expect(feed?.count).toBe(2);
    expect(feed?.truncated).toBe(true);
    expect(feed?.entries).toHaveLength(1);
    expect(feed?.entries[0]?.title).toBe("System Messages");
  });

  it("filters by user and by date window", () => {
    expect(parseAtomFeed(FEED, { user: "con_yhb" })?.entries.map((entry) => entry.title)).toEqual(["System Messages"]);
    expect(parseAtomFeed(FEED, { from: "2026-11-01" })?.entries.map((entry) => entry.title)).toEqual(["System Messages"]);
    expect(parseAtomFeed(FEED, { to: "2026-10-02" })?.entries.map((entry) => entry.title)).toEqual(["SAP Gateway Error Log"]);
  });

  it("answers undefined for a body that is not a feed", () => {
    expect(parseAtomFeed("<html><body>nope</body></html>")).toBeUndefined();
    expect(parseAtomFeed("")).toBeUndefined();
  });
});
