/**
 * The gateway facade: a handful of visible tools that reach the whole contract.
 *
 * A model gets a bounded tool budget, and 335 tools do not fit. Hiding tools solves the
 * budget problem but leaves the agent unable to discover or call them. So the surface has
 * two shapes:
 *
 *   list mode    a curated subset is advertised by name (see `tool-filter.ts`)
 *   gateway mode three tools are advertised — list the systems, search the contract, call
 *                any tool by name — and the rest of the contract stays reachable
 *
 * Gateway mode is how a client with a 128-tool ceiling keeps full capability.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { GatewayError } from "../engine/errors.js";
import type { ToolRegistry } from "../engine/registry.js";

export const GATEWAY_TOOL_NAMES = ["GatewayListSystems", "GatewayListTools", "GatewayCallTool"] as const;

export interface GatewayToolContext {
  readonly registry: ToolRegistry;
  readonly systems: readonly string[];
  readonly defaultSystem?: string;
}

const objectSchema = (properties: Record<string, object>, required?: string[]): Tool["inputSchema"] => ({
  type: "object",
  ...(required === undefined ? {} : { required }),
  properties,
});

/** Definitions for `tools/list`. Only shown when gateway mode is on. */
export function gatewayToolDefinitions(context: GatewayToolContext): Tool[] {
  const systemList = context.systems.length === 0 ? "(none configured)" : context.systems.join(", ");
  return [
    {
      name: "GatewayListSystems",
      description: `List the configured SAP systems with their write tier. Available: ${systemList}. Writes are only accepted on tier "dev".`,
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "GatewayListTools",
      description:
        "Search the full tool contract (335 tools) by name pattern, verb or free text. " +
        "Use it to discover a tool, then call it with GatewayCallTool. " +
        'detail: "names" (default), "descriptions" (adds one line each) or "schema" (full input schema for a single tool).',
      inputSchema: objectSchema(
        {
          pattern: { type: "string", description: 'Wildcard over the tool name, e.g. "Get*", "*Program*", "*Low".' },
          verb: {
            type: "string",
            description: "Only tools starting with this verb: Create, Read, Get, Update, Delete, Check, Activate, Search, …",
          },
          query: { type: "string", description: "Free text matched against name and description (case-insensitive)." },
          layer: {
            type: "string",
            enum: ["readonly", "write", "low"],
            description: "readonly = reads only, write = tools that modify, low = the *Low variants.",
          },
          detail: { type: "string", enum: ["names", "descriptions", "schema"], description: 'Default "names".' },
          tool: { type: "string", description: 'Required when detail is "schema".' },
          limit: { type: "integer", description: "Maximum entries to return (default 200)." },
        },
        [],
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "GatewayCallTool",
      description:
        "Call any tool of the contract by name, including tools that are not advertised in this session. " +
        "Arguments are the tool's own arguments; `system` selects the SAP system.",
      inputSchema: objectSchema(
        {
          tool: { type: "string", description: "Exact tool name from the contract, e.g. GetProgram." },
          arguments: {
            type: "object",
            description: "Arguments for that tool, exactly as its schema declares (without `system`).",
          },
          system: { type: "string", description: `SAP system to use (${systemList}).` },
        },
        ["tool"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

const WRITE_VERB = /^(Create|Update|Delete|Activate|Release|Patch)/;

/** Runs one of the gateway tools; `undefined` means "not a gateway tool". */
export async function callGatewayTool(
  name: string,
  args: Record<string, unknown>,
  context: GatewayToolContext,
): Promise<unknown> {
  if (!GATEWAY_TOOL_NAMES.includes(name as (typeof GATEWAY_TOOL_NAMES)[number])) return undefined;

  if (name === "GatewayListSystems") {
    return {
      systems: context.systems.map((id) => ({ id, default: id === context.defaultSystem })),
      note: "Pass `system` on any call; writes require tier dev.",
    };
  }

  if (name === "GatewayListTools") {
    const pattern = typeof args["pattern"] === "string" ? args["pattern"] : undefined;
    const verb = typeof args["verb"] === "string" ? args["verb"].toLowerCase() : undefined;
    const query = typeof args["query"] === "string" ? args["query"].toLowerCase() : undefined;
    // Every word must appear somewhere: "sql query" has to find "Execute ABAP SQL SELECT
    // queries", which a single substring match would miss.
    const words = query === undefined ? [] : query.split(/\s+/).filter((word) => word.length > 0);
    const layer = typeof args["layer"] === "string" ? args["layer"] : undefined;
    const detail = typeof args["detail"] === "string" ? args["detail"] : "names";
    const limit = typeof args["limit"] === "number" && args["limit"] > 0 ? args["limit"] : 200;

    const glob = pattern === undefined ? undefined : new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

    const entries = context.registry.list().filter((entry) => {
      const toolName = entry.definition.name;
      if (glob !== undefined && !glob.test(toolName)) return false;
      if (verb !== undefined && !toolName.toLowerCase().startsWith(verb)) return false;
      if (words.length > 0) {
        const haystack = `${toolName} ${entry.definition.description}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return false;
      }
      if (layer === "low" && !/Low$/.test(toolName)) return false;
      if (layer === "readonly" && entry.meta.effect !== "read") return false;
      if (layer === "write" && entry.meta.effect !== "write") return false;
      return true;
    });

    if (detail === "schema") {
      const wanted = typeof args["tool"] === "string" ? args["tool"] : undefined;
      if (wanted === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'detail "schema" needs `tool`.', { hint: "e.g. { tool: \"GetProgram\", detail: \"schema\" }" });
      }
      const entry = context.registry.get(wanted);
      if (entry === undefined) throw new GatewayError("UNKNOWN_TOOL", `Unknown tool "${wanted}".`);
      return {
        name: entry.definition.name,
        description: entry.definition.description,
        effect: entry.meta.effect,
        inputSchema: entry.definition.inputSchema,
      };
    }

    const total = entries.length;
    const slice = entries.slice(0, limit);
    return {
      total,
      returned: slice.length,
      truncated: total > slice.length,
      tools:
        detail === "descriptions"
          ? slice.map((entry) => ({ name: entry.definition.name, description: entry.definition.description, effect: entry.meta.effect }))
          : slice.map((entry) => entry.definition.name),
      next:
        total > slice.length
          ? "Narrow with pattern / verb / query, or raise limit. Then call with GatewayCallTool."
          : "Call with GatewayCallTool { tool, arguments, system }.",
    };
  }

  // GatewayCallTool
  const tool = typeof args["tool"] === "string" ? args["tool"] : undefined;
  if (tool === undefined || tool.length === 0) {
    throw new GatewayError("INVALID_ARGUMENT", "`tool` is required.");
  }
  if (GATEWAY_TOOL_NAMES.includes(tool as (typeof GATEWAY_TOOL_NAMES)[number])) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool} cannot be called through GatewayCallTool.`);
  }
  if (context.registry.get(tool) === undefined) {
    throw new GatewayError("UNKNOWN_TOOL", `Unknown tool "${tool}".`, {
      hint: "Search with GatewayListTools { pattern }.",
    });
  }

  const raw = args["arguments"];
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new GatewayError("INVALID_ARGUMENT", "`arguments` must be an object.");
  }
  const inner = (raw ?? {}) as Record<string, unknown>;
  const system = typeof args["system"] === "string" ? args["system"] : undefined;
  const value = await context.registry.call(tool, system === undefined ? inner : { ...inner, system }, {
    system,
  });
  return value;
}

/** Exported for the tool list: whether a name belongs to the facade. */
export function isGatewayTool(name: string): boolean {
  return GATEWAY_TOOL_NAMES.includes(name as (typeof GATEWAY_TOOL_NAMES)[number]);
}

export { WRITE_VERB };
