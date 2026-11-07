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
import { ADT_BASE, type AdtSession } from "./session.js";
import { hasSignal } from "./signals.js";
import {
  attributeOf,
  escapeXmlText,
  findElements,
  messageTextOf,
  parseXml,
  plainText,
  rootElement,
  rootNameOf,
} from "./xml.js";

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
  /**
   * Set when the answer was neither empty nor a message list this gateway can read.
   * `ok` is false in that case: an unreadable answer is not a successful activation.
   */
  readonly unrecognized?: string;
}

export interface SourceComparison {
  readonly equal: boolean;
  readonly detail?: string;
}

/** Escapes text for an XML attribute. Kept as a local export for existing callers. */
export function escapeXml(value: string): string {
  return escapeXmlText(value).replace(/'/g, "&apos;");
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
  // Read the report structurally. Two shapes used to be two regex branches — `<msg
  // severity="error">` and the checklist form `<msg type="E" …>` — and only the first one
  // was understood: measured on a domain, the activation answered **200**
  // carrying `type="E"` ("One of the objects is locked in another activation"), was read
  // as "activated", and the object silently kept its old definition.
  const parsed = empty ? undefined : parseXml(response.body);
  const messages = (parsed === undefined ? [] : findElements(parsed, "msg")).map((msg) => {
    const severity = (attributeOf(msg, "severity") ?? attributeOf(msg, "type") ?? "").toLowerCase();
    // Entities are decoded by the parser, so an escape SAP sent once reaches the caller as
    // the character it stands for (`LO_WORKSHEET->SET_CELL(`, not `…-&gt;SET_CELL(`).
    return { severity, text: messageTextOf(msg) };
  });
  const isError = (severity: string): boolean => severity === "error" || severity === "e" || severity === "a";
  const errors = messages.filter((message) => isError(message.severity)).length;
  const warnings = messages.filter((message) => message.severity === "warning" || message.severity === "w").length;

  // A non-empty answer we cannot read is **not** success. Before this, any shape other
  // than `<msg>` (an HTML error page, a newer report element) counted as zero errors and
  // the caller read "activated" while the object kept its old version — the exact failure
  // mode this file already fixed twice by adding one more shape branch.
  //
  // `<chkl:messages>` carrying only `<chkl:properties>` is the platform's own "nothing to
  // report" answer — captured live:
  //   <chkl:messages><chkl:properties checkExecuted="false" activationExecuted="false"
  //     generationExecuted="true"/></chkl:messages>
  // Its attributes do **not** prove activation (the incident of an earlier round shows
  // `generationExecuted=true` on an object that stayed inactive); the read-back in
  // `activateAndVerify` is what answers that question.
  const rootName = parsed === undefined ? undefined : rootNameOf(parsed);
  const emptyReport = rootName === "messages";
  const unrecognized =
    empty || messages.length > 0 || emptyReport
      ? undefined
      : `the activation answered a document this gateway cannot read (${response.body.length} bytes, root <${rootElement(response.body) ?? "?"}>): ${plainText(response.body).slice(0, 200)}`;

  return {
    ok: errors === 0 && unrecognized === undefined,
    status:
      unrecognized ??
      (errors > 0
        ? `activation reported ${errors} error(s): ${firstUsefulError(messages)}`.trim()
        : empty
          ? "activated (empty response)"
          : "activated"),
    errors,
    warnings,
    ...(unrecognized === undefined ? {} : { unrecognized }),
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
 * Fails with `not-found` when the object behind a source path is gone.
 *
 * Reading `source/main` of an object that has been deleted makes SAP's workbench resource raise
 * CX_OO_CLIF_NOT_EXISTS uncaught, and the target system writes a short dump for it — measured
 *: every probe run that read a deleted object twice left two dumps behind.
 * A name that never existed does not dump; a deleted one does. The object document answers a
 * clean 404, so a read asks for it first and only then for the source.
 *
 * Only an explicit 404 counts as "gone": a 406 (the resource speaks another media type) or a 403
 * must not turn a readable object into a not-found.
 */
export async function assertObjectExists(session: AdtSession, sourcePath: string): Promise<void> {
  const objectPath = sourcePath.replace(/\/source\/main$/, "");
  if (objectPath === sourcePath) return;
  const missing = await session
    .requestAcceptingAny({ path: objectPath, accept: "*/*" })
    .then(() => false)
    .catch((error: unknown) => error instanceof AdtError && error.code === "not-found");
  if (!missing) return;
  throw new AdtError({
    code: "not-found",
    message: `No such object: ${objectPath}`,
    nextAction:
      "Check the name with SearchObject. A deleted object answers 404, and reading its source would leave a dump in the target system.",
    status: 404,
    method: "GET",
    path: objectPath,
  });
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
 * Collapses whitespace outside quoted text, and ignores case there too.
 *
 * A DDL source is re-formatted on save: SAP lines the colons up (`key id     : abap.int4`
 * where the caller wrote `key id : abap.int4`) and lower-cases the object name. Measured on
 * Measured: the write and the activation both succeeded, the stored text was
 * equivalent, and the tool still answered `activated: false` with a mismatch on line 8 —
 * the kind of false alarm that makes a caller rewrite working code.
 *
 * Outside a literal, ABAP and DDL are case-insensitive, so folding case there cannot hide a
 * real difference; inside a literal (which is compared verbatim) it could, hence the scan.
 */
function collapseOutsideLiterals(text: string): string {
  let out = "";
  let quoted = false;
  let pendingSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "'") {
      // `''` inside a literal is an escaped quote, not the end of it.
      if (quoted && text[index + 1] === "'") {
        out += "''";
        index += 1;
        continue;
      }
      quoted = !quoted;
      out += char;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += quoted ? char : char.toUpperCase();
  }
  return out;
}

/**
 * Drops blank lines and the formatting SAP imposes on the text it stores.
 *
 * Needed for objects SAP stores in sections and re-joins on read: a function module's
 * signature and implementation come back separated by blank lines the caller never wrote, so
 * a line-for-line comparison fails on every successful write. Every non-blank line still has
 * to match, in order, after the whitespace and case outside literals is folded away.
 */
export function normalizeLooseSource(text: string): string {
  return normalizeSource(text)
    .split("\n")
    .map((line) => collapseOutsideLiterals(line).trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function compareSource(
  written: string,
  active: string,
  options?: { loose?: boolean; tokens?: boolean },
): SourceComparison {
  // `tokens` ignores line boundaries as well as case and whitespace: SAP re-lays-out some sources
  // (a function module's signature is stored in its own section and comes back split onto separate
  // lines), and *how* it does that depends on the system's editor/pretty-printer setup, so a
  // line-based comparison cannot be right in general. Comparing the token stream still catches a
  // real difference — a missing statement or a changed literal.
  if (options?.tokens === true) {
    const left = collapseOutsideLiterals(normalizeSource(written));
    const right = collapseOutsideLiterals(normalizeSource(active));
    if (left === right) return { equal: true };
    const at = [...left].findIndex((char, index) => char !== [...right][index]);
    return {
      equal: false,
      detail: `token streams differ at character ${at < 0 ? Math.min(left.length, right.length) : at}: wrote ${JSON.stringify(left.slice(Math.max(0, at - 20), at + 40))}, active has ${JSON.stringify(right.slice(Math.max(0, at - 20), at + 40))}`,
    };
  }
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
  entry: ActivationEntry & {
    readonly sourcePath: string;
    readonly source: string;
    readonly loose?: boolean;
    readonly tokens?: boolean;
  },
): Promise<VerifiedActivation> {
  const report = await activate(session, [entry]);
  const active = await readSource(session, entry.sourcePath, "active");
  const comparison = compareSource(entry.source, active, {
    ...(entry.loose === undefined ? {} : { loose: entry.loose }),
    ...(entry.tokens === undefined ? {} : { tokens: entry.tokens }),
  });
  // `report.ok` has to count: a CDS view whose draft text was stored verbatim has an
  // "equal" active source even when the activation **failed** to generate it — measured
  //, `ActivateCdsViewLow` answered `activated: true` while the report said
  // "The column landx is unknown" and nothing had been generated.
  return { report, comparison, activated: report.ok && comparison.equal };
}

/**
 * The error text worth showing.
 *
 * SAP writes its own summary first — `Activation was cancelled.` on this release — and the reason
 * it was cancelled after it. Reporting the summary made every failed activation look alike, so the
 * check had to be run by hand to learn anything.
 */
function firstUsefulError(entries: readonly { severity: string; text: string }[]): string {
  const errors = entries.filter(
    (entry) => (entry.severity === "e" || entry.severity === "error") && entry.text.trim().length > 0,
  );
  const useful = errors.find((entry) => !/cancelled|abgebrochen|已取消/i.test(entry.text)) ?? errors[0];
  return useful?.text.trim() ?? "";
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
  /** The version whose messages are returned (after the inactive→active fallback). */
  readonly version?: "active" | "inactive";
  readonly raw: string;
}

/**
 * The parsed message list, and whether the document was a check document at all.
 *
 * `recognized: false` is the case that used to read as `errors: 0`: a body this parser
 * did not understand looked exactly like a clean check. Callers must not turn that into
 * "checked and clean" — see `runCheck`.
 */
interface ParsedCheckMessages {
  readonly messages: readonly CheckMessage[];
  readonly recognized: boolean;
}

/**
 * Reads a `checkruns` answer structurally.
 *
 * SAP has shipped this answer in two shapes — `<chkrun:checkMessage …/>` with the text as
 * an **attribute**, and `<chkrun:message>` with an inner `<chkrun:shortText>` — and the
 * second one was once unknown: measured on a CDS view, every check reported
 * `errors: 0` for a source SAP refuses to activate. Each new shape then cost one more
 * regex branch. A parser plus a root-name check has no such gap: either the document is
 * a check report (then every message element is found, whatever its prefix or nesting),
 * or it is not, and the caller is told rather than handed a zero.
 */
function parseCheckMessages(body: string): ParsedCheckMessages {
  if (body.trim().length === 0) return { messages: [], recognized: true };
  const parsed = parseXml(body);
  if (parsed === undefined) return { messages: [], recognized: false };

  const root = rootNameOf(parsed) ?? "";
  // Three wrappers exist in the wild: `<chkrun:checkMessages>` (the plain reporter),
  // `<chkrun:checkObjectList>` and `<chkrun:checkRunReports>` (the CDS reporter, captured
  // ). A document that carries a `checkReport` element is a check answer too,
  // whatever it is wrapped in — that is the whole point of reading it structurally.
  const recognized =
    root === "checkMessages" || root === "checkObjectList" || root === "checkRunReports" || findElements(parsed, "checkReport").length > 0;

  // `checkMessage` is the checklist form, `message` the older one; take whichever the
  // document carries instead of concatenating both and counting duplicates.
  const checklist = findElements(parsed, "checkMessage");
  const nodes = checklist.length > 0 ? checklist : findElements(parsed, "message");

  const messages: CheckMessage[] = [];
  for (const node of nodes) {
    const severity = attributeOf(node, "type") ?? "unknown";
    const uri = attributeOf(node, "uri");
    const line = attributeOf(node, "line") ?? /#start=(\d+),/.exec(uri ?? "")?.[1];
    const text = messageTextOf(node);
    if (text.length === 0) continue;
    messages.push({
      severity,
      text,
      ...(uri === undefined ? {} : { uri }),
      ...(line === undefined ? {} : { line: Number(line) }),
    });
  }

  return { messages, recognized };
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
  activeFallbackTried = false,
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
      return {
        errors: 0,
        warnings: 0,
        messages: [],
        unavailable: `no ${version} version to check`,
        version,
        raw: "",
      };
    }
    if (hasSignal(text, "already-checked")) {
      return {
        errors: 0,
        warnings: 0,
        messages: [],
        unavailable: text.slice(0, 200),
        version,
        raw: "",
      };
    }
    throw error;
  }

  const parsed = parseCheckMessages(response.body);
  const messages = parsed.messages;
  // Fail closed. An unrecognised check document is not a clean object: before this,
  // every shape the parser did not know produced `errors: 0`, and a source SAP refuses
  // to activate was handed back as "checked, no errors" (measured on a CDS
  // view). Throw so the caller sees the raw text instead of a green check.
  if (!parsed.recognized) {
    throw new AdtError({
      code: "unrecognized-response",
      message: `The check answered a document this gateway cannot read (${response.body.length} bytes, no chkrun element). Reporting 0 errors here would claim a check that never happened.`,
      nextAction:
        "Read sapText (the raw answer), then add this shape to parseCheckMessages with a fixture. Do not treat the object as checked.",
      status: response.status,
      method: "POST",
      path: "/checkruns?reporters=abapCheckRun",
      sapText: plainText(response.body).slice(0, 400),
    });
  }
  if (!retried && looksLikeStaleSession(messages)) {
    session.reset();
    return runCheck(session, uri, version, true);
  }

  // A program that was just activated has no inactive version; `/checkruns` on the
  // inactive version then answers "The REPORT/PROGRAM statement is missing" — about an
  // empty version, not about the code. The same message also comes back for a program
  // whose inactive source demonstrably has a REPORT statement: the source reads back
  // with `REPORT ...`, while the check still claims it is missing. In both cases the
  // safe reading is: reset once, then check the active version, which is what the
  // deliverable actually is.
  const missingReport = messages.some(
    (message) => /^[ea]$/i.test(message.severity) && hasSignal(message.text, "report-statement-missing"),
  );
  const hasReportStatement = (source: string): boolean => /\b(REPORT|PROGRAM)\s+[\w/]/i.test(source);
  const sourcePath = `${uri.startsWith(ADT_BASE) ? uri.slice(ADT_BASE.length) : uri}/source/main`;

  if (version === "inactive" && !activeFallbackTried && missingReport) {
    const inactive = await readSource(session, sourcePath, "inactive").catch(() => "");
    const inactiveHasReport = hasReportStatement(inactive);
    if (inactiveHasReport) {
      // The check contradicts source we just read: a stale session, or the endpoint is
      // looking at the wrong version. Reset and retry once before changing versions.
      if (!retried) {
        session.reset();
        return runCheck(session, uri, "inactive", true, activeFallbackTried);
      }
      return runCheck(session, uri, "active", retried, true);
    }
    if (inactive.trim().length === 0) {
      const active = await readSource(session, sourcePath, "active").catch(() => "");
      if (hasReportStatement(active)) {
        return runCheck(session, uri, "active", retried, true);
      }
    }
  }

  const severities = messages.map((message) => message.severity.toLowerCase());
  const warnings = severities.filter((value) => value === "w" || value === "warning").length;

  // Last resort: the active source has a REPORT statement and the check still says it
  // is missing. That is a false negative from the check endpoint, not a compile error;
  // report it as `unavailable` (callers must not turn it green as "checked").
  if (version === "active" && missingReport) {
    const active = await readSource(session, sourcePath, "active").catch(() => "");
    if (hasReportStatement(active)) {
      return {
        errors: 0,
        warnings,
        messages: [],
        unavailable:
          "the check endpoint reported REPORT/PROGRAM missing although the active source has one; it cannot judge this object",
        version,
        raw: response.body.length > 4000 ? `${response.body.slice(0, 4000)}…` : response.body,
      };
    }
  }

  return {
    errors: severities.filter((value) => value === "e" || value === "error").length,
    warnings,
    messages,
    version,
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
  if (errors.some((message) => hasSignal(message.text, "fixed-point-arithmetic"))) return true;
  const texts = errors.map((message) => message.text);
  return new Set(texts).size < texts.length;
}

export interface DeletionResult {
  readonly deleted: boolean;
  readonly status: number;
  readonly detail?: string;
  /**
   * True when SAP says the object is not there at all.
   *
 * Measured: `DeleteInclude` on an include whose main program had already been
   * deleted answered `not-found: Object directory entry was not found` **at the lock step** — the
   * caller's goal (the object is gone) was already reached, so that is a success with a note, not
   * an error.
   */
  readonly alreadyGone?: boolean;
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
 * Measured on the reference system: the DELETE removes the object but **not** the
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
  // A delete outside `$TMP` needs `corrNr` — measured: `DeleteMetadataExtension`
  // answered HTTP 400 "Parameter corrNr could not be found" although the caller had
  // passed `transport_request`, because this function never forwarded it.
  const lock = await lockObject(session, relUri).catch((error: unknown) => {
    // The object is gone: no TADIR entry, so no lock. The goal of a delete is already reached.
    if (error instanceof AdtError && error.code === "not-found") {
      return undefined;
    }
    throw error;
  });
  if (lock === undefined) {
    return {
      deleted: false,
      status: 404,
      alreadyGone: true,
      detail: "SAP has no object at this URI, so there was nothing to delete",
    };
  }
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

  // Release 754 answers the generic DELETE of a service binding with 412
  // "no authorization to change"; its own deletion resource still accepts the
  // request (the archived client used it). The resource is not usable for every
  // object type on 754, so this is scoped to the service-binding path.
  let lockReleased = false;
  let lockError: string | undefined;
  if (!deleted && status === 412 && relUri.includes("/businessservices/bindings/")) {
    // The deletion resource refuses an object that is still enqueued to us.
    const early = await unlockObject(session, relUri, lock.lockHandle);
    lockReleased = early.released;
    lockError = early.error;
    const bindingUri = relUri.startsWith("/sap/bc/adt") ? relUri : `/sap/bc/adt${relUri}`;
    const deletionBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<del:deletionRequest xmlns:del="http://www.sap.com/adt/deletion" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core">' +
      `<del:object adtcore:uri="${bindingUri}">` +
      `<del:transportNumber>${transport ?? ""}</del:transportNumber>` +
      "</del:object></del:deletionRequest>";
    try {
      const response = await session.request({
        method: "POST",
        path: "/deletion/delete",
        accept: "application/vnd.sap.adt.deletion.response.v1+xml",
        contentType: "application/vnd.sap.adt.deletion.request.v1+xml",
        body: deletionBody,
      });
      deleted = response.status >= 200 && response.status < 300;
      status = response.status;
      if (deleted) {
        // The resource answers 200 for a deletion proposal as well; only a read
        // back proves the object is gone. A false success is worse than a
        // failure the caller can act on.
        const stillThere = await session
          .request({ path: relUri, accept: "*/*" })
          .then(() => true)
          .catch((error: unknown) => !(error instanceof AdtError && error.status === 404));
        if (stillThere) {
          deleted = false;
          status = 412;
          detail = "The deletion request was accepted but the object is still readable.";
        } else {
          detail = undefined;
        }
      }
    } catch (error) {
      if (error instanceof AdtError) {
        status = error.status ?? status;
        detail = error.message;
      } else {
        throw error;
      }
    }
  }

  // Always release: a failed delete kept the lock because nothing was deleted, a
  // successful one because SAP does not dequeue the name for us.
  if (!lockReleased) {
    const unlock = await unlockObject(session, relUri, lock.lockHandle);
    lockReleased = unlock.released;
    lockError = unlock.error;
  }
  return {
    deleted,
    status,
    ...(detail === undefined ? {} : { detail }),
    lock_released: lockReleased,
    ...(lockError === undefined ? {} : { lock_error: lockError }),
  };
}
