/**
 * The lock journal, and the reason it exists.
 *
 * Measured on a live system: after a LOCK whose answer was lost, SAP answers a
 * fresh LOCK with `403 User X is currently editing Y`, and an UNLOCK with a
 * handle it does not know still answers `200`. So the handle has to be written
 * down while it is in hand, and it has to be given back before locking again.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { lockObject, deleteObject, unlockObject } from "../src/adt/lifecycle.js";
import { LockJournal } from "../src/adt/lock-journal.js";
import { AdtSession } from "../src/adt/session.js";

const LOCK_BODY = (handle: string): string =>
  '<asx:abap><asx:values><DATA><LOCK_HANDLE>' +
  handle +
  "</LOCK_HANDLE><CORRNR>DS4K900001</CORRNR><IS_LOCAL>X</IS_LOCAL></DATA></asx:values></asx:abap>";

interface Recorded {
  readonly method: string;
  readonly url: string;
}

/** A session whose LOCK always succeeds and which records every request. */
function scriptedSession(
  journalFile: string,
  options: { readonly lockFails?: () => boolean } = {},
): { session: AdtSession; requests: Recorded[] } {
  process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = journalFile;
  const requests: Recorded[] = [];
  let issued = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (url.includes("_action=LOCK")) {
      if (options.lockFails?.() === true) {
        return new Response("User U is currently editing ZCL_X", { status: 403 });
      }
      issued += 1;
      return new Response(LOCK_BODY(`HANDLE${issued}0000`), { status: 200, headers: { "x-csrf-token": "t" } });
    }
    return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "t" } });
  }) as typeof fetch;
  const session = new AdtSession({
    url: "https://sap.example.com:44300",
    client: "100",
    language: "EN",
    username: "U",
    password: "P",
    fetchImpl,
  });
  return { session, requests };
}

let journalFile: string;

beforeEach(() => {
  journalFile = join(mkdtempSync(join(tmpdir(), "lock-journal-")), "locks.json");
  process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = journalFile;
});

describe("lock journal", () => {
  it("keeps one handle per object and survives being re-opened", () => {
    const journal = new LockJournal(journalFile);
    journal.remember("/sap/bc/adt/oo/classes/zcl_x", "AAA");
    journal.remember("/sap/bc/adt/oo/classes/zcl_y", "BBB");

    const reopened = new LockJournal(journalFile);
    expect(reopened.handleFor("/sap/bc/adt/oo/classes/zcl_x")).toBe("AAA");
    expect(reopened.handleFor("/sap/bc/adt/oo/classes/zcl_y")).toBe("BBB");

    reopened.forget("AAA");
    expect(new LockJournal(journalFile).handleFor("/sap/bc/adt/oo/classes/zcl_x")).toBeUndefined();
    expect(new LockJournal(journalFile).handleFor("/sap/bc/adt/oo/classes/zcl_y")).toBe("BBB");
  });

  it("treats a corrupt file as empty instead of failing the call", () => {
    writeFileSync(journalFile, "{not json", "utf8");
    const journal = new LockJournal(journalFile);
    expect(journal.handleFor("/x")).toBeUndefined();
    journal.remember("/x", "H");
    expect(JSON.parse(readFileSync(journalFile, "utf8"))).toEqual({ "/x": "H" });
  });
});

describe("locking", () => {
  it("records the handle it was given", async () => {
    const { session } = scriptedSession(journalFile);
    const lock = await lockObject(session, "/oo/classes/zcl_x");
    expect(lock.lockHandle).toBe("HANDLE10000");
    expect(new LockJournal(journalFile).handleFor("https://sap.example.com:44300/sap/bc/adt/oo/classes/zcl_x")).toBe(
      "HANDLE10000",
    );
  });

  it("gives a stale lock back before asking for a new one", async () => {
    new LockJournal(journalFile).remember("https://sap.example.com:44300/sap/bc/adt/oo/classes/zcl_x", "STALE");
    const { session, requests } = scriptedSession(journalFile);

    await lockObject(session, "/oo/classes/zcl_x");

    const paths = requests.map((entry) => entry.url);
    const unlockAt = paths.findIndex((url) => url.includes("_action=UNLOCK&lockHandle=STALE"));
    const lockAt = paths.findIndex((url) => url.includes("_action=LOCK"));
    expect(unlockAt).toBeGreaterThanOrEqual(0);
    expect(unlockAt).toBeLessThan(lockAt);
    expect(new LockJournal(journalFile).handleFor("https://sap.example.com:44300/sap/bc/adt/oo/classes/zcl_x")).toBe(
      "HANDLE10000",
    );
  });

  it("drops the entry once SAP accepted the unlock", async () => {
    const { session } = scriptedSession(journalFile);
    const lock = await lockObject(session, "/oo/classes/zcl_x");
    await unlockObject(session, "/oo/classes/zcl_x", lock.lockHandle);
    expect(new LockJournal(journalFile).read()).toEqual({});
  });

  it("says what to do when the object is held by someone else", async () => {
    const { session } = scriptedSession(journalFile, { lockFails: () => true });
    await expect(lockObject(session, "/oo/classes/zcl_x")).rejects.toMatchObject({ code: "locked" });
    expect(new LockJournal(journalFile).read()).toEqual({});
  });
});

/**
 * Journalling has to cover every request that takes a lock, not only the high-level
 * lock helper: the plain `Lock*` tools send the same LOCK as a route, and a journal
 * that misses them leaves locks nobody can give back.
 */
describe("locks taken outside the lock helper", () => {
  const objectUrl = "https://sap.example.com:44300/sap/bc/adt/programs/programs/zz_probe";

  it("journals a LOCK sent as a plain request", async () => {
    const { session } = scriptedSession(journalFile);
    await session.request({
      method: "POST",
      path: "/programs/programs/zz_probe?_action=LOCK&accessMode=MODIFY",
      accept: "*/*",
    });

    expect(new LockJournal(journalFile).handleFor(objectUrl)).toBe("HANDLE10000");
  });

  it("gives that lock back before the next one, whoever asked for it", async () => {
    const { session, requests } = scriptedSession(journalFile);
    await session.request({
      method: "POST",
      path: "/programs/programs/zz_probe?_action=LOCK&accessMode=MODIFY",
      accept: "*/*",
    });
    const before = requests.length;
    await session.request({
      method: "POST",
      path: "/programs/programs/zz_probe?_action=LOCK&accessMode=MODIFY",
      accept: "*/*",
    });

    const second = requests.slice(before).map((entry) => entry.url);
    const unlockAt = second.findIndex((url) => url.includes("_action=UNLOCK&lockHandle=HANDLE10000"));
    const lockAt = second.findIndex((url) => url.includes("_action=LOCK"));
    expect(unlockAt).toBeGreaterThanOrEqual(0);
    expect(unlockAt).toBeLessThan(lockAt);
  });

  it("forgets the handle only when an UNLOCK carries it, never on a DELETE", async () => {
    const { session } = scriptedSession(journalFile);
    await session.request({
      method: "POST",
      path: "/programs/programs/zz_probe?_action=LOCK&accessMode=MODIFY",
      accept: "*/*",
    });
    await session.request({
      method: "POST",
      path: "/programs/programs/zz_probe?_action=UNLOCK&lockHandle=HANDLE10000",
      accept: "*/*",
    });
    expect(new LockJournal(journalFile).read()).toEqual({});

    await session.request({
      method: "POST",
      path: "/programs/programs/zz_probe?_action=LOCK&accessMode=MODIFY",
      accept: "*/*",
    });
    const second = new LockJournal(journalFile).handleFor(objectUrl);
    expect(second).toBeDefined();
    await session.request({
      method: "DELETE",
      path: `/programs/programs/zz_probe?lockHandle=${second as string}`,
      accept: "*/*",
    });
    // Measured on the reference system: the DELETE removes the object but leaves the name-level
    // enqueue, so the handle must survive — it is the only way to release it. Dropping
    // it here is what made a deleted program impossible to create again.
    expect(new LockJournal(journalFile).handleFor(objectUrl)).toBe(second as string);

    // The explicit UNLOCK after the delete is what clears it.
    await session.request({
      method: "POST",
      path: `/programs/programs/zz_probe?_action=UNLOCK&lockHandle=${second as string}`,
      accept: "*/*",
    });
    expect(new LockJournal(journalFile).read()).toEqual({});
  });

  it("keeps nothing when the LOCK itself failed", async () => {
    const { session } = scriptedSession(journalFile, { lockFails: () => true });
    await expect(
      session.request({
        method: "POST",
        path: "/programs/programs/zz_probe?_action=LOCK&accessMode=MODIFY",
        accept: "*/*",
      }),
    ).rejects.toMatchObject({ code: "locked" });
    expect(new LockJournal(journalFile).read()).toEqual({});
  });

  it("releases the lock when the delete itself fails", async () => {
    const lockFile = join(mkdtempSync(join(tmpdir(), "delete-lock-")), "locks.json");
    process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = lockFile;
    const urls: { method: string; url: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      urls.push({ method, url });
      if (url.includes("_action=LOCK")) {
        return new Response(LOCK_BODY("HANDLE9"), { status: 200, headers: { "x-csrf-token": "t" } });
      }
      if (method === "DELETE") {
        // A delete that SAP refuses leaves the lock behind unless we give it back.
        return new Response("<exc:exception><message>Object is used elsewhere</message></exc:exception>", {
          status: 403,
          headers: { "x-csrf-token": "t" },
        });
      }
      return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "t" } });
    }) as typeof fetch;
    const session = new AdtSession({
      url: "https://sap.example.com:44300",
      client: "100",
      language: "EN",
      username: "U",
      password: "P",
      fetchImpl,
    });

    const result = await deleteObject(session, "/programs/programs/zz_probe");

    expect(result.deleted).toBe(false);
    expect(urls.some((entry) => entry.url.includes("_action=UNLOCK&lockHandle=HANDLE9"))).toBe(true);
    expect(new LockJournal(lockFile).read()).toEqual({});
  });
});
