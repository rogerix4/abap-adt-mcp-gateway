/**
 * Ending a session is what releases its locks.
 *
 * Measured 2026-11-04: killing the client leaves the ABAP session alive server-side,
 * and with it every session-scoped enqueue it holds (`DDACT_LOCK` for DDIC activation
 * was the one that piled up in SM12). So a one-shot caller must log off explicitly.
 */

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.ts";

function scripted(script: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ method: init?.method ?? "GET", url: String(url), headers });
    const step = script[index] ?? script.at(-1) ?? { status: 200 };
    index += 1;
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(step.headers ?? {})) responseHeaders.append(key, value);
    return { status: step.status, headers: responseHeaders, text: async () => step.body ?? "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CSRF = { status: 200, headers: { "x-csrf-token": "t" }, body: "<d/>" };

describe("session close", () => {
  it("logs off on the absolute path, outside the ADT base", async () => {
    const { impl, calls } = scripted([CSRF, { status: 200, body: "logged off" }]);
    const session = new AdtSession({
      url: "https://sap.example.com:44300",
      client: "400",
      language: "EN",
      username: "u",
      password: "p",
      fetchImpl: impl,
    });

    await expect(session.close()).resolves.toBe(true);
    expect(calls.map((call) => call.url)).toContain("https://sap.example.com:44300/sap/public/bc/icf/logoff");
    // No ADT prefix: the logoff resource lives under /sap/public, not /sap/bc/adt.
    expect(calls.every((call) => !call.url.includes("/sap/bc/adt/sap/public"))).toBe(true);
  });

  it("reports a failed logoff instead of throwing", async () => {
    // A GET needs no CSRF round-trip, so the logoff is the very first request.
    const { impl } = scripted([{ status: 500, body: "boom" }]);
    const session = new AdtSession({
      url: "https://sap.example.com:44300",
      client: "400",
      language: "EN",
      username: "u",
      password: "p",
      fetchImpl: impl,
    });
    await expect(session.close()).resolves.toBe(false);
  });
});
