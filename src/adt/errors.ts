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
 */

export type AdtErrorCode =
  | "auth"
  | "session-expired"
  | "locked"
  | "invalid-lock"
  | "not-found"
  | "content-negotiation"
  | "check-failed"
  | "transport-required"
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
  const message = /<message[^>]*>([\s\S]*?)<\/message>/i.exec(body)?.[1]?.trim();
  if (message !== undefined && message.length > 0) return message;
  const localized = /<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/i.exec(body)?.[1]?.trim();
  if (localized !== undefined && localized.length > 0) return localized;
  const text = body.trim();
  if (text.length === 0) return undefined;
  // A 500 can come back as SAP's HTML error page. Slicing the raw page kept the CSS and
  // dropped the one sentence that says what happened — measured 2026-11-04: a behaviour
  // definition create answered `Access using a 'ZERO' object reference is not possible`,
  // and all the caller saw was `body { background: #ffffff; …`.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    const plain = text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
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
  const lower = (sapText ?? body).toLowerCase();
  const base = { status, method, path, ...(sapText === undefined ? {} : { sapText }) };

  // SAP answers in the logon language, so the Chinese wording is matched as well.
  if (lower.includes("currently editing") || lower.includes("当前编辑") || lower.includes("is locked by")) {
    return new AdtError({
      code: "locked",
      message: `The object is locked: ${sapText ?? "another session holds the lock"}`,
      nextAction:
        "Release the lock before activating or deleting (unlock in the same session), or clear it in SM12 if the owning session is gone.",
      ...base,
    });
  }

  if (status === 423 || lower.includes("invalid lock handle") || lower.includes("not locked")) {
    return new AdtError({
      code: "invalid-lock",
      message: `The lock handle was not accepted: ${sapText ?? "no detail"}`,
      nextAction:
        "The handle is only valid in the session that created it. Keep x-sap-adt-sessiontype: stateful and one sap-adt-connection-id per session, then lock again.",
      ...base,
    });
  }

  if (status === 401 || lower.includes("session timed out") || lower.includes("session expired") || lower.includes("logon")) {
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

  if (lower.includes("no uri-mapping")) {
    return new AdtError({
      code: "not-found",
      message: `Nothing to check at that URI: ${sapText ?? "no URI mapping"}`,
      nextAction:
        "The check maps the URI to a version of the object; a version that does not exist answers 500. Treat as 'nothing to check' rather than a failure.",
      ...base,
    });
  }

  if (lower.includes("transport") && (lower.includes("required") || lower.includes("could not be found") || lower.includes("corrnr"))) {
    return new AdtError({
      code: "transport-required",
      message: `A transport request is required: ${sapText ?? `HTTP ${status}`}`,
      nextAction: "Pass a modifiable request, or write to $TMP. The lock response already carries CORRNR when SAP decided one.",
      ...base,
    });
  }

  if (status >= 500) {
    return new AdtError({
      code: "upstream",
      message: `SAP reported a server error: ${sapText ?? `HTTP ${status}`}`,
      nextAction: "Read the SAP text above; it usually names the object or the missing configuration.",
      ...base,
    });
  }

  return new AdtError({
    code: "upstream",
    message: `ADT answered HTTP ${status}: ${sapText ?? "no detail"}`,
    nextAction: "The status and text above come from SAP; fix the request rather than retrying blindly.",
    ...base,
  });
}

export function networkError(method: string, path: string, cause: unknown): AdtError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AdtError({
    code: "network",
    message: `Cannot reach the system: ${detail}`,
    nextAction: "Check the URL, the network path and the certificate. This is not a request problem.",
    method,
    path,
  });
}
