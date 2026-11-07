/**
 * Message-text signals.
 *
 * SAP answers in the logon language, and the answer does not even have to follow the
 * configured one: `endpoint.language` is `ZH` on four of the five systems, yet on
 * the same check came back in Chinese on one system and in English on another.
 * A classifier that only knows one wording does not fail loudly: it falls through to the
 * generic branch, the caller gets "upstream" for a lock conflict, and the next call
 * repeats the same mistake. That is how one wrong classification turns into a pile of
 * retries.
 *
 * Two rules keep this table honest:
 *
 *   1. **Structured evidence first.** Branch on the HTTP status, `exc:type` or the
 *      `chkrun:type` attribute whenever it exists. This table is the fallback for the
 *      endpoints whose only discriminator is prose.
 *   2. **Never invent a translation.** A pattern is added only from a captured response
 *      (a fixture or a live call) and the entry says where it was seen. A guessed Chinese
 *      phrase is worse than no phrase: it looks like coverage and never fires.
 *
 * The Chinese literals inside `patterns` are **data**: they are the words SAP sends, and a
 * translated pattern would match nothing. Everything around them — comments, evidence,
 * documentation — stays English, so the repository reads the same for every contributor.
 *
 * Patterns are matched case-insensitively and against `sapText ?? message`, so a single
 * table serves both the request path and the thrown-error path.
 */

export type SignalName =
  /** The check endpoint answered "already checked", i.e. there is nothing to re-run. */
  | "already-checked"
  /** `REPORT/PROGRAM statement is missing` / `program type is INCLUDE` — about the version, not the code. */
  | "report-statement-missing"
  /** The stale-session signature: a cascade of `fixed point arithmetic` messages. */
  | "fixed-point-arithmetic"
  /** Name-level enqueue held by another (or our own) session. */
  | "currently-editing"
  /** A package/object named in an "is locked" refusal. */
  | "already-locked"
  /** The object being created already exists — SAP answers 500, not 409. */
  | "already-exists"
  /** The lock handle is not accepted by this session. */
  | "invalid-lock"
  /** The stateful session is gone; the call has to be replayed. */
  | "session-expired"
  /** `Parameter corrNr could not be found` and friends. */
  | "transport-required"
  /** `No URI-Mapping defined for URI` — a 500 that means "nothing to check". */
  | "no-uri-mapping"
  /** SAP's own 500 text, as opposed to a request problem. */
  | "server-error"
  /** The temporary program pool is exhausted (`TSV_TNEW`). */
  | "temp-pool"
  /** Data Preview accepts exactly one SELECT and rejects joins. */
  | "single-select"
  /** `C(1,0)` field given a two-character value (SPRAS). */
  | "language-key-width"
  /** Generic grammar complaint from the SQL rewriter. */
  | "sql-syntax"
  /** A bridge function module is not active / cannot be called. */
  | "bridge-missing"
  /** SmartForm without a generated function module. */
  | "no-generated-function-module"
  /** A class run with the profiler answered "this class cannot be a console app". */
  | "classrun-not-supported";

interface SignalDefinition {
  readonly patterns: readonly RegExp[];
  /** Where the wording was observed. `en` only = no captured `ZH` response yet. */
  readonly evidence: string;
}

export const SIGNAL_PATTERNS: Readonly<Record<SignalName, SignalDefinition>> = {
  "already-checked": {
    patterns: [/already checked|is not checked/i],
    evidence: "en only (runCheck on an object with no inactive version)",
  },
  "report-statement-missing": {
    patterns: [/REPORT\/PROGRAM statement is missing|program type is INCLUDE|缺少\s*REPORT\/PROGRAM|程序类型是\s*INCLUDE/i],
    evidence: "en + zh: the Chinese wording was captured live (checking a program with an empty inactive version)",
  },
  "fixed-point-arithmetic": {
    patterns: [/fixed point arithmetic/i],
    evidence: "en only (stale-session signature)",
  },
  "currently-editing": {
    patterns: [/currently editing|当前编辑/i],
    evidence: "en + zh: the Chinese wording comes from a live 403 `<message lang=\"ZH\">` (fixture in tests/adt.test.ts)",
  },
  "already-locked": {
    patterns: [/already locked|is locked|已锁定/i],
    evidence: "en + zh: the Chinese wording was already matched in handlers.ts (isAlreadyLocked)",
  },
  "already-exists": {
    patterns: [/already exists|already exist|已存在/i],
    evidence:
      "en + zh: captured live — `CreateProgram ZMCP_T01` twice answered 500 `已存在名为 ZMCP_T01 的程序或 include`",
  },
  "invalid-lock": {
    patterns: [/invalid lock handle|not locked/i],
    evidence: "en only",
  },
  "session-expired": {
    patterns: [/session timed out|session expired|logon/i],
    evidence: "en only",
  },
  "transport-required": {
    patterns: [/corrnr/i, /no transport/i, /transport (request )?(is )?required/i, /could not be found/i],
    evidence: "en only; `could not be found` only counts together with `transport` — see `isTransportRequired`",
  },
  "no-uri-mapping": {
    patterns: [/no uri-mapping/i],
    evidence: "en only (CDS check)",
  },
  "server-error": {
    patterns: [/Application Server Error 500|Internal Server Error|SAP reported a server error/i],
    evidence: "en only",
  },
  "temp-pool": {
    patterns: [/temporary (subroutine )?pool|TSV_TNEW|no more storage|out of memory/i],
    evidence: "en only",
  },
  "single-select": {
    patterns: [/仅允许一个 SELECT 语句|only one SELECT statement/i],
    evidence: "en + zh: the Chinese wording was captured from a live Data Preview rejection ()",
  },
  "language-key-width": {
    patterns: [/不是 C\(1,0\) 的有效值|not a valid value for.*C\(1,0\)/i],
    evidence: "en + zh: SPRAS given 'ZH' on a 1-character field",
  },
  "sql-syntax": {
    patterns: [/syntax error|unexpected|not supported|grammar/i],
    evidence: "en only",
  },
  "bridge-missing": {
    patterns: [/could not be called|subrc=8/i],
    evidence: "en only (RFC dispatcher)",
  },
  "no-generated-function-module": {
    patterns: [/has no generated function module/i],
    evidence: "en only",
  },
  "classrun-not-supported": {
    patterns: [/must implement IF_OO_ADT_CLASSRUN|For console output/i],
    evidence:
      "en only: captured live — `RuntimeRunClassWithProfiling ZCL_MCP_T02` answered a 200 whose body asked for IF_OO_ADT_CLASSRUN and produced no trace",
  },
};

/** True when the text carries the named signal. `undefined` text is never a match. */
export function hasSignal(text: string | undefined, name: SignalName): boolean {
  if (text === undefined || text.length === 0) return false;
  return SIGNAL_PATTERNS[name].patterns.some((pattern) => pattern.test(text));
}

/** The first name whose signal matches, or `undefined`. */
export function findSignal(text: string | undefined, names: readonly SignalName[]): SignalName | undefined {
  return names.find((name) => hasSignal(text, name));
}

/**
 * `transport` plus one of the qualifiers — the compound check the plain table cannot
 * express. Kept here so there is still exactly one place that knows the wording.
 */
export function isTransportRequired(text: string | undefined): boolean {
  if (text === undefined || text.length === 0 || !/transport/i.test(text)) return false;
  return hasSignal(text, "transport-required");
}
