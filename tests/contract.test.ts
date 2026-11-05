/**
 * Contract tests.
 *
 * These are the gate for P0: the tool surface must be exactly the frozen 335
 * tools, every schema must be a valid MCP object schema, and the server must
 * hand all of them to a client. They run offline — no SAP system involved.
 */

import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { AdtError } from "../src/adt/errors.ts";
import { createRegistry } from "../src/engine/create-registry.ts";
import { GatewayError } from "../src/engine/errors.ts";
import { createGatewayServer } from "../src/mcp/server.ts";
import { VERSION } from "../src/version.ts";

const EXPECTED_TOOL_COUNT = 335;

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string; name: string };

describe("frozen tool contract", () => {
  const registry = createRegistry();

  it(`registers exactly ${EXPECTED_TOOL_COUNT} tools`, () => {
    expect(registry.list()).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("never registers the same name twice", () => {
    const names = registry.list().map((entry) => entry.definition.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every tool an object input schema", () => {
    const offenders = registry
      .list()
      .filter((entry) => entry.definition.inputSchema.type !== "object")
      .map((entry) => entry.definition.name);
    expect(offenders).toEqual([]);
  });

  it("gives every tool a description", () => {
    const offenders = registry
      .list()
      .filter((entry) => entry.definition.description.trim().length === 0)
      .map((entry) => entry.definition.name);
    expect(offenders).toEqual([]);
  });

  it("classifies every tool's effect", () => {
    const seen = new Set<string>();
    for (const entry of registry.list()) {
      expect(["read", "write", "execute"]).toContain(entry.meta.effect);
      seen.add(entry.meta.effect);
    }
    // A contract where nothing writes would mean the classifier broke silently.
    expect(seen.has("write")).toBe(true);
    expect(seen.has("read")).toBe(true);
  });

  it("separates low-level tools by what they require, not by their name", () => {
    const low = registry.list().filter((entry) => entry.meta.layer === "low");
    expect(low.length).toBeGreaterThan(0);

    // 89 of the 134 low-level tools have no high-level sibling, so the suffix
    // alone says nothing about what the caller must supply.
    const withoutSibling = low.filter((entry) => !entry.meta.hasHighSibling);
    expect(withoutSibling.length).toBeGreaterThan(0);

    const needingLock = low.filter((entry) => entry.meta.requires.lockHandle);
    expect(needingLock.length).toBeGreaterThan(0);
    expect(needingLock.length).toBeLessThan(low.length);
  });
});

describe("registry behaviour before any tool is implemented", () => {
  const registry = createRegistry();

  it("reports full coverage gaps rather than pretending", () => {
    const report = registry.coverage();
    expect(report.total).toBe(EXPECTED_TOOL_COUNT);
    expect(report.implemented + report.missing.length).toBe(report.total);
  });

  it("rejects unknown tool names with a stable code", async () => {
    await expect(registry.call("NoSuchTool", {}, {})).rejects.toMatchObject({
      code: "UNKNOWN_TOOL",
    });
  });

  it("answers known-but-unimplemented tools with NOT_IMPLEMENTED", async () => {
    const [first] = registry.list();
    expect(first).toBeDefined();
    const error = await registry.call(first!.definition.name, {}, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("NOT_IMPLEMENTED");
  });

  it("refuses to register a handler for a tool outside the contract", () => {
    expect(() => registry.register("NoSuchTool", async () => null)).toThrow(/unknown tool/i);
  });

  it("refuses double registration", () => {
    const [first] = registry.list();
    registry.register(first!.definition.name, async () => "ok");
    expect(() => registry.register(first!.definition.name, async () => "ok")).toThrow(
      /duplicate/i,
    );
  });
});

describe("MCP surface", () => {
  const transports: InMemoryTransport[] = [];

  afterEach(async () => {
    for (const transport of transports.splice(0)) {
      await transport.close();
    }
  });

  it("lists all 335 tools over the wire, with annotations", async () => {
    const registry = createRegistry();
    const server = createGatewayServer({
      registry,
      // The default level is `gateway`; this test is about the contract itself.
      info: { name: packageJson.name, version: VERSION, expose: { level: "full" } },
      log: () => {},
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    transports.push(clientTransport, serverTransport);

    const client = new Client({ name: "contract-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);

    const registryNames = registry.list().map((entry) => entry.definition.name);
    expect(tools.map((tool) => tool.name)).toEqual(registryNames);

    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.annotations).toBeDefined();
    }
  });

  it("advertises only the tools capability, with no list changes", async () => {
    const registry = createRegistry();
    const server = createGatewayServer({
      registry,
      info: { name: packageJson.name, version: VERSION },
      log: () => {},
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    transports.push(clientTransport, serverTransport);

    const client = new Client({ name: "contract-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toEqual({ listChanged: false });
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
    expect(capabilities?.logging).toBeUndefined();
  });

  it("returns a readable error payload for unimplemented tools", async () => {
    const registry = createRegistry();
    const server = createGatewayServer({
      registry,
      info: { name: packageJson.name, version: VERSION },
      log: () => {},
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    transports.push(clientTransport, serverTransport);

    const client = new Client({ name: "contract-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const first = registry.list()[0]!;
    const result = await client.callTool({ name: first.definition.name, arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    const payload = JSON.parse(text) as { code: string; message: string };
    expect(payload.code).toBe("NOT_IMPLEMENTED");
    expect(payload.message).toContain(first.definition.name);
  });
});

describe("write serialization", () => {
  const transports: InMemoryTransport[] = [];

  afterEach(async () => {
    for (const transport of transports.splice(0)) {
      await transport.close();
    }
  });

  /**
   * One ADT session per system is stateful. Two writes in flight against the same
   * system interleave LOCK and UNLOCK, and the loser is left holding a lock it never
   * released — the failure this gateway was rebuilt to remove. Reads are free to overlap,
   * and so are writes to *different* systems: each one has its own queue.
   */
  const harness = async (systems: readonly string[] = ["a"]) => {
    const registry = createRegistry();
    const writeTool = registry.list().find((entry) => entry.meta.effect === "write")!;
    const readTool = registry.list().find((entry) => entry.meta.effect === "read")!;
    const order: string[] = [];

    /**
     * Records `label:system:start` / `label:system:end`, so a test can tell a queue that
     * is per system from one that is global.
     */
    const slow = (label: string) => async (args: Record<string, unknown>) => {
      const tag = `${label}:${String(args["system"] ?? "-")}`;
      order.push(`${tag}:start`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`${tag}:end`);
      return { ok: true };
    };

    registry.register(writeTool.definition.name, slow("write"));
    registry.register(readTool.definition.name, slow("read"));

    const server = createGatewayServer({
      registry,
      info: { name: packageJson.name, version: VERSION, systems },
      log: () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    transports.push(clientTransport, serverTransport);
    const client = new Client({ name: "contract-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, order, writeTool, readTool };
  };

  it("never lets two writes to one system overlap", async () => {
    const { client, order, writeTool } = await harness();
    const call = () => client.callTool({ name: writeTool.definition.name, arguments: { system: "a" } });
    await Promise.all([call(), call()]);
    expect(order).toEqual(["write:a:start", "write:a:end", "write:a:start", "write:a:end"]);
  });

  it("lets reads overlap", async () => {
    const { client, order, readTool } = await harness();
    const call = () => client.callTool({ name: readTool.definition.name, arguments: { system: "a" } });
    await Promise.all([call(), call()]);
    expect(order).toEqual(["read:a:start", "read:a:start", "read:a:end", "read:a:end"]);
  });

  it("lets writes to different systems run at the same time", async () => {
    const { client, order, writeTool } = await harness(["a", "b"]);
    const call = (system: string) => client.callTool({ name: writeTool.definition.name, arguments: { system } });
    await Promise.all([call("a"), call("b")]);
    // Both started before either finished: the second write was not queued behind the first.
    expect(order.slice(0, 2).sort()).toEqual(["write:a:start", "write:b:start"]);
    expect(order).toHaveLength(4);
  });

  it("queues per system, not globally", async () => {
    const { client, order, writeTool } = await harness(["a", "b"]);
    const call = (system: string) => client.callTool({ name: writeTool.definition.name, arguments: { system } });
    await Promise.all([call("a"), call("a"), call("b")]);
    const firstAEnd = order.indexOf("write:a:end");
    const secondAStart = order.indexOf("write:a:start", order.indexOf("write:a:start") + 1);
    // The second write to A waited for the first one…
    expect(secondAStart).toBeGreaterThan(firstAEnd);
    // …while B did not wait for either of them.
    expect(order.indexOf("write:b:start")).toBeLessThan(firstAEnd);
  });
});

describe("ADT errors reach the client classified", () => {
  it("keeps the ADT code and next action instead of reporting INTERNAL_ERROR", async () => {
    const registry = createRegistry();
    const tool = registry.list()[0]!;
    registry.register(tool.definition.name, () => {
      throw new AdtError({
        code: "locked",
        message: "ADT answered HTTP 403: User DDIC is currently editing ZFOO",
        nextAction: "Release the lock before activating or deleting.",
        status: 403,
        method: "POST",
        path: "/programs/programs/zfoo?_action=LOCK",
      });
    });

    const server = createGatewayServer({
      registry,
      info: { name: packageJson.name, version: VERSION },
      log: () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: tool.definition.name, arguments: {} });
    await clientTransport.close();

    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    const payload = JSON.parse(text) as { code: string; nextAction: string; status: number };
    expect(payload.code).toBe("locked");
    expect(payload.nextAction).toContain("Release the lock");
    expect(payload.status).toBe(403);
  });
});

describe("package identity", () => {
  it("keeps src/version.ts in step with package.json", () => {
    expect(VERSION).toBe(packageJson.version);
  });
});
