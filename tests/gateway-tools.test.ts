/**
 * The gateway facade.
 *
 * A client with a small tool budget cannot be given 335 tools, and hiding them leaves the
 * agent unable to discover or call anything. The facade is the answer: three advertised
 * tools, and `GatewayCallTool` reaches the whole contract — including tools the filter
 * hides, because visibility is not authorisation.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createRegistry } from "../src/engine/create-registry.ts";
import { compileExpose } from "../src/engine/expose.ts";
import { createGatewayServer } from "../src/mcp/server.ts";
import { GATEWAY_TOOL_NAMES } from "../src/mcp/gateway-tools.ts";

const transports: InMemoryTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) {
    await transport.close();
  }
});

const connect = async (info: Parameters<typeof createGatewayServer>[0]["info"], handlers: Record<string, () => unknown> = {}) => {
  const registry = createRegistry();
  for (const [name, handler] of Object.entries(handlers)) registry.register(name, handler as never);
  const server = createGatewayServer({ registry, info, log: () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transports.push(clientTransport, serverTransport);
  const client = new Client({ name: "facade-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, registry };
};

describe("gateway facade", () => {
  it("advertises three tools and hides the contract when every switch is off", async () => {
    const { client } = await connect({
      name: "abap-adt-mcp-gateway",
      version: "0.0.0",
      systems: ["dev"],
      expose: { level: "gateway" },
    });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...GATEWAY_TOOL_NAMES]);
  });

  it("lists the systems", async () => {
    const { client } = await connect({
      name: "abap-adt-mcp-gateway",
      version: "0.0.0",
      systems: ["dev", "qas"],
      defaultSystem: "dev",
      expose: { level: "gateway" },
    });
    const result = await client.callTool({ name: "GatewayListSystems", arguments: {} });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      systems: Array<{ id: string; default: boolean }>;
    };
    expect(payload.systems.map((system) => system.id)).toEqual(["dev", "qas"]);
    expect(payload.systems.find((system) => system.default)?.id).toBe("dev");
  });

  it("searches the whole contract, including tools the filter hides", async () => {
    const { client } = await connect({
      name: "abap-adt-mcp-gateway",
      version: "0.0.0",
      systems: ["dev"],
      expose: { level: "gateway" },
    });
    const result = await client.callTool({ name: "GatewayListTools", arguments: { query: "sql query" } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { tools: string[] };
    expect(payload.tools).toContain("GetSqlQuery");

    const names = await client.callTool({ name: "GatewayListTools", arguments: { pattern: "*Program*", detail: "names" } });
    const listed = JSON.parse((names.content as Array<{ text: string }>)[0]!.text) as { tools: string[] };
    expect(listed.tools).toContain("CreateProgram");
    expect(listed.tools).toContain("UpdateProgramLow");
  });

  it("returns a tool's input schema on request", async () => {
    const { client } = await connect({
      name: "abap-adt-mcp-gateway",
      version: "0.0.0",
      systems: ["dev"],
      expose: { level: "gateway" },
    });
    const result = await client.callTool({ name: "GatewayListTools", arguments: { tool: "UpdateProgram", detail: "schema" } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    };
    expect(payload.name).toBe("UpdateProgram");
    expect(Object.keys(payload.inputSchema.properties)).toContain("source_code");
  });

  it("calls a hidden tool through the facade", async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = await connect(
      {
        name: "abap-adt-mcp-gateway",
        version: "0.0.0",
        systems: ["dev"],
        expose: { level: "gateway" },
      },
      {
        GetProgram: ((args: Record<string, unknown>) => {
          seen.push(args);
          return { source_code: "REPORT z.", system: args["system"] };
        }) as never,
      },
    );

    const result = await client.callTool({
      name: "GatewayCallTool",
      arguments: { tool: "GetProgram", arguments: { program_name: "ZFOO" }, system: "dev" },
    });
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ program_name: "ZFOO", system: "dev" });
  });

  it("refuses an unknown tool and refuses to recurse into itself", async () => {
    const { client } = await connect({
      name: "abap-adt-mcp-gateway",
      version: "0.0.0",
      systems: ["dev"],
      expose: { level: "gateway" },
    });

    const unknown = await client.callTool({ name: "GatewayCallTool", arguments: { tool: "NoSuchTool" } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as Array<{ text: string }>)[0]!.text).toContain("UNKNOWN_TOOL");

    const recursive = await client.callTool({ name: "GatewayCallTool", arguments: { tool: "GatewayCallTool" } });
    expect(recursive.isError).toBe(true);
  });

  it("stays off unless gateway mode is enabled", async () => {
    const { client } = await connect({
      name: "abap-adt-mcp-gateway",
      version: "0.0.0",
      systems: ["dev"],
      expose: { level: "full" },
    });
    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name.startsWith("Gateway"))).toBe(false);
  });
});

describe("layered filter used by the facade", () => {
  it("drops every layer when the list is empty", () => {
    const visible = compileExpose({ level: "none" }, () => ({ effect: "read" }));
    expect(visible("GetProgram")).toBe(false);
  });
});
