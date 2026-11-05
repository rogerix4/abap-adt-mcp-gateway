/**
 * The session mechanics that keep a lock *usable*.
 *
 * Each test fixes one visible symptom, measured on a live system: a lock that SAP
 * still reports in SM12 while the handle can no longer unlock it, so every later
 * write answers 403 "currently editing".
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";

const LOCK_BODY =
  "<asx:abap><asx:values><DATA><LOCK_HANDLE>HANDLE0001</LOCK_HANDLE></DATA></asx:values></asx:abap>";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function sessionWith(
  answer: (sent: Sent) => { status: number; body: string; setCookie?: string[] },
): { session: AdtSession; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const record = { url, method: init?.method ?? "GET", headers };
    sent.push(record);
    // The CSRF handshake keeps the session usable; it is not what these tests look at.
    if (url.includes("/discovery")) {
      return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "token" } });
    }
    const result = answer(record);
    const responseHeaders: Record<string, string> = { "x-csrf-token": "token" };
    if (result.setCookie === undefined) return new Response(result.body, { status: result.status, headers: responseHeaders });
    const withCookies = new Headers(responseHeaders);
    for (const cookie of result.setCookie) withCookies.append("set-cookie", cookie);
    return new Response(result.body, { status: result.status, headers: withCookies });
  }) as typeof fetch;

  return {
    sent,
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

const lock = (session: AdtSession) =>
  session.request({ method: "POST", path: "/programs/programs/zz_probe?_action=LOCK&accessMode=MODIFY", accept: "*/*" });

beforeEach(() => {
  process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(mkdtempSync(join(tmpdir(), "session-locks-")), "locks.json");
});

describe("stateful context while a lock is held", () => {
  it("does not let a stateless answer wipe the context that holds the handle", async () => {
    let reply: { status: number; body: string; setCookie?: string[] };
    const holder = sessionWith(() => reply);
    reply = { status: 200, body: LOCK_BODY };
    await lock(holder.session);

    // A request that ran outside the stateful context answers sap-contextid=0.
    reply = {
      status: 200,
      body: "<ok/>",
      setCookie: ["sap-contextid=abc123; path=/", "sap-contextid=0; path=/"],
    };
    await holder.session.request({ method: "POST", path: "/checkruns", accept: "*/*", contentType: "text/plain", body: "x" });
    await holder.session.request({ method: "GET", path: "/next", accept: "*/*" });

    const after = holder.sent[holder.sent.length - 1];
    expect(after?.headers["cookie"]).toContain("sap-contextid=abc123");
    expect(after?.headers["cookie"]).not.toContain("sap-contextid=0");
  });

  it("pins the configured client in sap-usercontext", async () => {
    const { session, sent } = sessionWith(() => ({
      status: 200,
      body: "<ok/>",
      setCookie: ["sap-usercontext=sap-client=999; path=/"],
    }));
    await session.request({ method: "GET", path: "/first", accept: "*/*" });
    await session.request({ method: "GET", path: "/second", accept: "*/*" });

    expect(sent[sent.length - 1]?.headers["cookie"]).toContain("sap-usercontext=sap-client=100");
  });

  it("keeps sending a stateful header even when a caller asks for stateless while locked", async () => {
    const { session, sent } = sessionWith(() => ({ status: 200, body: LOCK_BODY }));
    await lock(session);
    await session.request({ method: "GET", path: "/somewhere", accept: "*/*", stateful: false });

    expect(sent[sent.length - 1]?.headers["x-sap-adt-sessiontype"]).toBe("stateful");
  });
});

describe("an expired CSRF token", () => {
  it("is fetched again and the write replayed once", async () => {
    let first = true;
    const { session, sent } = sessionWith((request) => {
      if (request.url.includes("/programs/programs/zz_probe") && first) {
        first = false;
        return { status: 403, body: "<exc:exception><message>CSRF token validation failed</message></exc:exception>" };
      }
      return { status: 200, body: "<ok/>" };
    });

    const result = await session.request({ method: "PUT", path: "/programs/programs/zz_probe/source/main", accept: "*/*" });

    expect(result.status).toBe(200);
    const writes = sent.filter((entry) => entry.method === "PUT");
    expect(writes).toHaveLength(2);
    expect(sent.filter((entry) => entry.url.includes("/discovery")).length).toBeGreaterThanOrEqual(2);
  });

  it("still reports the failure when the second attempt fails too", async () => {
    const { session } = sessionWith(() => ({
      status: 403,
      body: "<exc:exception><message>CSRF token validation failed</message></exc:exception>",
    }));

    await expect(
      session.request({ method: "PUT", path: "/programs/programs/zz_probe/source/main", accept: "*/*" }),
    ).rejects.toThrow(/CSRF/);
  });
});
