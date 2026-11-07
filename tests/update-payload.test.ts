/**
 * Update payloads: `source_file`, `patch` hunks and the payload fingerprints.
 *
 * Measured: a 1,832-line report was re-sent as inline source four times —
 * one write silently dropped 389 lines, another lost a period, and both read like a
 * success. The arguments below exist to make that impossible, so every branch needs an
 * assertion of its own:
 *
 *   - the file route must hash exactly what the inline route hashes, or a fingerprint
 *     becomes route-dependent and worthless;
 *   - a fingerprint mismatch must cost no lock and no write (that is the whole point of
 *     checking before the lock);
 *   - a patch is applied to the ACTIVE source, and a drifted baseline must abort;
 *   - `check_no_change` must answer without locking anything.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.ts";
import { registerFamilies } from "../src/families/index.ts";
import { GatewayRuntime } from "../src/runtime.ts";

const CSRF = { status: 200, headers: { "x-csrf-token": "t" }, body: "<d/>" };
const LOCK = { status: 200, body: "<DATA><LOCK_HANDLE>H1</LOCK_HANDLE></DATA>" };

// A journal shared with another test file makes LOCK release a stale lock first, which
// shifts every scripted response by one. Each file owns its own file.
process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-payload-${process.pid}.json`);

function system() {
  return {
    id: "probe",
    tier: "dev",
    endpoint: { url: "https://sap.example.com:44300", client: "400", language: "EN", systemType: "onprem" },
    auth: { type: "basic", username: "env:U", password: "env:P" },
    rfcBackend: "soap",
    env: {},
  } as never;
}

function scriptedFetch(script: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  let index = 0;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const step = script[index] ?? script.at(-1) ?? { status: 500 };
    index += 1;
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(step.headers ?? {})) responseHeaders.append(key, value);
    return { status: step.status, headers: responseHeaders, text: async () => step.body ?? "" } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function build(fetchImpl: typeof fetch) {
  const runtime = new GatewayRuntime([system()], (s) =>
    new AdtSession({
      url: s.endpoint.url,
      client: s.endpoint.client,
      language: s.endpoint.language,
      username: "u",
      password: "p",
      fetchImpl,
    }),
  );
  const registry = createRegistry();
  registerFamilies(registry, runtime);
  return { registry, runtime };
}

const callsWith = <T extends { method: string; url: string }>(calls: T[], method: string): T[] =>
  calls.filter((call) => call.method === method && !call.url.includes("/discovery"));

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const PROGRAM = "REPORT zfoo.\n\nWRITE 'x'.\n";

describe("source_file", () => {
  it("sends the file content and fingerprints it exactly like the inline route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-payload-"));
    const file = join(dir, "zfoo.abap");
    // Trailing blank lines and padding are what an editor leaves behind; both routes
    // trim, so both must hash the same payload.
    writeFileSync(file, `${PROGRAM}\n\n  `, "utf8");

    const { impl, calls } = scriptedFetch([
      CSRF, // discovery for CSRF
      LOCK, // lock
      { status: 200, body: "" }, // PUT
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
      { status: 200, body: PROGRAM }, // read active
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateProgram",
      { program_name: "ZFOO", source_file: file, activate: true },
      { system: "probe" },
    )) as { activated: boolean; line_count: number; sha256: string };

    expect(result.activated).toBe(true);
    expect(result.sha256).toBe(sha256(PROGRAM.trim()));
    expect(result.line_count).toBe(PROGRAM.trim().split("\n").length);

    const put = calls.find((call) => call.method === "PUT");
    expect((put?.body ?? "").trim()).toBe(PROGRAM.trim());
  });

  it("refuses source_code together with source_file, before any request goes out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-payload-"));
    const file = join(dir, "zfoo.abap");
    writeFileSync(file, PROGRAM, "utf8");

    const { impl, calls } = scriptedFetch([]);
    const { registry } = build(impl);

    await expect(
      registry.call("UpdateProgram", { program_name: "ZFOO", source_code: PROGRAM, source_file: file }, { system: "probe" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ accepted: expect.arrayContaining(["source_code", "source_file"]) }),
    });
    expect(calls).toHaveLength(0);
  });

  it("reports an unreadable path instead of writing an empty source", async () => {
    const { impl, calls } = scriptedFetch([]);
    const { registry } = build(impl);

    await expect(
      registry.call(
        "UpdateProgram",
        { program_name: "ZFOO", source_file: join(tmpdir(), "gw-payload-does-not-exist.abap") },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });
});

describe("payload fingerprints", () => {
  it("aborts on a line-count mismatch before taking the lock", async () => {
    const { impl, calls } = scriptedFetch([]);
    const { registry } = build(impl);

    await expect(
      registry.call(
        "UpdateProgram",
        { program_name: "ZFOO", source_code: PROGRAM, expected_line_count: 99 },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_MISMATCH" });
    // Nothing was locked and nothing was written: a wrong payload must cost nothing.
    expect(calls).toHaveLength(0);
  });

  it("aborts on a sha256 mismatch before taking the lock", async () => {
    const { impl, calls } = scriptedFetch([]);
    const { registry } = build(impl);

    await expect(
      registry.call(
        "UpdateProgram",
        { program_name: "ZFOO", source_code: PROGRAM, expected_sha256: "deadbeef" },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_MISMATCH" });
    expect(calls).toHaveLength(0);
  });

  it("accepts a matching fingerprint and reports what it hashed", async () => {
    const { impl } = scriptedFetch([
      CSRF,
      LOCK,
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: PROGRAM },
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateProgram",
      { program_name: "ZFOO", source_code: PROGRAM, expected_sha256: sha256(PROGRAM.trim()), expected_line_count: 3 },
      { system: "probe" },
    )) as { activated: boolean; sha256: string };

    expect(result.activated).toBe(true);
    expect(result.sha256).toBe(sha256(PROGRAM.trim()));
  });
});

describe("patch", () => {
  it("applies the hunk to the active source and sends only the patched result", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 200, body: PROGRAM }, // read active (baseline); a GET needs no CSRF yet
      CSRF, // discovery, fetched lazily by the first non-GET request
      LOCK,
      { status: 200, body: "" }, // PUT
      { status: 200, body: "" }, // unlock
      { status: 200, body: "" }, // activation
      { status: 200, body: PROGRAM.replace("'x'", "'y'") }, // read active
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateProgram",
      { program_name: "ZFOO", patch: [{ old: "WRITE 'x'.", new: "WRITE 'y'." }] },
      { system: "probe" },
    )) as { activated: boolean; patch: { applied: { count: number }[] } };

    expect(result.activated).toBe(true);
    expect(result.patch.applied[0]?.count).toBe(1);
    const put = callsWith(calls, "PUT")[0];
    expect(put?.body).toContain("WRITE 'y'.");
    expect(put?.body).toContain("REPORT zfoo.");
  });

  it("aborts with CONTENT_MISMATCH when the baseline drifted, and writes nothing", async () => {
    const { impl, calls } = scriptedFetch([
      CSRF,
      { status: 200, body: PROGRAM }, // baseline holds the hunk exactly once
    ]);
    const { registry } = build(impl);

    await expect(
      registry.call(
        "UpdateProgram",
        { program_name: "ZFOO", patch: [{ old: "WRITE 'x'.", new: "WRITE 'y'.", expected_count: 2 }] },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_MISMATCH" });

    expect(calls.filter((call) => call.url.includes("_action=LOCK"))).toHaveLength(0);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("refuses patch together with a full source", async () => {
    const { impl, calls } = scriptedFetch([]);
    const { registry } = build(impl);

    await expect(
      registry.call(
        "UpdateProgram",
        { program_name: "ZFOO", source_code: PROGRAM, patch: [{ old: "a", new: "b" }] },
        { system: "probe" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });
});

describe("check_no_change", () => {
  it("answers no_change without locking or writing when the active version already matches", async () => {
    const { impl, calls } = scriptedFetch([
      // The platform rewrites line endings and trailing blanks; the comparison must not.
      { status: 200, body: PROGRAM.replace(/\n/g, "\r\n") },
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateProgram",
      { program_name: "ZFOO", source_code: PROGRAM, check_no_change: true },
      { system: "probe" },
    )) as { no_change: boolean; written: boolean };

    expect(result.no_change).toBe(true);
    expect(result.written).toBe(false);
    expect(calls.filter((call) => call.url.includes("_action=LOCK"))).toHaveLength(0);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("still writes when the active version differs", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 200, body: "REPORT zbar.\n" }, // active differs
      CSRF,
      LOCK,
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 200, body: PROGRAM },
    ]);
    const { registry } = build(impl);

    const result = (await registry.call(
      "UpdateProgram",
      { program_name: "ZFOO", source_code: PROGRAM, check_no_change: true },
      { system: "probe" },
    )) as { no_change?: boolean; activated: boolean };

    expect(result.no_change).toBeUndefined();
    expect(result.activated).toBe(true);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
});
