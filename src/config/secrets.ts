/**
 * Credential resolution.
 *
 * The config file never holds a secret — only a reference. This module turns
 * references into values, in memory, and never writes the result anywhere.
 *
 * Supported forms:
 *   env:NAME                     environment variable
 *   file:~/.secrets/name         first line of a file
 *   keychain:service/account     OS keychain (optional dependency)
 */

import { readFileSync } from "node:fs";

import { expandHome } from "./load.js";
import type { EffectiveConfig, EffectiveSystem } from "./schema.js";

export type SecretSource = "env" | "file" | "keychain";

export interface ResolvedSecret {
  readonly value: string;
  readonly source: SecretSource;
}

export class SecretError extends Error {
  readonly ref: string;

  constructor(ref: string, message: string) {
    // The reference itself is not secret (it names a location, not a value).
    super(`${ref}: ${message}`);
    this.name = "SecretError";
    this.ref = ref;
  }
}

export interface ResolveSecretOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => string | undefined;
  /** Injected for tests; defaults to the real keychain binding. */
  readonly keychain?: (service: string, account: string) => Promise<string | undefined>;
}

export async function resolveSecret(
  ref: string,
  options: ResolveSecretOptions = {},
): Promise<ResolvedSecret> {
  const separator = ref.indexOf(":");
  if (separator <= 0) {
    throw new SecretError(ref, "not a reference (expected env:, file: or keychain:)");
  }

  const scheme = ref.slice(0, separator);
  const target = ref.slice(separator + 1);

  switch (scheme) {
    case "env": {
      const env = options.env ?? process.env;
      const value = env[target];
      if (value === undefined || value.length === 0) {
        throw new SecretError(ref, `environment variable "${target}" is not set`);
      }
      return { value, source: "env" };
    }

    case "file": {
      const path = expandHome(target);
      let text: string | undefined;
      try {
        text = (options.readFile ?? ((p: string) => readFileSync(p, "utf8")))(path);
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        throw new SecretError(ref, `file not found: ${path}`);
      }
      const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (firstLine.length === 0) {
        throw new SecretError(ref, `file is empty: ${path}`);
      }
      return { value: firstLine, source: "file" };
    }

    case "keychain": {
      const slash = target.indexOf("/");
      if (slash <= 0 || slash === target.length - 1) {
        throw new SecretError(ref, 'keychain reference must be "keychain:service/account"');
      }
      const service = target.slice(0, slash);
      const account = target.slice(slash + 1);
      const lookup = options.keychain ?? defaultKeychainLookup;
      const value = await lookup(service, account);
      if (value === undefined || value.length === 0) {
        throw new SecretError(
          ref,
          `no keychain entry for service "${service}" account "${account}". ` +
            "Store it with the platform credential manager, or switch this reference to env: or file:.",
        );
      }
      return { value, source: "keychain" };
    }

    default:
      throw new SecretError(ref, `unsupported scheme "${scheme}" (expected env:, file: or keychain:)`);
  }
}

/**
 * The keychain binding is an optional dependency: a missing native module must
 * produce a clear message, not a crash on startup.
 */
async function defaultKeychainLookup(service: string, account: string): Promise<string | undefined> {
  try {
    const module = (await import("@napi-rs/keyring")) as {
      Entry?: new (service: string, account: string) => { getPassword(): string | null };
    };
    if (module.Entry === undefined) return undefined;
    const entry = new module.Entry(service, account);
    return entry.getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

/** A system with credentials resolved. Lives in memory only. */
export interface ConnectedSystem extends Omit<EffectiveSystem, "auth"> {
  readonly auth: {
    readonly type: "basic";
    readonly username: string;
    readonly password: string;
  };
}

/**
 * Resolves every system's credentials.
 *
 * Fails on the first unresolvable reference and names the system, because a
 * half-connected gateway is worse than one that refuses to start.
 */
export async function resolveSystemSecrets(
  config: EffectiveConfig,
  options: ResolveSecretOptions = {},
): Promise<ConnectedSystem[]> {
  const resolved: ConnectedSystem[] = [];

  for (const system of config.systems) {
    try {
      const [username, password] = await Promise.all([
        resolveSecret(system.auth.username, options),
        resolveSecret(system.auth.password, options),
      ]);
      resolved.push({
        ...system,
        auth: { type: "basic", username: username.value, password: password.value },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SecretError(system.id, `cannot resolve credentials: ${detail}`);
    }
  }

  return resolved;
}

/** Replaces credential values so a system can be logged safely. */
export function redactSystem(system: EffectiveSystem): Record<string, unknown> {
  return {
    id: system.id,
    label: system.label,
    tier: system.tier,
    endpoint: system.endpoint,
    auth: {
      type: system.auth.type,
      username: redactReference(system.auth.username),
      password: redactReference(system.auth.password),
    },
  };
}

function redactReference(ref: string): string {
  const separator = ref.indexOf(":");
  if (separator <= 0) return "***";
  return `${ref.slice(0, separator)}:***`;
}
