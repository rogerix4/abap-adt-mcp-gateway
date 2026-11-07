/**
 * ADT error classification.
 *
 * ADT answers in ways that read like something else:
 *   - a dead session returns 400/401/403 and looks like "your source is wrong";
 *   - activating an object that is still locked returns 403 "user is currently
 *     editing", which looks like a permission problem;
 *   - `No URI-Mapping defined for URI` is a 500 that really means "nothing to
 *     check here".
 *
 * Every classify step below exists because one of those cost a debugging round.
 * The `code` is what callers branch on; the message is what a human reads.
 *
 * The wording itself lives in `signals.ts`, in one table with its evidence, because SAP
 * answers in the logon language and four of the five configured systems log on in `ZH`.
 */

import { hasSignal, isTransportRequired } from "./signals.js";
import { findElements, nodeTextOf, parseXml, plainText } from "./xml.js";

export type AdtErrorCode =
  | "auth"
  | "session-expired"
  | "locked"
  | "invalid-lock"
  | "not-found"
  | "already-exists"
  /** SAP refused the request itself (400/422/…): the caller has to change something. */
  | "request-rejected"
  | "content-negotiation"
  | "check-failed"
  | "transport-required"
  /** A 2xx/4xx body in a shape this gateway does not understand. Never treated as success. */
  | "unrecognized-response"
  | "upstream"
  | "network";

export interface AdtErrorInit {
  readonly code: AdtErrorCode;
  readonly message: string;
  readonly nextAction: string;
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;
  /** Text SAP sent, kept for diagnosis; never contains credentials. */
  readonly sapText?: string;
}

export class AdtError extends Error {
  readonly code: AdtErrorCode;
  readonly nextAction: string;
  readonly status: number | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly sapText: string | undefined;

  constructor(init: AdtErrorInit) {
    super(init.message);
    this.name = "AdtError";
    this.code = init.code;
    this.nextAction = init.nextAction;
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.sapText = init.sapText;
  }

  /** Stable, credential-free shape for tool results and the audit log. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      nextAction: this.nextAction,
      status: this.status,
      method: this.method,
      path: this.path,
      sapText: this.sapText,
    };
  }
}

/** Pulls the human-readable part out of an ADT exception document. */
export function sapMessageOf(body: string): string | undefined {
  const text = body.trim();
  if (text.length === 0) return undefined;
  // Structural for an XML answer: `<message>` and `<localizedMessage>` are read through the
  // parser, so a sentence containing an escaped `<` or a nested element survives whole.
  if (text.startsWith("<")) {
    const parsed = parseXml(text);
    if (parsed !== undefined) {
      for (const name of ["message", "localizedMessage"]) {
        // A failed DDL save answers one generic sentence in the first `<message>` and the
        // reason in the following ones; keeping only the first threw the reason away.
        const values = findElements(parsed, name)
          .map((node) => nodeTextOf(node))
          .filter((value) => value.length > 0);
        const unique = [...new Set(values)];
        if (unique.length > 0) {
          const joined = unique.slice(0, 3).join(" · ");
          return unique.length > 3 ? `${joined} …` : joined;
        }
      }
    }
  }
  // A 500 can come back as SAP's HTML error page. Slicing the raw page kept the CSS and
  // dropped the one sentence that says what happened — measured: a behaviour
  // definition create answered `Access using a 'ZERO' object reference is not possible`,
  // and all the caller saw was `body { background: #ffffff; …`.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    const plain = plainText(text);
    return plain.length === 0 ? "the server answered an empty error page" : plain.slice(0, 400);
  }
  return text.slice(0, 400);
}

interface ClassifyInput {
  readonly status: number;
  readonly body: string;
  readonly method: string;
  readonly path: string;
}

/** Returns an error for a bad response, or `undefined` when the call succeeded. */
export function classifyResponse(input: ClassifyInput): AdtError | undefined {
  const { status, body, method, path } = input;
  if (status >= 200 && status < 300) return undefined;

  const sapText = sapMessageOf(body);
  const base = { status, method, path, ...(sapText === undefined ? {} : { sapText }) };

  // SAP answers in the logon language, so the Chinese wording is matched as well —
  // the table in `signals.ts` holds both and records where each wording was seen.
  if (hasSignal(sapText ?? body, "currently-editing") || hasSignal(sapText ?? body, "already-locked")) {
    return new AdtError({
      code: "locked",
      message: `The object is locked: ${sapText ?? "another session holds the lock"}`,
      nextAction:
        "Release the lock before activating or deleting (unlock in the same session), or clear it in SM12 if " +
        "the owning session is gone. A lock whose user is your own logon belongs to a different ADT session of " +
        "yours — an open editor tab, or a client that exited without unlocking; close the tab or delete the SM12 " +
        "entry by object name. This session cannot release a handle it never received, so retrying here cannot help.",
      ...base,
    });
  }

  if (status === 423 || hasSignal(sapText ?? body, "invalid-lock")) {
    return new AdtError({
      code: "invalid-lock",
      message: `The lock handle was not accepted: ${sapText ?? "no detail"}`,
      nextAction:
        "The handle is only valid in the session that created it. Keep x-sap-adt-sessiontype: stateful and one sap-adt-connection-id per session, then lock again.",
      ...base,
    });
  }

  if (status === 401 || hasSignal(sapText ?? body, "session-expired")) {
    return new AdtError({
      code: "session-expired",
      message: `The ADT session is gone: ${sapText ?? `HTTP ${status}`}`,
      nextAction: "The session is reset and the call is replayed once automatically. If it still fails, check the credentials.",
      ...base,
    });
  }

  if (status === 406 || status === 415) {
    return new AdtError({
      code: "content-negotiation",
      message: `The endpoint rejected the media type: ${sapText ?? `HTTP ${status}`}`,
      nextAction: "Retry with Accept: */* — several ADT resources reject the type their own discovery document advertises.",
      ...base,
    });
  }

  if (status === 404) {
    return new AdtError({
      code: "not-found",
      message: `Not found: ${sapText ?? path}`,
      nextAction: "Check the object name and type. A deleted or never-created object answers the same way.",
      ...base,
    });
  }

  // A duplicate create answers **500** with a sentence, not 409 — measured live:
  // `CreateProgram ZMCP_T01` twice → `已存在名为 ZMCP_T01 的程序或 include`. Classifying that as
  // `upstream` sends the caller hunting for a server problem, and the generic nextAction
  // ("read the SAP text") never says what to do instead. The name being taken is an ordinary
  // answer with an ordinary remedy, so it gets its own code and its own sentence.
  if (hasSignal(sapText ?? body, "already-exists")) {
    return new AdtError({
      code: "already-exists",
      message: `The object already exists: ${sapText ?? `HTTP ${status}`}`,
      nextAction:
        "Use the Update* tool to write it, Read*/Get* to inspect it, or Delete* first if it should be created fresh.",
      ...base,
    });
  }

  if (hasSignal(sapText ?? body, "no-uri-mapping")) {
    return new AdtError({
      code: "not-found",
      message: `Nothing to check at that URI: ${sapText ?? "no URI mapping"}`,
      nextAction:
        "The check maps the URI to a version of the object; a version that does not exist answers 500. Treat as 'nothing to check' rather than a failure.",
      ...base,
    });
  }

  if (isTransportRequired(sapText ?? body)) {
    return new AdtError({
      code: "transport-required",
      message: `A transport request is required: ${sapText ?? `HTTP ${status}`}`,
      nextAction: "Pass a modifiable request, or write to $TMP. The lock response already carries CORRNR when SAP decided one.",
      ...base,
    });
  }

  if (status >= 500) {
    // A missing *parent* object answers 5xx with a plain "does not exist" text, not 404 — measured
    //: `CreateFunctionModule` in a group that is not there answered
    // `500 功能组 X 不存在`. Reporting that as `upstream` sends the caller looking for a server
    // problem; the request named an object that does not exist, which is a `not-found`.
    const missingParent = /不存在|does not exist|not found/i.test(sapText ?? body);
    if (missingParent) {
      return new AdtError({
        code: "not-found",
        message: `Not found: ${sapText ?? `HTTP ${status}`}`,
        nextAction:
          "SAP named an object that does not exist (usually the parent: function group, program, class, package). Create or correct it first.",
        ...base,
      });
    }
    return new AdtError({
      code: "upstream",
      message: `SAP reported a server error: ${sapText ?? `HTTP ${status}`}`,
      nextAction: "Read the SAP text above; it usually names the object or the missing configuration.",
      ...base,
    });
  }

  return new AdtError({
    // Measured live: `CreateTable ZT_MCP_T01` answered HTTP **422**
    // `表 ZT_MCP_T01 (不允许底线位于第二或第三库位)` — a naming rule the caller broke, and the
    // answer said `upstream`, which reads as "the server is broken, retry". A 4xx is never the
    // server's fault: it is a request the caller has to change.
    code: status >= 400 && status < 500 ? "request-rejected" : "upstream",
    message:
      status >= 400 && status < 500
        ? `SAP rejected the request: ${sapText ?? `HTTP ${status}`}`
        : `ADT answered HTTP ${status}: ${sapText ?? "no detail"}`,
    nextAction:
      status >= 400 && status < 500
        ? "The text above comes from SAP and names what it refused; change the request rather than retrying."
        : "The status and text above come from SAP; fix the request rather than retrying blindly.",
    ...base,
  });
}

export function networkError(method: string, path: string, cause: unknown): AdtError {
  const detail = describeCause(cause);
  // A read can be repeated for free; a write cannot. The same sentence for both is what
  // makes a caller retry a `Create…` whose answer was lost and then read "already exists"
  // as a failure — the object exists, the report is wrong.
  const retryAdvice =
    method.toUpperCase() === "GET"
      ? "A failure that names a code (ECONNRESET, ETIMEDOUT, …) is worth one retry; a repeated one is not."
      : `Whether SAP applied this ${method} is unknown: the answer never arrived. Read the object back (a \`Get*\` on the same name) before sending it again — a blind retry can create a second object or overwrite the first one.`;
  return new AdtError({
    code: "network",
    message: `Cannot reach the system: ${detail}`,
    nextAction: `Check the URL, the network path and the certificate. This is not a request problem. ${retryAdvice}`,
    method,
    path,
  });
}

/**
 * Node's `fetch failed` says nothing on its own — the reason (ECONNRESET, ETIMEDOUT, a
 * certificate problem) sits in `cause`. Measured: two `CreateClass` calls
 * answered `Cannot reach the system: fetch failed` while the endpoint was up, and the
 * caller had no way to tell a dropped TLS handshake from a wrong host.
 */
function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const parts: string[] = [cause.message];
  let inner: unknown = (cause as { cause?: unknown }).cause;
  for (let depth = 0; depth < 3 && inner instanceof Error; depth += 1) {
    const code = (inner as { code?: string }).code;
    parts.push(code === undefined ? inner.message : `${inner.message} (${code})`);
    inner = (inner as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
}
