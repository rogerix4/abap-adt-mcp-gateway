/**
 * Gateway runtime: which systems exist, whether a call may write, and which ADT
 * session it runs in.
 *
 * One `AdtSession` per system, reused for every call. That is not an
 * optimisation: a lock handle is only valid in the session that created it, so
 * `Lock*Low` followed by `Update*Low` in a later call must land in the same
 * ABAP session. `session_id` therefore identifies the system's session rather
 * than creating a new one.
 */

import { AdtSession } from "./adt/session.js";
import { GatewayError } from "./engine/errors.js";
import type { ConnectedSystem } from "./config/secrets.js";
import type { Tier } from "./config/schema.js";

const WRITABLE_TIERS: ReadonlySet<Tier> = new Set<Tier>(["dev"]);

export interface ResolvedSession {
  readonly system: string;
  readonly session: AdtSession;
  readonly sessionId: string;
  readonly language: string;
}

interface SystemEntry {
  readonly system: ConnectedSystem;
  readonly session: AdtSession;
  readonly sessionId: string;
}

export interface GatewayRuntimeOptions {
  /** Per-request ADT timeout; `toolPolicy.timeoutMs` in the config. */
  readonly timeoutMs?: number;
}

/**
 * Re-reads the configuration and hands back the systems it describes.
 *
 * Installed by the server process (which knows where the config lives and how secrets are
 * resolved); the runtime itself must not know how a config is found.
 */
export type SystemReloader = () => Promise<readonly ConnectedSystem[]>;

export interface ReloadResult {
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** Sessions that were ended because the system they belonged to is gone or reloaded. */
  readonly closed: number;
}

export class GatewayRuntime {
  readonly #entries = new Map<string, SystemEntry>();
  readonly #timeoutMs: number;
  readonly #sessionFactory: ((system: ConnectedSystem) => AdtSession) | undefined;
  #reloader: SystemReloader | undefined;

  /**
   * `sessionFactory` exists so tests can drive the family handlers with a
   * scripted HTTP layer; production always builds a real session.
   */
  constructor(
    systems: readonly ConnectedSystem[],
    sessionFactory?: (system: ConnectedSystem) => AdtSession,
    options: GatewayRuntimeOptions = {},
  ) {
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#sessionFactory = sessionFactory;
    for (const system of systems) {
      this.#entries.set(system.id, this.#entryFor(system));
    }
  }

  #entryFor(system: ConnectedSystem): SystemEntry {
    const session =
      this.#sessionFactory?.(system) ??
      new AdtSession({
        url: system.endpoint.url,
        client: system.endpoint.client,
        ...(system.endpoint.language === undefined ? {} : { language: system.endpoint.language }),
        username: system.auth.username,
        password: system.auth.password,
        timeoutMs: this.#timeoutMs,
      });
    return { system, session, sessionId: `sys:${system.id}` };
  }

  /** Installed by the server; without it `ReloadProfile` has nothing to re-read. */
  setReloader(reloader: SystemReloader | undefined): void {
    this.#reloader = reloader;
  }

  get canReload(): boolean {
    return this.#reloader !== undefined;
  }

  /**
   * Replaces every system with what the configuration now says.
   *
   * The new set is loaded **before** the old sessions are touched: a configuration that
   * no longer parses must leave the working sessions alone, or a typo in the config would
   * take the whole gateway offline until it is restarted.
   */
  async reloadSystems(): Promise<ReloadResult> {
    if (this.#reloader === undefined) {
      throw new GatewayError(
        "NOT_IMPLEMENTED",
        "This process was started without a configuration reloader, so there is nothing to re-read.",
        { nextAction: "Restart the gateway after changing the configuration." },
      );
    }
    const systems = await this.#reloader();
    const before = [...this.#entries.keys()];
    let closed = 0;
    for (const entry of this.#entries.values()) {
      await entry.session.close();
      closed += 1;
    }
    this.#entries.clear();
    for (const system of systems) {
      this.#entries.set(system.id, this.#entryFor(system));
    }
    return { before, after: this.systemIds, closed };
  }


  get systemIds(): string[] {
    return [...this.#entries.keys()];
  }

  /** `system` omitted and exactly one configured: use it. Otherwise ask. */
  defaultSystem(): string | undefined {
    if (this.#entries.size === 1) return [...this.#entries.keys()][0];
    return undefined;
  }

  /**
   * Resolves the session for a call and enforces the tier boundary here rather
   * than in every handler.
   */
  resolve(system: string | undefined, sessionId: string | undefined, needsWrite: boolean): ResolvedSession {
    const id = system ?? this.defaultSystem();
    if (id === undefined) {
      throw new GatewayError(
        "SYSTEM_UNKNOWN",
        this.#entries.size === 0
          ? "No system is configured. Add one to the config before calling a tool."
          : `Several systems are configured (${this.systemIds.join(", ")}); pass "system".`,
        { systems: this.systemIds },
      );
    }

    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new GatewayError("SYSTEM_UNKNOWN", `Unknown system "${id}". Configured: ${this.systemIds.join(", ") || "none"}.`, {
        system: id,
        systems: this.systemIds,
      });
    }

    if (sessionId !== undefined && sessionId !== entry.sessionId && /^sys:/.test(sessionId)) {
      throw new GatewayError(
        "INVALID_ARGUMENT",
        `session_id "${sessionId}" does not belong to system "${id}".`,
        { expected: entry.sessionId },
      );
    }

    if (needsWrite && !WRITABLE_TIERS.has(entry.system.tier)) {
      throw new GatewayError(
        "SYSTEM_READ_ONLY",
        `System "${id}" is tier "${entry.system.tier}", which is read-only. Writing requires tier "dev".`,
        { system: id, tier: entry.system.tier },
      );
    }

    return {
      system: id,
      session: entry.session,
      sessionId: entry.sessionId,
      language: entry.system.endpoint.language,
    };
  }

  /** Drops cookies and CSRF for one system, forcing a fresh logon on the next call. */
  resetSession(system: string): void {
    this.#entries.get(system)?.session.reset();
  }

  /**
   * Ends every session this runtime opened (logoff), which releases their enqueues.
   *
   * For one-shot callers — test harnesses, scripts, a future `--call` mode. A server
   * keeps its sessions and must not call this.
   */
  async closeAll(): Promise<void> {
    for (const entry of this.#entries.values()) {
      await entry.session.close();
    }
  }
}
