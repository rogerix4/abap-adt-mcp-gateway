/**
 * `ReloadProfile` is a local action: re-read the configuration, restart the sessions.
 *
 * Two things must hold, and both cost a round of debugging when they do not:
 *   - a configuration that no longer parses must leave the working sessions alone, or a
 *     typo takes a running gateway offline until someone restarts it;
 *   - a successful reload must end the old sessions (a lock belongs to the session that
 *     took it, so keeping them would keep stale enqueues alive) and pick up new systems.
 */

import { describe, expect, it } from "vitest";

import { GatewayRuntime } from "../src/runtime.js";
import type { ConnectedSystem } from "../src/config/secrets.js";

const system = (id: string, tier: "dev" | "qas" = "dev"): ConnectedSystem =>
  ({
    id,
    tier,
    endpoint: { url: "https://sap.example.com:44300", client: "100", systemType: "onprem", language: "EN" },
    auth: { type: "basic", username: "U", password: "P" },
    rfcBackend: "soap",
    env: {},
  }) as ConnectedSystem;

/** A session factory that only records what happened to it. */
function fakeSessions(): { closed: string[]; factory: (s: ConnectedSystem) => never } {
  const closed: string[] = [];
  return {
    closed,
    factory: (s: ConnectedSystem) =>
      ({
        close: async () => {
          closed.push(s.id);
          return true;
        },
        reset: () => undefined,
      }) as never,
  };
}

describe("reloadSystems", () => {
  it("refuses when no reloader is installed", async () => {
    const runtime = new GatewayRuntime([system("a")], fakeSessions().factory);
    await expect(runtime.reloadSystems()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("swaps the systems and ends the old sessions", async () => {
    const sessions = fakeSessions();
    const runtime = new GatewayRuntime([system("a")], sessions.factory);
    runtime.setReloader(async () => [system("b"), system("c", "qas")]);

    const result = await runtime.reloadSystems();

    expect(result.before).toEqual(["a"]);
    expect(result.after).toEqual(["b", "c"]);
    expect(result.closed).toBe(1);
    expect(sessions.closed).toEqual(["a"]);
    expect(runtime.systemIds).toEqual(["b", "c"]);
  });

  it("keeps the working sessions when the new configuration does not load", async () => {
    const sessions = fakeSessions();
    const runtime = new GatewayRuntime([system("a")], sessions.factory);
    runtime.setReloader(async () => {
      throw new Error("configuration error: unknown tier");
    });

    await expect(runtime.reloadSystems()).rejects.toThrow(/configuration error/);

    expect(sessions.closed).toEqual([]);
    expect(runtime.systemIds).toEqual(["a"]);
    // The old system is still usable — that is the point of loading first.
    expect(runtime.resolve("a", undefined, true).sessionId).toBe("sys:a");
  });
});
