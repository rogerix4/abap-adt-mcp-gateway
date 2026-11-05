/**
 * The read-only boundary.
 *
 * Writes are decided per call at `runtime.resolve(..., needsWrite)`, so the flag has to
 * be derived from what the request *does* — a route table entry that sends `PUT`, or a
 * bridge that writes a CUA document, is a write even if the tool name does not start
 * with "Update". A single `false` there lets a read-only system take writes, which is
 * the one thing the tier is for.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { registerFamilies } from "../src/families/index.js";
import { GatewayRuntime } from "../src/runtime.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(mkdtempSync(join(tmpdir(), "tier-locks-")), "locks.json");

const systemAs = (tier: string) =>
  ({
    id: "probe",
    tier,
    endpoint: { url: "https://sap.example.com:44300", client: "200", language: "EN", systemType: "onprem" },
    auth: { type: "basic", username: "u", password: "p" },
    rfcBackend: "soap",
    env: {},
  }) as never;

/** Counts what would have been sent, so "blocked" is distinguishable from "sent". */
function booted(tier: string): {
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  state: { sent: number };
} {
  const state = { sent: 0 };
  const fetchImpl = (async () => {
    state.sent += 1;
    return new Response("<ok/>", { status: 200, headers: { "x-csrf-token": "token" } });
  }) as typeof fetch;
  const runtime = new GatewayRuntime([systemAs(tier)], (target) =>
    new AdtSession({
      url: target.endpoint.url,
      client: target.endpoint.client,
      language: target.endpoint.language,
      username: "u",
      password: "p",
      fetchImpl,
    }),
  );
  const registry = createRegistry();
  registerFamilies(registry, runtime);
  return { state, call: (tool, args) => registry.call(tool, args, { system: "probe" }) };
}

describe("a read-only tier", () => {
  it("refuses a write that goes through the route table", async () => {
    const { call } = booted("qa");
    await expect(
      call("LockObjectLow", { object_type: "program", object_name: "zz_probe" }),
    ).rejects.toMatchObject({ code: "SYSTEM_READ_ONLY" });
  });

  it("refuses a write that goes through the RFC bridge", async () => {
    const { call } = booted("qa");
    await expect(
      call("PatchGuiStatus", { program_name: "zz_probe", changes: { ADM: {}, STA: [] } }),
    ).rejects.toMatchObject({ code: "SYSTEM_READ_ONLY" });
  });

  it("still serves the reads, including the bridged ones", async () => {
    const { call } = booted("qa");
    // GetTextElement reads the pool through the same function module the writes use.
    const result = (await call("GetTextElement", { program_name: "zz_probe" })) as { success?: boolean };
    expect(result.success).toBe(true);
  });

  it("lets the same write through on a dev tier", async () => {
    const { call, state } = booted("dev");
    await call("LockObjectLow", { object_type: "program", object_name: "zz_probe" });
    expect(state.sent).toBeGreaterThan(0);
  });
});
