/**
 * Public entry point.
 *
 * Exported surface is intentionally small: build a registry, hand it to the MCP
 * server. Everything else (config, sessions, object families) is internal until
 * the phase that implements it lands.
 */

export { createRegistry } from "./engine/create-registry.js";
export { GatewayRuntime } from "./runtime.js";
export { implementedFamilies, registerFamilies } from "./families/index.js";
export { registerFamily } from "./families/handlers.js";
export { programFamily } from "./families/program.js";
export type { ObjectFamily, CreateContext } from "./families/types.js";
export { AdtSession } from "./adt/session.js";
export { AdtError } from "./adt/errors.js";
export { loadConfig, ConfigError } from "./config/load.js";
export { resolveSystemSecrets, SecretError } from "./config/secrets.js";
export { ToolRegistry, type CoverageReport, type ToolContext, type ToolHandler } from "./engine/registry.js";
export { GatewayError, type GatewayErrorCode } from "./engine/errors.js";
export type {
  ToolDefinition,
  ToolEffect,
  ToolEntry,
  ToolInputSchema,
  ToolLayer,
  ToolMeta,
  ToolRequirements,
} from "./engine/types.js";
export { createGatewayServer, serveStdio, type GatewayInfo, type GatewayServerOptions } from "./mcp/server.js";
