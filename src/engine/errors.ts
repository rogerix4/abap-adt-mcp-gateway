/**
 * Errors the gateway raises on purpose.
 *
 * Every client-visible failure has a stable code so callers (and the audit log)
 * can branch on it without matching message text. Messages are meant to be
 * actionable: they say what was wrong and what to do next.
 */

export type GatewayErrorCode =
  | "UNKNOWN_TOOL"
  | "NOT_IMPLEMENTED"
  | "INVALID_ARGUMENT"
  | "TOOL_NOT_ALLOWED"
  | "TOOL_HIDDEN"
  | "SYSTEM_UNKNOWN"
  | "SYSTEM_READ_ONLY"
  | "UPSTREAM_FAILED"
  | "CONFIG_INVALID"
  /** The payload did not match what the caller declared (sha256 / line count / patch match count). Nothing was written. */
  | "CONTENT_MISMATCH";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: GatewayErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.details = details;
  }
}

export function unknownTool(name: string, hint?: string): GatewayError {
  const suffix = hint === undefined ? "" : ` ${hint}`;
  return new GatewayError("UNKNOWN_TOOL", `Unknown tool "${name}".${suffix}`, { tool: name });
}

export function notImplemented(name: string, phase: string): GatewayError {
  return new GatewayError(
    "NOT_IMPLEMENTED",
    `Tool "${name}" is registered but not implemented yet (planned in ${phase}).`,
    { tool: name, phase },
  );
}

export function invalidArgument(message: string, details?: Record<string, unknown>): GatewayError {
  return new GatewayError("INVALID_ARGUMENT", message, details);
}
