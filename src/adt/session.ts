/**
 * One ADT session.
 *
 * Everything that is easy to get wrong about talking to ADT lives here, once:
 * the client/language headers, the CSRF token, the cookie jar, the stateful
 * session identity, and the "the session died, replay once" rule.
 *
 * Uses the platform `fetch`, so there is no HTTP client to keep in step.
 */

import { randomUUID } from "node:crypto";

import { AdtError, classifyResponse, networkError } from "./errors.js";
import { LockJournal, lockJournalFor } from "./lock-journal.js";

export type AdtMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface AdtRequest {
  readonly method?: AdtMethod;
  /** Path below `/sap/bc/adt`, e.g. `/programs/programs/zfoo/source/main`. */
  readonly path: string;
  /** Use `path` as-is (the SOAP RFC endpoint lives outside `/sap/bc/adt`). */
  readonly absolute?: boolean;
  readonly accept?: string;
  readonly contentType?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  /** Replay once after SAP reports a dead session. Defaults to true. */
  readonly retryOnSessionLoss?: boolean;
  /** Send `x-sap-adt-sessiontype: stateful`. Defaults to true. */
  readonly stateful?: boolean;
}

export interface AdtResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface AdtSessionOptions {
  /** System root without the ADT path, e.g. `https://host:44300`. */
  readonly url: string;
  readonly client: string;
  readonly language?: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export const ADT_BASE = "/sap/bc/adt";

/** The lock handle in a LOCK answer, in either shape SAP sends it. */
export function lockHandleFromBody(body: string): string | undefined {
  const xml = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/i.exec(body)?.[1]?.trim();
  if (xml !== undefined && xml.length > 0) return xml;
  const json = /"LOCK_HANDLE"\s*:\s*"([^"]+)"/i.exec(body)?.[1]?.trim();
  return json !== undefined && json.length > 0 ? json : undefined;
}

interface LockTarget {
  /**
   * `lock` = the request takes a lock, `unlock` = it gives one back,
   * `delete` = it carries a handle but says nothing about the enqueue.
   */
  readonly kind: "lock" | "unlock" | "delete";
  /** Path without the query, the way the journal keys objects. */
  readonly path: string;
  readonly handle?: string;
}

/**
 * Which requests need the lock journal.
 *
 * The decision is made at the transport level, for **every** request: locks are also
 * taken by the plain `Lock*` tools and by deletes, not only by the high-level lock
 * helper — a journal that only sees one of those paths leaves the rest unreleasable.
 *
 * Measured on the reference system (2026-11-04): `DELETE ...?lockHandle=` deletes the object but
 * leaves the name-level enqueue behind, so a delete must **not** be journaled as
 * "handle consumed". Treating it that way dropped the only handle that could ever
 * have released it — the object then answered `404 The object is locked: user X is
 * currently editing it` and no tool could create the name again.
 */
function lockTargetOf(method: AdtMethod, request: AdtRequest): LockTarget | undefined {
  if (request.absolute === true) return undefined;
  if (method !== "POST" && method !== "DELETE") return undefined;
  const [path = request.path, query = ""] = request.path.split("?");
  const params = new URLSearchParams(query);
  if (method === "POST" && params.get("_action") === "LOCK") return { kind: "lock", path };
  const handle = params.get("lockHandle");
  if (handle === null || handle.length === 0) return undefined;
  return { kind: method === "DELETE" ? "delete" : "unlock", path, handle };
}

export class AdtSession {
  readonly #options: AdtSessionOptions;
  readonly #fetch: typeof fetch;
  readonly #cookies = new Map<string, string>();
  /**
   * `sap-adt-connection-id` groups requests into one ABAP session.
   *
   * Not decoration: the lock handle is only valid in the session that created
   * it, and an unactivated draft is published by an activation in that same
   * session. Without a stable id the symptom is `423 invalid lock handle` right
   * after a successful lock.
   */
  #connectionId: string = randomUUID();
  #csrfToken: string | undefined;
  /** Object URL -> lock handle, on disk. */
  #journal: LockJournal | undefined;
  /** Set while the journal itself is talking to SAP, so its requests are not journalled. */
  #inLockHousekeeping = false;
  /**
   * How many locks this session is holding. Used for two things: never dropping to
   * stateless, and never letting a `sap-contextid` cookie clobber the stateful
   * context. Both symptoms are the same one — "the lock cannot be released any more".
   */
  #openLocks = 0;

  constructor(options: AdtSessionOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.#options.url.replace(/\/+$/, "");
  }

  get client(): string {
    return this.#options.client;
  }

  get language(): string | undefined {
    return this.#options.language;
  }

  /** The logon the session runs as, for the lock journal's file name. */
  get username(): string {
    return this.#options.username;
  }

  /** Call that throws a classified `AdtError` for any non-2xx status. */
  async request(request: AdtRequest): Promise<AdtResponse> {
    const method: AdtMethod = request.method ?? "GET";
    const replay = request.retryOnSessionLoss !== false;
    const lockTarget = lockTargetOf(method, request);
    // Give back our own stale lock before asking for a new one: a LOCK whose answer
    // was lost leaves the object locked to this user and nothing else can clear it.
    if (lockTarget?.kind === "lock" && !this.#inLockHousekeeping) {
      await this.#releaseOwnStaleLock(lockTarget.path);
    }
    // The CSRF token belongs to the ADT endpoint family. An absolute path points
    // somewhere else entirely (the SOAP RFC endpoint), which authenticates on the
    // request itself — fetching a token there is a wasted round trip that fails
    // outright when the caller is not talking ADT.
    const needsCsrf = method !== "GET" && request.absolute !== true;
    if (needsCsrf) {
      // Not fatal, deliberately: a token that cannot be fetched right now must not abort
      // a lock sequence half way (which would leave the lock behind). The request goes
      // out without one, SAP rejects it, and the retry below fetches a fresh token.
      try {
        await this.#ensureCsrf();
      } catch {
        /* handled by the CSRF replay */
      }
    }

    let response: AdtResponse;
    try {
      response = await this.#send(request, needsCsrf);
    } catch (error) {
      throw networkError(method, request.path, error);
    }

    let failure = classifyResponse({
      status: response.status,
      body: response.body,
      method,
      path: request.path,
    });

    if (failure?.code === "session-expired" && replay) {
      this.reset();
      if (needsCsrf) await this.#ensureCsrf();
      try {
        response = await this.#send(request, needsCsrf);
      } catch (error) {
        throw networkError(method, request.path, error);
      }
      failure = classifyResponse({
        status: response.status,
        body: response.body,
        method,
        path: request.path,
      });
    }

    if (failure !== undefined && needsCsrf && /csrf/i.test(`${failure.sapText ?? ""} ${failure.message}`)) {
      const replayed = await this.#retryAfterCsrfRejection(request);
      if (replayed !== undefined) {
        response = replayed;
        failure = classifyResponse({
          status: response.status,
          body: response.body,
          method,
          path: request.path,
        });
      }
    }

    if (failure) throw failure;
    this.#journalLockAnswer(lockTarget, response.body);
    return response;
  }

  /**
   * Re-fetch the CSRF token and replay once after SAP rejected the one we had.
   *
   * The token can expire while a session lives, and the answer (`CSRF token
   * validation failed`, a 403) reads like a permission problem. A write that fails
   * there is what turns a lock into an orphan.
   */
  async #retryAfterCsrfRejection(request: AdtRequest): Promise<AdtResponse | undefined> {
    const method: AdtMethod = request.method ?? "GET";
    if (method === "GET") return undefined;
    this.#csrfToken = undefined;
    try {
      await this.#ensureCsrf();
    } catch {
      return undefined;
    }
    try {
      return await this.#send(request, true);
    } catch {
      return undefined;
    }
  }

  /** Remembers a handle a LOCK produced; drops one only when an UNLOCK confirms it. */
  #journalLockAnswer(lockTarget: LockTarget | undefined, body: string): void {
    if (lockTarget === undefined || this.#inLockHousekeeping) return;
    const journal = this.#lockJournal();
    if (lockTarget.kind === "lock") {
      const handle = lockHandleFromBody(body);
      if (handle !== undefined) {
        journal.remember(this.#objectUrl(lockTarget.path), handle);
        this.#openLocks += 1;
      }
      return;
    }
    // A DELETE keeps the handle: the enqueue survives the object (measured), and the
    // handle is the only lever that can still release it.
    if (lockTarget.kind === "delete") return;
    if (lockTarget.handle !== undefined) {
      journal.forget(lockTarget.handle);
      this.#openLocks = Math.max(0, this.#openLocks - 1);
    }
  }

  /**
   * Unlock what the journal says we still hold for this object.
   *
   * A failure is not fatal and never surfaces: the following LOCK reports the real
   * reason. Requests made from here must not re-enter the journal.
   */
  async #releaseOwnStaleLock(path: string): Promise<boolean> {
    const handle = this.#lockJournal().handleFor(this.#objectUrl(path));
    if (handle === undefined) return false;
    this.#inLockHousekeeping = true;
    try {
      await this.request({
        method: "POST",
        path: `${path}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
        accept: "*/*",
        retryOnSessionLoss: false,
      });
      this.#lockJournal().forget(handle);
      return true;
    } catch {
      return false;
    } finally {
      this.#inLockHousekeeping = false;
    }
  }

  /** The object as a journal key: absolute, without the query string. */
  #objectUrl(path: string): string {
    return `${this.baseUrl}${ADT_BASE}${path.split("?")[0] ?? path}`;
  }

  /** The journal this session writes to. */
  #lockJournal(): LockJournal {
    this.#journal ??= lockJournalFor({
      baseUrl: this.baseUrl,
      client: this.client,
      username: this.username,
    });
    return this.#journal;
  }

  async text(request: AdtRequest): Promise<string> {
    return (await this.request(request)).body;
  }

  /**
   * Retry once with `Accept: *\\/*` when the endpoint rejects the advertised
   * media type. Several ADT resources do exactly that.
   */
  async requestAcceptingAny(request: AdtRequest): Promise<AdtResponse> {
    try {
      return await this.request(request);
    } catch (error) {
      if (error instanceof AdtError && error.code === "content-negotiation") {
        return this.request({ ...request, accept: "*/*", retryOnSessionLoss: false });
      }
      throw error;
    }
  }

  /** Drop cookies and the CSRF token so the next call logs in again. */
  reset(): void {
    this.#cookies.clear();
    this.#csrfToken = undefined;
  }

  /**
   * Ends the ABAP session, which is what releases its session-scoped enqueues.
   *
   * Measured 2026-11-04: a killed client does **not** end the session — SAP keeps the
   * stateful context alive and with it every lock it took, `DDACT_LOCK` (DDIC
   * activation) included. A one-shot caller that just exits therefore leaves locks
   * behind that nobody can release. `GET /sap/public/bc/icf/logoff` ends the session
   * properly; a long-running server never calls this.
   */
  async close(): Promise<boolean> {
    try {
      await this.request({
        method: "GET",
        path: "/sap/public/bc/icf/logoff",
        accept: "*/*",
        absolute: true,
        retryOnSessionLoss: false,
      });
      return true;
    } catch {
      return false;
    } finally {
      this.reset();
    }
  }

  /**
   * A snapshot of what a caller would need to reason about this session:
   * the connection id SAP groups the stateful requests under, the CSRF token,
   * the cookies it answered with, and how many locks it still holds.
   *
   * Calls `#ensureCsrf()` first, so the values are real: without it a fresh
   * process reports three empty strings and the caller cannot tell "not logged
   * on yet" from "session broken".
   */
  async describe(): Promise<{
    readonly connection_id: string;
    readonly csrf_token: string;
    readonly cookies: string;
    readonly open_locks: number;
    /** The handles themselves — a count cannot be released, a handle can. */
    readonly locks: readonly { readonly uri: string; readonly handle: string }[];
  }> {
    await this.#ensureCsrf();
    // The journal, not the counter: the counter is a transport hint (it decides the
    // session type), the journal is what SAP is actually holding for this logon.
    const locks = Object.entries(this.#lockJournal().read()).map(([uri, handle]) => ({ uri, handle }));
    return {
      connection_id: this.#connectionId,
      csrf_token: this.#csrfToken ?? "",
      cookies: this.#cookieHeader() ?? "",
      open_locks: Math.max(this.#openLocks, locks.length),
      locks,
    };
  }

  async #ensureCsrf(): Promise<void> {
    if (this.#csrfToken !== undefined) return;

    const response = await this.#send(
      {
        method: "GET",
        path: "/discovery",
        accept: "application/atomsvc+xml",
        headers: { "x-csrf-token": "fetch" },
      },
      false,
    );

    const failure = classifyResponse({
      status: response.status,
      body: response.body,
      method: "GET",
      path: "/discovery",
    });
    if (failure) throw failure;

    const token = response.headers["x-csrf-token"];
    if (token === undefined || token.length === 0 || token.toLowerCase() === "required") {
      throw new AdtError({
        code: "auth",
        message: "SAP did not hand out a CSRF token.",
        nextAction: "The logon was not accepted. Check the credentials; a blank token means the user is not authenticated.",
        status: response.status,
        method: "GET",
        path: "/discovery",
      });
    }
    this.#csrfToken = token;
  }

  async #send(request: AdtRequest, withCsrf: boolean): Promise<AdtResponse> {
    const method: AdtMethod = request.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.#options.username}:${this.#options.password}`).toString("base64")}`,
      "sap-client": this.#options.client,
      ...(request.headers ?? {}),
    };

    if (this.#options.language !== undefined) headers["sap-language"] = this.#options.language;
    if (request.accept !== undefined) headers["Accept"] = request.accept;
    if (request.contentType !== undefined) headers["Content-Type"] = request.contentType;
    // A lock handle only survives in a stateful context, so a request that asks to be
    // stateless while a lock is held is honoured as stateful: otherwise the next call
    // answers 423 invalid lock handle right after a successful lock.
    if (request.stateful !== false || this.#openLocks > 0) headers["x-sap-adt-sessiontype"] = "stateful";
    headers["sap-adt-connection-id"] = this.#connectionId;
    if (withCsrf && method !== "GET" && this.#csrfToken !== undefined) {
      headers["x-csrf-token"] = this.#csrfToken;
    }

    const cookie = this.#cookieHeader();
    if (cookie !== undefined) headers["Cookie"] = cookie;

    const response = await this.#fetch(`${this.baseUrl}${request.absolute === true ? "" : ADT_BASE}${request.path}`, {
      method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(request.timeoutMs ?? this.#options.timeoutMs ?? 180_000),
    });

    this.#absorbCookies(response.headers);

    const outHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      outHeaders[key.toLowerCase()] = value;
    }

    // The server may hand back its own id; echoing theirs is what keeps the
    // session. Overwriting it with ours splits the session in two.
    const returned = outHeaders["sap-adt-connection-id"];
    if (returned !== undefined && returned.length > 0) this.#connectionId = returned;

    return { status: response.status, headers: outHeaders, body: await response.text() };
  }

  #cookieHeader(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  #absorbCookies(headers: Headers): void {
    const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(";")[0] ?? "";
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (name.length === 0) continue;
      // A request that ran outside a stateful context answers `sap-contextid=0`. Storing
      // it replaces the context that holds our lock handle, and the next PUT answers
      // 423 invalid lock handle while the lock itself stays in SM12. Keep ours.
      if (name.toLowerCase() === "sap-contextid" && (value === "0" || value === "") && this.#openLocks > 0) continue;
      this.#cookies.set(name, value);
    }
    // SAP may answer `sap-usercontext=sap-client=<system default>` regardless of the
    // client this session asked for, which routes later requests to the wrong client
    // (writes then answer 403). Pin the client we were configured with.
    if (this.#cookies.size > 0) this.#cookies.set("sap-usercontext", `sap-client=${this.#options.client}`);
  }
}
