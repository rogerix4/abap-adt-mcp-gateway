/**
 * ADT layer tests.
 *
 * Offline: `fetch` is replaced by a scripted fake, so these assert the request
 * shape (session headers, CSRF, cookies, lock handles) and the reading of
 * responses that are easy to misjudge — an empty 200 activation, a 403 that
 * means "still locked", a 500 that means "nothing to check".
 */

import { describe, expect, it } from "vitest";

import { AdtError } from "../src/adt/errors.ts";
import { activate, compareSource, deleteObject, lockObject, runCheck, writeSource } from "../src/adt/lifecycle.ts";
import { AdtSession } from "../src/adt/session.ts";

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

interface FakeResponse {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string | string[]>;
}

function fakeFetch(script: FakeResponse[]) {
  const calls: Recorded[] = [];
  let index = 0;

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const step = script[index] ?? script.at(-1) ?? { status: 500 };
    index += 1;

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(step.headers ?? {})) {
      for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(key, entry);
    }

    return {
      status: step.status,
      headers: responseHeaders,
      text: async () => step.body ?? "",
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const SESSION = {
  url: "https://sap.example.com:44300",
  client: "400",
  language: "ZH",
  username: "u",
  password: "p",
};

function session(script: FakeResponse[]) {
  const fake = fakeFetch(script);
  const adt = new AdtSession({ ...SESSION, fetchImpl: fake.impl });
  return { adt, calls: fake.calls };
}

const CSRF = { status: 200, headers: { "x-csrf-token": "token-1" }, body: "<discovery/>" };

describe("session headers", () => {
  it("sends client, language, stateful marker and a stable connection id", async () => {
    const { adt, calls } = session([{ status: 200, body: "ok" }, { status: 200, body: "ok" }]);

    await adt.request({ path: "/first" });
    await adt.request({ path: "/second" });

    expect(calls[0]?.headers["sap-client"]).toBe("400");
    expect(calls[0]?.headers["sap-language"]).toBe("ZH");
    expect(calls[0]?.headers["x-sap-adt-sessiontype"]).toBe("stateful");
    expect(calls[0]?.headers["sap-adt-connection-id"]).toBeTruthy();
    expect(calls[1]?.headers["sap-adt-connection-id"]).toBe(calls[0]?.headers["sap-adt-connection-id"]);
  });

  it("adopts the connection id the server hands back", async () => {
    const { adt, calls } = session([
      { status: 200, headers: { "sap-adt-connection-id": "server-side" }, body: "ok" },
      { status: 200, body: "ok" },
    ]);

    await adt.request({ path: "/first" });
    await adt.request({ path: "/second" });

    expect(calls[1]?.headers["sap-adt-connection-id"]).toBe("server-side");
  });

  it("fetches the CSRF token once and reuses it", async () => {
    const { adt, calls } = session([CSRF, { status: 200, body: "ok" }, { status: 200, body: "ok" }]);

    await adt.request({ method: "POST", path: "/a", body: "" });
    await adt.request({ method: "POST", path: "/b", body: "" });

    expect(calls[0]?.headers["x-csrf-token"]).toBe("fetch");
    expect(calls[1]?.headers["x-csrf-token"]).toBe("token-1");
    expect(calls[2]?.headers["x-csrf-token"]).toBe("token-1");
    // one discovery call only
    expect(calls.filter((call) => call.url.includes("/discovery"))).toHaveLength(1);
  });

  it("keeps cookies from one call to the next", async () => {
    const { adt, calls } = session([
      { status: 200, headers: { "set-cookie": ["SAP_SESSIONID=abc; Path=/"] }, body: "ok" },
      { status: 200, body: "ok" },
    ]);

    await adt.request({ path: "/first" });
    await adt.request({ path: "/second" });

    expect(calls[1]?.headers["cookie"]).toContain("SAP_SESSIONID=abc");
  });

  it("replays once after the session dies, then gives up", async () => {
    const expired = { status: 400, body: "<message>Session timed out</message>" };
    // discovery, POST (expired), discovery for the new session, POST (expired again)
    const { adt, calls } = session([CSRF, expired, CSRF, expired]);

    await expect(adt.request({ method: "POST", path: "/x", body: "" })).rejects.toMatchObject({
      code: "session-expired",
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(calls.filter((call) => call.url.includes("/discovery"))).toHaveLength(2);
  });
});

describe("error classification", () => {
  it("treats 'currently editing' as a lock problem, not a permission problem", async () => {
    const { adt } = session([
      {
        status: 403,
        body: '<exc:exception><type id="ExceptionResourceNoAccess"/><message lang="ZH">使用者 U 当前编辑 ZFOO</message></exc:exception>',
      },
    ]);
    await expect(adt.request({ path: "/programs/programs/zfoo" })).rejects.toBeInstanceOf(AdtError);
    await expect(adt.request({ path: "/programs/programs/zfoo" })).rejects.toMatchObject({ code: "locked" });
  });

  it("reports a media-type rejection so it can be retried with */*", async () => {
    const { adt } = session([{ status: 406, body: "not acceptable" }]);
    await expect(adt.request({ path: "/x" })).rejects.toMatchObject({ code: "content-negotiation" });
  });
});

describe("lifecycle", () => {
  it("reads the lock handle and the transport out of the lock response", async () => {
    const { adt } = session([
      CSRF,
      {
        status: 200,
        body: '<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>S4HK900001</CORRNR><IS_LOCAL> </IS_LOCAL></DATA></asx:values></asx:abap>',
      },
    ]);
    const lock = await lockObject(adt, "/programs/programs/zfoo");
    expect(lock).toEqual({ lockHandle: "H1", corrNr: "S4HK900001", isLocal: false });
  });

  it("throws when the lock answered without a handle", async () => {
    const { adt } = session([CSRF, { status: 200, body: "<DATA/>" }]);
    await expect(lockObject(adt, "/programs/programs/zfoo")).rejects.toMatchObject({ code: "locked" });
  });

  it("sends the lock handle and transport with the source", async () => {
    const { adt, calls } = session([CSRF, { status: 200, body: "" }]);
    await writeSource(adt, "/programs/programs/zfoo/source/main", "REPORT zfoo.", {
      lockHandle: "H1",
      corrNr: "S4HK900001",
    });
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.url).toContain("lockHandle=H1");
    expect(calls[1]?.url).toContain("corrNr=S4HK900001");
    expect(calls[1]?.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("treats an empty 200 activation as success", async () => {
    const { adt, calls } = session([CSRF, { status: 200, body: "" }]);
    const report = await activate(adt, [
      { uri: "/sap/bc/adt/programs/programs/zfoo", name: "ZFOO", adtType: "PROG/P" },
    ]);

    expect(report.ok).toBe(true);
    expect(report.status).toContain("activated");
    expect(calls[1]?.headers["content-type"]).toBe("application/vnd.sap.adt.activation+xml");
    expect(calls[1]?.url).toContain("preauditRequested=false");
    expect(calls[1]?.body).toContain('adtcore:name="ZFOO"');
  });

  it("surfaces an activation on a locked object as a lock error", async () => {
    const { adt } = session([
      CSRF,
      { status: 403, body: "<message>使用者 U 当前编辑 ZFOO</message>" },
      { status: 403, body: "<message>使用者 U 当前编辑 ZFOO</message>" },
    ]);
    await expect(
      activate(adt, [{ uri: "/sap/bc/adt/programs/programs/zfoo", name: "ZFOO" }]),
    ).rejects.toMatchObject({ code: "locked" });
  });

  it("turns 'No URI-Mapping' into 'nothing to check'", async () => {
    const { adt } = session([CSRF, { status: 500, body: "<message>No URI-Mapping defined for URI /x</message>" }]);
    const result = await runCheck(adt, "/sap/bc/adt/programs/programs/zfoo", "inactive");
    expect(result.unavailable).toBeDefined();
    expect(result.errors).toBe(0);
  });

  it("deletes with a lock handle instead of trusting a bare DELETE", async () => {
    const { adt, calls } = session([
      CSRF,
      { status: 200, body: "<DATA><LOCK_HANDLE>H9</LOCK_HANDLE></DATA>" },
      { status: 200, body: "" },
    ]);
    const result = await deleteObject(adt, "/programs/programs/zfoo");
    expect(result.deleted).toBe(true);
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.url).toContain("lockHandle=H9");
  });
});

describe("source comparison", () => {
  it("ignores line endings and trailing whitespace", () => {
    const written = "REPORT zfoo.\nWRITE 'x'.\n";
    const active = "REPORT zfoo.\r\nWRITE 'x'.   \r\n\r\n";
    expect(compareSource(written, active).equal).toBe(true);
  });

  it("reports the first differing line", () => {
    const result = compareSource("line1\nline2\n", "line1\nother\n");
    expect(result.equal).toBe(false);
    expect(result.detail).toContain("line 2");
  });
});
