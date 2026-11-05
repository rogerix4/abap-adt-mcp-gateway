/**
 * MCP protocol layer.
 *
 * Thin on purpose: it maps the frozen contract onto `tools/list` and forwards
 * `tools/call` to the registry. Nothing here knows about SAP.
 *
 * Why `McpServer` plus `mcp.server.setRequestHandler`:
 *   `McpServer` is the supported entry point and exposes its underlying server
 *   for advanced use. Its own tool helpers (`registerTool`) only accept Zod
 *   shapes, while this gateway must return 335 frozen JSON Schemas unchanged —
 *   so the two request handlers are registered on the underlying server
 *   directly. Capabilities are deliberately not passed to the constructor:
 *   `McpServer` installs what it needs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { GatewayError } from "../engine/errors.js";
import { ToolRegistry } from "../engine/registry.js";
import { advertisesFacade, compileExpose, DEFAULT_EXPOSE, type Expose } from "../engine/expose.js";
import type { ToolEffect, ToolMeta } from "../engine/types.js";
import { AdtError } from "../adt/errors.js";
import { callGatewayTool, gatewayToolDefinitions } from "./gateway-tools.js";

export interface GatewayInfo {
  readonly name: string;
  readonly version: string;
  /**
   * Configured system ids.
   *
   * The frozen contract has no `system` parameter, so the server adds one to every
   * tool schema: one server, several systems, and the caller has to be able to say
   * which. Without it every call lands on `defaultSystem` and the other systems are
   * unreachable from a client.
   */
  readonly systems?: readonly string[];
  readonly defaultSystem?: string;
  /**
   * What this client is shown: one level plus its narrowings (`toolPolicy.expose`,
   * `allow`, `deny`). Omitted means `full` — every named tool, nothing hidden.
   */
  readonly expose?: Expose;
}

export interface GatewayServerOptions {
  readonly registry: ToolRegistry;
  readonly info: GatewayInfo;
  readonly log?: (line: string) => void;
}

/**
 * Maps derived metadata onto MCP tool annotations.
 *
 * Annotations are advisory only — they let a client warn before a destructive
 * call. They never change the tool name, description or schema.
 */
function annotationsFor(meta: ToolMeta): Tool["annotations"] {
  const readOnly = meta.effect === "read";
  const destructive = isDestructive(meta.effect, meta.verb);
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}

function isDestructive(effect: ToolEffect, verb: string): boolean {
  if (effect !== "write") {
    return false;
  }
  // Creating something new is not destructive; removing or overwriting is.
  return verb === "Delete" || verb === "Update" || verb === "Activate" || verb === "Release";
}

function toTool(registry: ToolRegistry, info: GatewayInfo): Tool[] {
  const systems = info.systems ?? [];
  const expose = info.expose ?? DEFAULT_EXPOSE;
  const visible = compileExpose(expose, (name) => {
    const meta = registry.get(name)?.meta;
    return meta === undefined ? undefined : { effect: meta.effect === "write" ? "write" : "read" };
  });
  const facade = advertisesFacade(expose.level)
    ? gatewayToolDefinitions({
        registry,
        systems,
        ...(info.defaultSystem === undefined ? {} : { defaultSystem: info.defaultSystem }),
      })
    : [];
  return [
    ...facade,
    ...registry
      .list()
      .filter((entry) => visible(entry.definition.name))
      .map((entry) => {
    const schema = entry.definition.inputSchema as Tool["inputSchema"];
    // One optional argument, added to every tool: which system to talk to. The frozen
    // contract stays as it is (no name, description or required field changes).
    const withSystem: Tool["inputSchema"] =
      systems.length === 0
        ? schema
        : {
            ...schema,
            properties: {
              ...(schema.properties ?? {}),
              system: {
                type: "string",
                ...(systems.length > 1 ? { enum: [...systems] } : {}),
                description:
                  systems.length > 1
                    ? `SAP system to use (${systems.join(", ")}). Required: ${systems.length} systems are configured.`
                    : `SAP system to use (${systems[0]}). Optional: it is the only configured system.`,
              },
            },
          };
    return {
      name: entry.definition.name,
      description: entry.definition.description,
          inputSchema: withSystem,
          annotations: annotationsFor(entry.meta),
        };
      }),
  ];
}

/**
 * Normalises whatever a handler returned into an MCP tool result.
 *
 * Handlers are allowed to return plain data (the common case) or a ready-made
 * `CallToolResult` when they need multiple content blocks.
 */
function toResult(value: unknown): CallToolResult {
  if (isCallToolResult(value)) {
    return value;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: "text", text }] };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { content?: unknown };
  return Array.isArray(candidate.content);
}

function toErrorResult(error: unknown): CallToolResult {
  const payload =
    error instanceof GatewayError
      ? { ok: false, code: error.code, message: error.message, details: error.details }
      : error instanceof AdtError
        ? { ok: false, ...error.toPayload() }
        : {
            ok: false,
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createGatewayServer(options: GatewayServerOptions): McpServer {
  const { registry, info } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  // `McpServer` does not advertise the tools capability on its own; it normally
  // gets it from `registerTool`. Since the handlers are registered on the
  // underlying server, the capability is declared here.
  const mcp = new McpServer(
    { name: info.name, version: info.version },
    { capabilities: { tools: { listChanged: false } } },
  );

  // The SDK's tool helpers announce `listChanged: true` because they can add tools at
  // runtime. This contract is fixed before the transport connects, so the accurate
  // answer is `false` — a client that subscribes will simply never hear from us.
  mcp.server.registerCapabilities({ tools: { listChanged: false } });

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toTool(registry, info) }));

  /**
   * One ADT session per system is reused across calls, and a session is stateful: two
   * writes in flight against the same system interleave their LOCK/UNLOCK and one of
   * them ends up holding a lock it never released. Reads are left alone — they cost
   * nothing to overlap and serialising them would make a wide scan of one system slow
   * every other system's read.
   */
  const writeChains = new Map<string, Promise<unknown>>();

  const serializeWrite = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = writeChains.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    writeChains.set(
      key,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      if (writeChains.get(key) === next || writeChains.get(key) === undefined) writeChains.delete(key);
    }
  };

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const system = typeof args["system"] === "string" ? args["system"] : undefined;

    try {
      const facade = await callGatewayTool(name, args, {
        registry,
        systems: info.systems ?? [],
        ...(info.defaultSystem === undefined ? {} : { defaultSystem: info.defaultSystem }),
      });
      if (facade !== undefined) return toResult(facade);

      const meta = registry.get(name)?.meta;
      // A write hidden behind the facade must still be serialized: `GatewayCallTool` is one
      // tool, but it can run any of them.
      const targetName = name === "GatewayCallTool" && typeof args["tool"] === "string" ? args["tool"] : name;
      const targetMeta = registry.get(targetName)?.meta;
      const call = () => registry.call(name, args, { system, signal: extra.signal });
      const isWrite = meta?.effect === "write" || targetMeta?.effect === "write";
      const value = isWrite ? await serializeWrite(system ?? info.defaultSystem ?? "-", call) : await call();
      return toResult(value);
    } catch (error) {
      if (!(error instanceof GatewayError)) {
        log(`[tool:${name}] failed: ${error instanceof Error ? error.stack : String(error)}`);
      }
      return toErrorResult(error);
    }
  });

  return mcp;
}

export async function serveStdio(options: GatewayServerOptions): Promise<McpServer> {
  const server = createGatewayServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
