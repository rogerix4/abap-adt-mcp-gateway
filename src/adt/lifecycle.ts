/**
 * ADT lifecycle primitives: lock, write, activate, check, delete.
 *
 * They live together because every one of them is the same request for every
 * object type, and because each has a documented way of lying to you:
 *
 *   - activating while our own lock is held answers 403 "currently editing";
 *   - the classic activation answers 200 with an empty body — and that means
 *     success, so the status alone never tells you whether anything changed;
 *   - DELETE without a lock handle answers 404;
 *   - `/deletion/*` is unusable on some BASIS releases.
 *
 * The truthful reading is encoded once here instead of at every call site.
 * Evidence for the activation behaviour: docs/evidence/activation.md.
 */

import { AdtError } from "./errors.js";
import { type AdtSession } from "./session.js";

export const ACCEPT_LOCK =
  "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, " +
  "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9";

const ACCEPT_SOURCE = "text/plain";
const CT_SOURCE = "text/plain; charset=utf-8";
const CT_ACTIVATION = "application/vnd.sap.adt.activation+xml";
const CT_CHECK_OBJECTS = "application/vnd.sap.adt.checkobjects+xml";
const ACCEPT_CHECK_MESSAGES = "application/vnd.sap.adt.checkmessages+xml";

export interface LockInfo {
  readonly lockHandle: string;
  /** Transport SAP already decided for this change, when it did. */
  readonly corrNr: string | null;
  readonly isLocal: boolean;
}

export interface ActivationEntry {
  /** Absolute ADT URI, e.g. `/sap/bc/adt/programs/programs/zfoo`. */
  readonly uri: string;
  readonly name: string;
  /** `adtcore:type`, e.g. `PROG/P`. Omitted when unknown. */
  readonly adtType?: string;
}

export interface ActivationReport {
  /** True only when the activation reported no errors. Says nothing about content. */
  readonly ok: boolean;
  readonly status: string;
  readonly errors: number;
  readonly warnings: number;
  readonly raw: string;
}

export interface SourceComparison {
  readonly equal: boolean;
  readonly detail?: string;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textOfTag(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(body);
  return match?.[1]?.trim();
}

/**
 * Lock handle bookkeeping lives in the session, at the transport level.
 *
 * That is where it has to be: locks are taken by more than this one helper — the
 * `Lock*` tools send the same LOCK as a plain request, and a DELETE carries a handle
 * too. A journal that only saw this file would leave every other lock unreleasable,
 * which is what "SM12 shows a lock nobody can drop" looks like from the outside.
 * `AdtSession` records the handle for any request that takes one, or gives one back —
 * including the stale-lock self-heal before a new LOCK.
 */

/**
 * POST `?_action=LOCK&accessMode=MODIFY`.
 *
 * The response also carries `CORRNR` — the request SAP will record the change
 * in. Reading it here is what lets a write succeed without the caller knowing
 * the request number, which a transportable package otherwise rejects.
 *
 * Stale-lock release and journalling are the session's job (see above), so a LOCK
 * sent by any tool behaves the same as this one.
 */
export async function lockObject(session: AdtSession, relUri: string): Promise<LockInfo> {
  const response = await session.request({
    method: "POST",
    path: `${relUri}?_action=LOCK&accessMode=MODIFY`,
    accept: ACCEPT_LOCK,
  });

  const lockHandle = textOfTag(response.body, "LOCK_HANDLE");
  if (lockHandle === undefined || lockHandle.length === 0) {
    throw new AdtError({
      code: "locked",
      message: `SAP answered the lock for ${relUri} without a lock handle.`,
      nextAction:
        "Another session holds the lock. Drop it in SM12, or wait for that session to end; retrying in a loop cannot clear it.",
      status: response.status,
      method: "POST",
      path: relUri,
    });
  }

  return {
    lockHandle,
    corrNr: textOfTag(response.body, "CORRNR") ?? null,
    isLocal: (textOfTag(response.body, "IS_LOCAL") ?? "").toUpperCase() === "X",
  };
}

/**
 * Releases a lock. Never throws — the caller decides what a failed release means.
 *
 * The journal entry is dropped by the session when SAP accepted the unlock; a 200 for
 * a handle SAP does not know is still a 200, so that is the best signal available.
 * The error text comes back instead of being swallowed: a lock that could not be
 * released is the one thing a caller must not learn by accident, later.
 */
export async function unlockObject(
  session: AdtSession,
  relUri: string,
  lockHandle: string,
): Promise<UnlockResult> {
  try {
    await session.request({
      method: "POST",
      path: `${relUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
      accept: ACCEPT_LOCK,
      retryOnSessionLoss: false,
    });
    return { released: true };
  } catch (error) {
    return { released: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface UnlockResult {
  readonly released: boolean;
  /** Why it failed — SAP's own words, so the caller can act on them. */
  readonly error?: string;
}

/** PUT content. ADT has no partial write. */
export async function writeSource(
  session: AdtSession,
  target: string,
  source: string,
  options: {
    readonly lockHandle: string;
    readonly corrNr?: string | null;
    /** Override the acceptance type; DDIC objects answer their own media type. */
    readonly accept?: string;
    /** Override the payload type; text sources use text/plain, DDIC uses XML. */
    readonly contentType?: string;
  },
): Promise<void> {
  const query = [`lockHandle=${encodeURIComponent(options.lockHandle)}`];
  if (options.corrNr !== undefined && options.corrNr !== null && options.corrNr.length > 0) {
    query.push(`corrNr=${encodeURIComponent(options.corrNr)}`);
  }
  await session.request({
    method: "PUT",
    path: `${target}?${query.join("&")}`,
    accept: options.accept ?? ACCEPT_SOURCE,
    contentType: options.contentType ?? CT_SOURCE,
    body: source,
    timeoutMs: 120_000,
  });
}

/**
 * `POST /activation?method=activate`.
 *
 * On this platform generation a successful activation answers **200 with an
 * empty body**: that is not a failure. What makes it work is that our own lock
 * is released first — activating a locked object answers 403 "currently
 * editing" and never reaches the activation logic.
 */
export async function activate(
  session: AdtSession,
  entries: readonly ActivationEntry[],
): Promise<ActivationReport> {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    entries
      .map((entry) => {
        const type = entry.adtType === undefined ? "" : ` adtcore:type="${escapeXml(entry.adtType)}"`;
        return `<adtcore:objectReference adtcore:uri="${escapeXml(entry.uri)}"${type} adtcore:name="${escapeXml(entry.name)}"/>`;
      })
      .join("") +
    "</adtcore:objectReferences>";

  const response = await session.requestAcceptingAny({
    method: "POST",
    path: "/activation?method=activate&preauditRequested=false",
    accept: "application/xml",
    contentType: CT_ACTIVATION,
    body,
    timeoutMs: 180_000,
  });

  const empty = response.body.trim().length === 0;
  // Two shapes, and only the first one was understood before: `<msg severity="error">`
  // and the checklist form `<msg type="E" ...>`. Measured 2026-11-04 on a domain:
  // the activation answered **200** carrying `type="E"` ("One of the objects is locked
  // in another activation"), was read as "activated", and the object silently kept its
  // old definition.
  const messages = [...response.body.matchAll(/<msg\b([^>]*)>([\s\S]*?)<\/msg>/gi)].map((match) => {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const severity = (/severity="([^"]*)"/i.exec(attrs)?.[1] ?? /type="([^"]*)"/i.exec(attrs)?.[1] ?? "").toLowerCase();
    const text = /<txt>([\s\S]*?)<\/txt>/i.exec(body)?.[1] ?? "";
    return { severity, text: text.replace(/<[^>]+>/g, "").trim() };
  });
  const isError = (severity: string): boolean => severity === "error" || severity === "e" || severity === "a";
  const errors = messages.filter((message) => isError(message.severity)).length;
  const warnings = messages.filter((message) => message.severity === "warning" || message.severity === "w").length;

  return {
    ok: errors === 0,
    status:
      errors > 0
        ? `activation reported ${errors} error(s): ${messages.find((message) => isError(message.severity))?.text ?? ""}`.trim()
        : empty
          ? "activated (empty response)"
          : "activated",
    errors,
    warnings,
    raw: response.body.length > 4000 ? `${response.body.slice(0, 4000)}…` : response.body,
  };
}

export async function readSource(
  session: AdtSession,
  sourcePath: string,
  version: "active" | "inactive" = "active",
): Promise<string> {
  return session.text({ path: `${sourcePath}?version=${version}`, accept: ACCEPT_SOURCE });
}

/**
 * Normalises line endings and trailing whitespace.
 *
 * The platform rewrites both on save, so a byte comparison would report a
 * difference for every successful write.
 */
export function normalizeSource(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Drops blank lines entirely.
 *
 * Needed for objects SAP stores in sections and re-joins on read: a function
 * module's signature and implementation come back separated by blank lines the
 * caller never wrote, so a line-for-line comparison fails on every successful
 * write. Every non-blank line still has to match, in order.
 */
export function normalizeLooseSource(text: string): string {
  return normalizeSource(text)
    .split("\n")
    .filter((line) => line.length > 0)
    .join("\n");
}

export function compareSource(written: string, active: string, options?: { loose?: boolean }): SourceComparison {
  const normalise = options?.loose === true ? normalizeLooseSource : normalizeSource;
  const left = normalise(written);
  const right = normalise(active);
  if (left === right) return { equal: true };

  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < max; index += 1) {
    if (leftLines[index] === rightLines[index]) continue;
    return {
      equal: false,
      detail: `first difference at line ${index + 1}: wrote ${JSON.stringify(leftLines[index] ?? "(missing)")}, active has ${JSON.stringify(rightLines[index] ?? "(missing)")}`,
    };
  }
  return { equal: false, detail: "contents differ" };
}

export interface VerifiedActivation {
  readonly report: ActivationReport;
  readonly comparison: SourceComparison;
  /** The only value that answers "did my source go live". */
  readonly activated: boolean;
}

/**
 * Activate, then read the active version back and compare it with what was
 * written. The status code cannot answer this question — see the file header.
 */
export async function activateAndVerify(
  session: AdtSession,
  entry: ActivationEntry & { readonly sourcePath: string; readonly source: string; readonly loose?: boolean },
): Promise<VerifiedActivation> {
  const report = await activate(session, [entry]);
  const active = await readSource(session, entry.sourcePath, "active");
  const comparison = compareSource(entry.source, active, entry.loose === undefined ? undefined : { loose: entry.loose });
  // `report.ok` has to count: a CDS view whose draft text was stored verbatim has an
  // "equal" active source even when the activation **failed** to generate it — measured
  // 2026-11-04, `ActivateCdsViewLow` answered `activated: true` while the report said
  // "The column landx is unknown" and nothing had been generated.
  return { report, comparison, activated: report.ok && comparison.equal };
}

export interface CheckMessage {
  readonly severity: string;
  readonly text: string;
  readonly uri?: string;
  readonly line?: number;
}

export interface CheckResult {
  readonly errors: number;
  readonly warnings: number;
  readonly messages: readonly CheckMessage[];
  /** Set when the endpoint said there was nothing to check, which is not a failure. */
  readonly unavailable?: string;
  readonly raw: string;
}

/**
 * Pulls the message list out of a `checkmessages` document.
 *
 * Returning only counts was not enough: "Can't save due to errors in source"
 * comes from a different endpoint and says nothing about *what* is wrong, so the
 * check has to hand the texts back.
 */
function parseCheckMessages(body: string): CheckMessage[] {
  const messages: CheckMessage[] = [];

  // Two shapes, and only one of them was understood before. Measured 2026-11-04 on a
  // CDS view: SAP answered `<chkrun:checkMessage chkrun:type="E"
  // chkrun:shortText="The column landx is unknown" …/>` — a *different* element name
  // (`checkMessage`, not `message`) carrying the text as an **attribute**, and
  // self-closing. The old parser demanded `<chkrun:message>` with an inner
  // `<chkrun:shortText>`, so it found nothing and every check reported
  // `errors: 0` — a source SAP refuses to activate was reported as clean.
  const attributeForm = /<chkrun:checkMessage\b([^>]*?)(?:\/>|>([\s\S]*?)<\/chkrun:checkMessage>)/g;
  for (const match of body.matchAll(attributeForm)) {
    const attributes = match[1] ?? "";
    const inner = match[2] ?? "";
    const severity = /chkrun:type="([^"]*)"/.exec(attributes)?.[1] ?? "unknown";
    const uri = /chkrun:uri="([^"]*)"/.exec(attributes)?.[1];
    const attributeText = /chkrun:shortText="([^"]*)"/.exec(attributes)?.[1];
    const line = /chkrun:line="(\d+)"/.exec(attributes)?.[1] ?? /#start=(\d+),/.exec(uri ?? "")?.[1];
    const innerText = /<chkrun:shortText[^>]*>([\s\S]*?)<\/chkrun:shortText>/.exec(inner)?.[1]?.trim();
    const plain = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const text = (attributeText ?? innerText ?? plain).trim();
    if (text.length === 0) continue;
    messages.push({
      severity,
      text,
      ...(uri === undefined ? {} : { uri }),
      ...(line === undefined ? {} : { line: Number(line) }),
    });
  }

  for (const match of body.matchAll(/<chkrun:message\b([^>]*)>([\s\S]*?)<\/chkrun:message>/g)) {
    const attributes = match[1] ?? "";
    const inner = match[2] ?? "";
    const severity = /chkrun:type="([^"]*)"/.exec(attributes)?.[1] ?? "unknown";
    const uri = /chkrun:uri="([^"]*)"/.exec(attributes)?.[1];
    const line = /chkrun:line="(\d+)"/.exec(attributes)?.[1];
    const shortText = /<chkrun:shortText[^>]*>([\s\S]*?)<\/chkrun:shortText>/.exec(inner)?.[1]?.trim();
    const plain = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const text = shortText ?? plain;
    if (text.length === 0) continue;
    messages.push({
      severity,
      text,
      ...(uri === undefined ? {} : { uri }),
      ...(line === undefined ? {} : { line: Number(line) }),
    });
  }

  return messages;
}

/**
 * `POST /checkruns`.
 *
 * `No URI-Mapping defined for URI` is a 500 that means "there is no such version
 * to check"; it is reported as `unavailable` rather than thrown.
 *
 * A stale session makes the check read an outdated object attribute: an object that was
 * just written and activated comes back with a string of `fixed point arithmetic` errors
 * plus `Field "X" is unknown` for every inline `@DATA(...)` it declares — a cascade off one
 * false root cause. The same request in a fresh session answers with zero errors. Measured
 * repeatedly on a live system, which is why this retries once after a reset instead of
 * handing the caller nine errors that are not there.
 */
export async function runCheck(
  session: AdtSession,
  uri: string,
  version: "active" | "inactive" = "active",
  retried = false,
): Promise<CheckResult> {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<chkrun:checkObject adtcore:uri="${escapeXml(uri)}" chkrun:version="${version}"/>` +
    "</chkrun:checkObjectList>";

  let response;
  try {
    response = await session.request({
      method: "POST",
      path: "/checkruns?reporters=abapCheckRun",
      accept: ACCEPT_CHECK_MESSAGES,
      contentType: CT_CHECK_OBJECTS,
      body,
      timeoutMs: 120_000,
    });
  } catch (error) {
    const text = error instanceof AdtError ? (error.sapText ?? error.message) : "";
    if (error instanceof AdtError && error.code === "not-found") {
      return { errors: 0, warnings: 0, messages: [], unavailable: `no ${version} version to check`, raw: "" };
    }
    if (/already checked|is not checked/i.test(text)) {
      return { errors: 0, warnings: 0, messages: [], unavailable: text.slice(0, 200), raw: "" };
    }
    throw error;
  }

  const messages = parseCheckMessages(response.body);
  if (!retried && looksLikeStaleSession(messages)) {
    session.reset();
    return runCheck(session, uri, version, true);
  }
  const severities = messages.map((message) => message.severity.toLowerCase());
  return {
    errors: severities.filter((value) => value === "e" || value === "error").length,
    warnings: severities.filter((value) => value === "w" || value === "warning").length,
    messages,
    raw: response.body.length > 4000 ? `${response.body.slice(0, 4000)}…` : response.body,
  };
}

/**
 * The signature of the stale-session answer, not of real errors.
 *
 * Two shapes: the `fixed point arithmetic` text (language of the system under test is
 * not guaranteed, so it is a hint rather than the only rule), or several messages with
 * identical text — a whole class of statements misjudged in one go.
 */
function looksLikeStaleSession(messages: readonly CheckMessage[]): boolean {
  const errors = messages.filter((message) => /^[ea]$/i.test(message.severity));
  if (errors.some((message) => /fixed point arithmetic/i.test(message.text))) return true;
  const texts = errors.map((message) => message.text);
  return new Set(texts).size < texts.length;
}

export interface DeletionResult {
  readonly deleted: boolean;
  readonly status: number;
  readonly detail?: string;
  /** False when the object is gone but its lock could not be released. */
  readonly lock_released?: boolean;
  /** SAP's own words when the release failed — the caller must see this, not guess. */
  readonly lock_error?: string;
}

/**
 * Delete through the object URI with a lock handle.
 *
 * `/deletion/check` and `/deletion/delete` are unusable on BASIS 754 (`500 No
 * implementation was selected for the current BAdI`), and a bare DELETE answers
 * 404 — both measured. This is the path that works.
 *
 * Measured on the reference system (2026-11-04): the DELETE removes the object but **not** the
 * name-level enqueue. `GetProgram` then answers `404 The object is locked: user X is
 * currently editing it` and the name can never be created again — for as long as the
 * session lives, which for a gateway is forever. So the lock is released explicitly
 * after a successful delete too, and the outcome is reported instead of assumed.
 */
export async function deleteObject(
  session: AdtSession,
  relUri: string,
  transport?: string,
): Promise<DeletionResult> {
  // A delete outside `$TMP` needs `corrNr` — measured 2026-11-04: `DeleteMetadataExtension`
  // answered HTTP 400 "Parameter corrNr could not be found" although the caller had
  // passed `transport_request`, because this function never forwarded it.
  const lock = await lockObject(session, relUri);
  let deleted = false;
  let status = 0;
  let detail: string | undefined;
  try {
    const corrNr = lock.corrNr ?? transport;
    const query = [`lockHandle=${encodeURIComponent(lock.lockHandle)}`];
    if (corrNr !== undefined && corrNr.length > 0) query.push(`corrNr=${encodeURIComponent(corrNr)}`);
    const response = await session.request({
      method: "DELETE",
      path: `${relUri}?${query.join("&")}`,
    });
    deleted = true;
    status = response.status;
  } catch (error) {
    if (!(error instanceof AdtError)) throw error;
    status = error.status ?? 0;
    detail = error.message;
  }

  // Always release: a failed delete kept the lock because nothing was deleted, a
  // successful one because SAP does not dequeue the name for us.
  const unlock = await unlockObject(session, relUri, lock.lockHandle);
  return {
    deleted,
    status,
    ...(detail === undefined ? {} : { detail }),
    lock_released: unlock.released,
    ...(unlock.error === undefined ? {} : { lock_error: unlock.error }),
  };
}
