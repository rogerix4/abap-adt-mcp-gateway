/**
 * The 13 verbs, written once.
 *
 * High-level verbs own the whole lifecycle (lock, write, unlock, activate and
 * verify); low-level verbs take a `lock_handle` and change one step. That split
 * is the contract's, not a design choice — 134 of the 335 tools are low-level.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ToolRegistry } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import type { AdtSession } from "../adt/session.js";
import {
  activate,
  activateAndVerify,
  assertObjectExists,
  deleteObject,
  readSource,
  runCheck,
  unlockObject,
  writeSource,
  lockObject,
} from "../adt/lifecycle.js";
import { GatewayError } from "../engine/errors.js";
import { AdtError } from "../adt/errors.js";
import { hasSignal } from "../adt/signals.js";
import { assertCustomerName, assertCustomerParent, FamilyError, type CreateContext, type ObjectFamily } from "./types.js";
import { confirmDocumentProperties } from "./spec/confirm.js";
import { restorePreviousVersion } from "./update/rollback.js";
import { buildUpdatePayload, requestShape } from "./update/payloads.js";
import { sourceFileAnswer } from "../tools/source-output.js";

type Args = Record<string, unknown>;

/**
 * Whole-source writes that are in flight right now, keyed by session and object.
 *
 * Two `Update*` calls on the same object can overlap. SAP serializes the HTTP, so both
 * answer `written: true` while only the one that lands last survives — measured: two
 * parallel `UpdateProgram` calls both reported `activated: true`, and the active version
 * held the *first* one's text. The gateway cannot undo that, but it can stop those two
 * answers from reading like two independent successes.
 */
const WRITES_IN_FLIGHT = new Set<string>();

/** What a caller reads when two writes to one object overlapped. */
const CONCURRENT_WRITE_NOTE =
  "another write to this same object was in flight at the same time. Both answers can say " +
  "`written: true` while only one source survives — read the object back before trusting this one.";

function beginObjectWrite(key: string): boolean {
  const overlapping = WRITES_IN_FLIGHT.has(key);
  WRITES_IN_FLIGHT.add(key);
  return overlapping;
}

function endObjectWrite(key: string): void {
  WRITES_IN_FLIGHT.delete(key);
}

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function bool(args: Args, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * One hunk of a server-side patch: replace every occurrence of `old` with `new`.
 * `expected_count` guards against a baseline that drifted — a mismatch aborts
 * before anything is written, which is the whole point of patching instead of
 * re-uploading the file (: a 90 KB re-upload silently lost 389 lines).
 */
interface PatchHunk {
  readonly old?: unknown;
  readonly new?: unknown;
  readonly expected_count?: unknown;
}

/** Source text for an update: inline `source_code`, or a local file. */
/**
 * Every argument a family can carry its payload in.
 *
 * `family.sourceParam` is only registered for three families, so the check verb cannot rely on it
 * to notice that a payload was handed in at all — and a checkrun that silently ignores the payload
 * answers `errors: 0` for text nobody looked at.
 */
const PAYLOAD_ARGS = [
  "source_code",
  "ddl_code",
  "ddl_source",
  "implementation_code",
  "test_class_source",
  "test_class_code",
  "local_types_code",
  "definitions_code",
  "macros_code",
  "properties",
  "fields",
  "dynpro_data",
  "cua_data",
] as const;

function resolveSource(args: Args, sourceParam: string): string | undefined {
  const inline = str(args, sourceParam);
  const file = str(args, "source_file");
  if (inline !== undefined && file !== undefined) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      `Pass either "${sourceParam}" or "source_file", not both.`,
      { accepted: [sourceParam, "source_file"] },
    );
  }
  if (inline !== undefined) return inline;
  if (file === undefined) return undefined;
  try {
    // Trimmed like the inline argument, so both routes hash the same payload.
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      `Cannot read source_file "${file}": ${error instanceof Error ? error.message : String(error)}`,
      { nextAction: "Pass an absolute path readable by the gateway process, or send source_code inline." },
    );
  }
}

/** Applies patch hunks, insisting on the declared number of matches per hunk. */
function applyPatch(base: string, hunks: readonly PatchHunk[]): { text: string; applied: { match: string; count: number }[] } {
  let text = base;
  const applied: { match: string; count: number }[] = [];
  for (const [index, hunk] of hunks.entries()) {
    const oldText = typeof hunk.old === "string" ? hunk.old : "";
    const newText = typeof hunk.new === "string" ? hunk.new : "";
    if (oldText.length === 0) {
      throw new GatewayError("INVALID_ARGUMENT", `patch[${index}].old must not be empty.`, { family: "patch" });
    }
    const expected = typeof hunk.expected_count === "number" ? hunk.expected_count : 1;
    let count = 0;
    let position = 0;
    for (;;) {
      const at = text.indexOf(oldText, position);
      if (at < 0) break;
      count += 1;
      text = text.slice(0, at) + newText + text.slice(at + oldText.length);
      position = at + newText.length;
    }
    if (count !== expected) {
      throw new GatewayError(
        "CONTENT_MISMATCH",
        `patch[${index}] matched ${count} time(s), expected ${expected}: ${JSON.stringify(oldText.slice(0, 80))}`,
        { nextAction: "Nothing was written. Re-read the active source and rebuild the patch against it." },
      );
    }
    applied.push({ match: oldText.slice(0, 80), count });
  }
  return { text, applied };
}

/** Line-ending and trailing-space insensitive text, for the "already identical" check. */
function normalizeSource(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

/**
 * Verifies the payload against the caller's declared fingerprint before anything is
 * written. A mismatch is a silent-corruption guard, not a nicety: the caller's copy
 * and SAP's copy diverging is exactly how lines go missing.
 */
function assertPayloadMatches(payload: string, args: Args): { line_count: number; sha256: string } {
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  const lineCount = payload.split(/\r?\n/).length;
  const expectedSha = str(args, "expected_sha256");
  if (expectedSha !== undefined && expectedSha.toLowerCase() !== digest) {
    throw new GatewayError(
      "CONTENT_MISMATCH",
      `sha256 mismatch: payload is ${digest}, expected ${expectedSha.toLowerCase()}.`,
      { nextAction: "Nothing was written. Compare the local file with what was sent, then resend.", line_count: lineCount },
    );
  }
  const expectedLines = args["expected_line_count"];
  if (typeof expectedLines === "number" && expectedLines !== lineCount) {
    throw new GatewayError(
      "CONTENT_MISMATCH",
      `line count mismatch: payload has ${lineCount} line(s), expected ${expectedLines}.`,
      { nextAction: "Nothing was written. A missing or extra line means the local copy and the payload diverged.", sha256: digest },
    );
  }
  return { line_count: lineCount, sha256: digest };
}

function requireName(args: Args, family: ObjectFamily, verb: string): string {
  const param = family.nameParamByVerb?.[verb] ?? family.nameParam;
  const name = str(args, param);
  if (name !== undefined) return name;
  // The contract spells the same argument differently on the high and the low tool:
  // `DeleteMetadataExtension` takes `metadata_extension_name`, `DeleteMetadataExtensionLow`
  // takes `name` — measured, the low delete rejected the documented `name`.
  for (const alternative of [family.nameParam, ...Object.values(family.nameParamByVerb ?? {})]) {
    const value = str(args, alternative);
    if (value !== undefined) return value;
  }
  throw new GatewayError("INVALID_ARGUMENT", `Missing "${param}".`, { family: family.id });
}

/** The container an object lives in, for the families that have one. */
function parentOf(args: Args, family: ObjectFamily): string | undefined {
  if (family.parentParam === undefined) return undefined;
  const parent = str(args, family.parentParam);
  if (parent === undefined) {
    // A package's container is only needed to CREATE it; Get / Check / Validate / Lock
    // address it by its own name (measured: `GetPackage Z001` demanded
    // `super_package` and was unusable).
    if (family.parentOptional === true) return undefined;
    throw new GatewayError("INVALID_ARGUMENT", `Missing "${family.parentParam}".`, { family: family.id });
  }
  return parent;
}

function collectionOf(family: ObjectFamily, parent: string | undefined): string {
  return typeof family.collectionPath === "string" ? family.collectionPath : family.collectionPath(parent);
}

function createContext(
  args: Args,
  family: ObjectFamily,
  language: string,
  verb = "Create",
  responsible?: string,
): CreateContext {
  const name = requireName(args, family, verb);
  const parent = family.parentParam === undefined ? undefined : str(args, family.parentParam);
  return {
    name,
    ...(parent === undefined ? {} : { parent }),
    description: str(args, "description") ?? name,
    packageName: str(args, "package_name") ?? "$TMP",
    language,
    ...(responsible === undefined ? {} : { responsible }),
    args: normalizeArgs(args),
  };
}

/**
 * Numbers become strings, once, for every family.
 *
 * The contract declares `length`, `decimals` and friends as `number`, while the XML
 * builders compare `typeof value === "string"`. Passing 10 instead of "10" therefore
 * fell back to the default and stored a 40-character domain — a silent wrong value,
 * not a rejected call.
 */
function normalizeArgs(args: Args): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  }
  return out;
}

function transportSuffix(args: Args): string {
  const transport = str(args, "transport_request");
  return transport === undefined ? "" : `?corrNr=${encodeURIComponent(transport)}`;
}

/**
 * Drops the session for families SAP keeps enqueued to it (packages).
 *
 * Measured: create -> lock -> PUT on a package answers "package X is locked" in
 * the session that created it, with a fresh lock handle in hand, and the identical chain in
 * a new session answers 200. The session is ended after the write so the next call logs
 * on again — one logon is cheap next to a chain that cannot finish.
 */
async function dropSessionIfEnqueuing(runtime: GatewayRuntime, family: ObjectFamily): Promise<void> {
  if (family.dropSessionAfterWrite === true) await runtime.closeAll();
}

/** SAP's "…is locked" refusal — a conflict, not a bad request. */
function isAlreadyLocked(error: unknown): boolean {
  const text = error instanceof AdtError ? `${error.message} ${error.sapText ?? ""}` : String(error ?? "");
  // Wording lives in one table (`adt/signals.ts`), both languages, with its evidence.
  return hasSignal(text, "already-locked");
}

/**
 * Query for a low-level PUT: the lock handle, plus `corrNr` when the object is
 * transportable.
 *
 * Measured: `UpdatePackageLow` on a package in a custom transport layer
 * answered `Parameter corrNr could not be found` although `transport_request` was
 * passed — the low update ignored it while the high-level one forwarded it.
 */
function lowUpdateQuery(lockHandle: string, transport: string | undefined): string {
  const query = [`lockHandle=${encodeURIComponent(lockHandle)}`];
  if (transport !== undefined) query.push(`corrNr=${encodeURIComponent(transport)}`);
  return query.join("&");
}

export interface FamilyHandlersOptions {
  readonly registry: ToolRegistry;
  readonly runtime: GatewayRuntime;
  readonly family: ObjectFamily;
}

/**
 * Registers whatever verbs this family actually has in the contract.
 * A verb the catalog does not contain is skipped, never invented.
 */
export function registerFamily(options: FamilyHandlersOptions): void {
  const { registry, runtime, family } = options;

  const specs: readonly { verb: string; low: boolean }[] = [
    { verb: "Create", low: false },
    { verb: "Create", low: true },
    { verb: "Read", low: false },
    { verb: "Get", low: false },
    { verb: "Update", low: false },
    { verb: "Update", low: true },
    { verb: "Delete", low: false },
    { verb: "Delete", low: true },
    { verb: "Activate", low: true },
    { verb: "Check", low: true },
    { verb: "Validate", low: true },
    { verb: "Lock", low: true },
    { verb: "Unlock", low: true },
  ];

  for (const spec of specs) {
    if (family.skipVerbs?.includes(spec.verb) === true) continue;
    const generated = `${spec.verb}${family.id}${spec.low ? "Low" : ""}`;
    const toolName = family.verbToolName?.[generated] ?? generated;
    if (!registry.has(toolName)) continue;

    registry.register(toolName, async (args, ctx) => {
      // Required arguments are enforced once, in `ToolRegistry.call`, from the contract's
      // own `required` list — a per-family copy here was how `package_name` got checked
      // while `description` (and every other required argument) did not.
      try {
        return await dispatch(spec.verb, spec.low, { args, ctx, runtime, family });
      } catch (error) {
        if (error instanceof FamilyError) {
          throw new GatewayError("INVALID_ARGUMENT", error.message, { nextAction: error.nextAction });
        }
        throw error;
      }
    });
  }
}

interface DispatchContext {
  readonly args: Args;
  readonly ctx: { readonly system?: string | undefined };
  readonly runtime: GatewayRuntime;
  readonly family: ObjectFamily;
}

async function dispatch(
  verb: string,
  low: boolean,
  context: DispatchContext,
): Promise<unknown> {
  const { args, ctx, runtime, family } = context;
  const name = requireName(args, family, verb);
  const parent = parentOf(args, family);
  const objectPath = family.objectPath(name, parent);
  const sessionId = str(args, "session_id");

  switch (verb) {
    case "Create":
      return create(context, low, name);

    case "Read":
    case "Get": {
      const resolved = runtime.resolve(ctx.system, sessionId, false);
      const version = str(args, "version") === "inactive" ? "inactive" : "active";

      // Families without a text source (DDIC data elements, domains) hold their
      // content in the object document itself, so reading them means fetching the
      // XML — asking for text/plain there answers 406.
      if (family.sourcePath === undefined) {
        // The `version` argument used to be ignored here — the request never carried it, so a domain
        // or data element always came back as whatever ADT serves by default and the answer claimed
        // "active" regardless (measured: a $TMP domain with a staged change answered
        // `adtcore:version="inactive"` even when `version: "active"` was asked for).
        const query = version === "inactive" ? "?version=inactive" : "?version=active";
        const document = await resolved.session
          .requestAcceptingAny({ path: `${objectPath}${query}`, accept: family.media.accept })
          .then((response) => response.body);
        // Report the version SAP actually served, not the one we asked for.
        const served = /adtcore:version="([^"]+)"/.exec(document)?.[1];
        return {
          success: true,
          name,
          version: served ?? version,
          ...(served !== undefined && served !== version ? { version_requested: version } : {}),
          content_type: family.media.accept,
          content: document,
        };
      }

      const sourcePath = family.sourcePath(objectPath);
      // A deleted object answers 404 on its document; asking for its source instead makes SAP
      // write a short dump (see `assertObjectExists`). Only the explicit read verbs pay for
      // this extra request — the write paths read an object they have just locked.
      await assertObjectExists(resolved.session, sourcePath);
      const source = await readSource(resolved.session, sourcePath, version);
      // Measured live: `GetProgram {output: "file"}` answered exactly like
      // `GetProgram {}` — the argument was declared and read by nothing, so a caller asking
      // for the source to land in a file got it in its context instead.
      if (str(args, "output") === "file") {
        return {
          success: true,
          name,
          version,
          ...sourceFileAnswer(source, { tool: `${verb}${family.id}`, name, version }),
        };
      }
      return {
        success: true,
        name,
        version,
        line_count: source.split(/\r?\n/).length,
        source_code: source,
      };
    }

    case "Update":
      return update(context, low, name, objectPath);

    case "Delete": {
      const resolved = runtime.resolve(ctx.system, sessionId, true);
      const transport = typeof args["transport_request"] === "string" ? (args["transport_request"] as string) : undefined;
      // A published service binding cannot be deleted directly; the old client
      // unpublished it first. A failure here aborts before the lock/delete pair.
      const beforeDelete =
        family.beforeDelete === undefined
          ? undefined
          : await family.beforeDelete(
              resolved.session,
              createContext(args, family, resolved.language, "Delete", resolved.session.username),
            );
      const result = await deleteObject(resolved.session, objectPath, transport);
      if (result.deleted) await dropSessionIfEnqueuing(runtime, family);
      return {
        // An object SAP no longer has is not a failed delete: the caller's goal is reached.
        success: result.deleted || result.alreadyGone === true,
        name,
        status: result.status,
        ...(result.alreadyGone === true
          ? { deleted: false, already_gone: true, note: "SAP had no object at this URI; nothing to delete." }
          : {}),
        ...(beforeDelete === undefined ? {} : { pre_delete: beforeDelete }),
        ...(result.detail === undefined || result.alreadyGone === true ? {} : { detail: result.detail }),
        ...(result.lock_released === undefined ? {} : { lock_released: result.lock_released }),
        ...(result.lock_error === undefined ? {} : { lock_error: result.lock_error }),
      };
    }

    case "Activate": {
      const resolved = runtime.resolve(ctx.system, sessionId, true);
      const sourcePath = family.sourcePath?.(objectPath) ?? objectPath;
      const readActive = async (): Promise<string> => {
        if (family.sourcePath === undefined) {
          return resolved.session
            .requestAcceptingAny({ path: objectPath, accept: family.media.accept })
            .then((response) => response.body);
        }
        return readSource(resolved.session, sourcePath, "active");
      };

      try {
        // A family without a text source (domains, data elements, tables) carries its
        // content in the object document, which answers XML — reading it as
        // `text/plain` is a 406 and used to look like "activation failed".
        if (family.sourcePath === undefined) {
          const verified = await verifyActivation(family, resolved.session, {
            objectPath,
            name,
            sourcePath: objectPath,
            source: "",
          });
          return {
            success: verified.activated,
            name,
            status: verified.status,
            activated: verified.activated,
            session_id: resolved.sessionId,
            ...(verified.detail === undefined ? {} : verified.detail),
          };
        }

        // Verify against what SAP holds as the draft: that is what activation publishes.
        // A read that fails for a reason other than "there is no draft" must not be read as
        // "there is no draft": the fallback below would then activate the *active* version and
        // answer `activated: true` — reporting the one action the caller did not ask for.
        const draft = await readSource(resolved.session, sourcePath, "inactive").catch((error: unknown) => {
          if (error instanceof AdtError && error.code === "not-found") return undefined;
          throw error;
        });
        const verified = await activateAndVerify(resolved.session, {
          uri: `/sap/bc/adt${objectPath}`,
          name,
          adtType: family.adtType,
          sourcePath,
          source: draft ?? (await readActive()),
        });
        return {
          success: verified.activated,
          name,
          status: verified.report.status,
          activated: verified.activated,
          errors: verified.report.errors,
          warnings: verified.report.warnings,
          session_id: resolved.sessionId,
          ...(verified.comparison.equal ? {} : { mismatch: verified.comparison.detail }),
        };
      } catch (error) {
        // Measured: activating a DDIC object that has no inactive version (nothing
        // was written through this gateway) answers 400 from the object's own
        // deserialiser, e.g. "error deserialising in SBD_DATAELEMENT". The object
        // is already active, so the honest answer is "nothing to activate", backed
        // by reading it back rather than by trusting the error.
        //
        // Only that one class of error may be downgraded. A media-type rejection or a
        // lock/authorisation failure means the activation never ran — reporting it as
        // "already active" is how an unactivated draft passed for success.
        if (family.verification !== "readable") throw error;
        if (error instanceof AdtError && /content-negotiation|locked|forbidden|unauthorized/i.test(error.code ?? "")) {
          throw error;
        }
        const active = await readActive().catch(() => "");
        if (active.trim().length === 0) throw error;
        return {
          success: true,
          name,
          status: "nothing to activate (object already active)",
          activated: true,
          note: error instanceof Error ? error.message : String(error),
          session_id: resolved.sessionId,
        };
      }
    }

    case "Check": {
      // The contract lets a check carry the source it is about to receive (`source_code` on a
      // program, `ddl_code` on a table). ADT's checkrun can only check a *stored* version, so
      // this used to run the check on whatever was stored and answer `errors: 0` for text that
      // was never looked at — measured on a live system: broken DDL, empty source and `SELECT * FROM
      // mara` all came back clean. Refuse the payload instead of answering a clean bill.
      // Only three families register `sourceParam` (table / structure, CDS view, behaviour
      // implementation), so every other family — program, class, interface, include, function
      // module … — slipped past this guard and answered `errors: 0` for text nobody looked at
      // (measured: `CheckClassLow` with `source_code: "CLASS … THIS IS NOT ABAP."`
      // came back clean). Fall back to whichever payload argument the family takes.
      // Measured live: `CheckCdsViewLow {view_name}` — no payload at all — answered
      // `ddl_source is not checked`, because the family's `sourceParam` was read as "a payload was
      // sent". A Check that carries nothing must check the stored version; only a payload the
      // caller actually filled in has to be refused.
      const sent = (key: string): boolean =>
        typeof args[key] === "string" && (args[key] as string).length > 0;
      const payloadKey =
        (family.sourceParam !== undefined && sent(family.sourceParam) ? family.sourceParam : undefined) ??
        PAYLOAD_ARGS.find((key) => sent(key));
      if (payloadKey !== undefined) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          `${payloadKey} is not checked: a checkrun only sees a stored version.`,
          {
            nextAction:
              `Write it first (Lock${family.id}Low → ${payloadKey} → Update${family.id}Low → Unlock${family.id}Low), ` +
              `then Check${family.id}Low — or call Update${family.id}, which checks the payload before it writes.`,
          },
        );
      }
      const resolved = runtime.resolve(ctx.system, sessionId, false);
      // Some families cannot be checked by SAP's ABAP check at all; say so instead of
      // passing on a complaint about SAP's own generated source (see `checkUnavailable`).
      if (family.checkUnavailable !== undefined) {
        return {
          success: true,
          name,
          errors: 0,
          warnings: 0,
          messages: [],
          unavailable: family.checkUnavailable,
          session_id: resolved.sessionId,
        };
      }
      const uri = `/sap/bc/adt${objectPath}`;
      // Measured live: `CheckProgramLow ZMCP_NEVER_EXISTED` answered
      // `errors: 1 — The REPORT/PROGRAM statement is missing, or the program type is INCLUDE`
      // and `checked_version: inactive`, against a `/programs/includes/…` URI this gateway never
      // asked for. SAP invented an include and complained about it, and the caller was left
      // believing their own program had no REPORT statement. An object that does not exist has
      // no version to check: ask for its document first, so a deleted or mistyped name answers
      // `not-found` and nothing is checked at all.
      if (family.sourcePath !== undefined) {
        await assertObjectExists(resolved.session, family.sourcePath(objectPath));
      }
      let result = await runCheck(resolved.session, uri, "inactive");
      if (result.unavailable !== undefined) {
        result = await runCheck(resolved.session, uri, "active");
      }
      return {
        success: result.errors === 0,
        name,
        errors: result.errors,
        warnings: result.warnings,
        messages: result.messages,
        ...(result.version === undefined ? {} : { checked_version: result.version }),
        ...(result.unavailable === undefined ? {} : { unavailable: result.unavailable }),
        session_id: resolved.sessionId,
      };
    }

    case "Validate": {
      // Name rules are ours to enforce; availability is SAP's answer.
      assertCustomerName(name);
      const resolved = runtime.resolve(ctx.system, sessionId, false);
      const objectPathForCheck = family.objectPath(name, parent);
      // Measured live: `ValidateClassLow {class_name: "ZCL_MCP_T01"}` on a class that
      // existed answered `{exists: false, available: true}`. The probe asked for the object with
      // the family's own media type, took **any** refusal as absence, and the class document
      // answered 406 — "your name is free" was really "I could not read that document".
      // Only an explicit 404 counts as absent; anything else is reported, not guessed.
      const exists = await resolved.session
        .requestAcceptingAny({ path: objectPathForCheck, accept: "*/*" })
        .then(() => true)
        .catch((error: unknown) => {
          if (error instanceof AdtError && error.code === "not-found") return false;
          throw error;
        });
      const packageName = str(args, "package_name");
      // `success` answers the question the tool asks — "is this name free?" — not
      // "did you also tell me the package". Measured: `HandlerValidate`
      // forwards whatever the caller sent, so a plain availability check used to come
      // back as a failure.
      return {
        success: !exists,
        name,
        exists,
        available: !exists,
        validation_kind: "name_availability",
        ...(exists
          ? {
              detail: "an object with this name already exists",
              next_action:
                "Validate* answers whether the name is free for Create; to check the existing object use Check* (CheckProgramLow / CheckClassLow / CheckCdsViewLow / ...)",
            }
          : {}),
        ...(packageName === undefined ? { detail_package: "package_name is required to create this object" } : {}),
        session_id: resolved.sessionId,
      };
    }

    case "Lock": {
      const resolved = runtime.resolve(ctx.system, sessionId, true);
      const lock = await lockObject(resolved.session, objectPath);
      return {
        success: true,
        name,
        lock_handle: lock.lockHandle,
        transport_request: lock.corrNr,
        session_id: resolved.sessionId,
      };
    }

    case "Unlock": {
      const resolved = runtime.resolve(ctx.system, sessionId, true);
      const lockHandle = str(args, "lock_handle");
      if (lockHandle === undefined) {
        throw new GatewayError("INVALID_ARGUMENT", 'Missing "lock_handle".', { family: family.id });
      }
      // Measured live: `LockProgramLow` → `UnlockProgramLow {lock_handle:
      // "DEADBEEF…"}` answered `success: true` while the object kept its enqueue — SAP
      // answers a plain 200 for an UNLOCK whose handle it does not know. The journal knows
      // which handles this logon took, so a handle it never saw is refused instead of
      // reported as released.
      if (!resolved.session.holdsLock(lockHandle)) {
        throw new GatewayError(
          "INVALID_ARGUMENT",
          `No lock of this gateway is open under that handle — "${lockHandle}" was already released or was never issued here.`,
          {
            family: family.id,
            lock_handle: lockHandle,
            nextAction:
              "Pass a handle returned by Lock*Low in this gateway. A handle minted by another client (ADT in Eclipse) cannot be released from here — close it there, or clear it in SM12.",
          },
        );
      }
      const unlock = await unlockObject(resolved.session, objectPath, lockHandle);
      return {
        success: unlock.released,
        name,
        // The journal held this handle, so SAP's 200 is now backed by evidence on our side.
        // Kept in the answer because the release itself is still SAP's word: a handle we
        // hold can also have been dropped by the session timing out.
        release_unverified: false,
        ...(unlock.error === undefined ? {} : { unlock_error: unlock.error }),
        session_id: resolved.sessionId,
      };
    }

    default:
      throw new GatewayError("NOT_IMPLEMENTED", `Verb "${verb}" is not implemented for family "${family.id}".`);
  }
}

async function create(context: DispatchContext, low: boolean, name: string): Promise<unknown> {
  const { args, ctx, runtime, family } = context;
  assertCustomerName(name);

  if (family.createBody === undefined) {
    throw new GatewayError("NOT_IMPLEMENTED", `Family "${family.id}" has no create payload yet.`);
  }

  const resolved = runtime.resolve(ctx.system, str(args, "session_id"), true);
  const create = createContext(args, family, resolved.language, "Create", resolved.session.username);
  // A container in a standard namespace is as off-limits as a standard object.
    // A container in a standard namespace is as off-limits as a standard object — but a
    // local package (`$TMP`) is a legitimate parent: measured,
    // `CreatePackageLow{super_package: "$TMP"}` was refused as "not a customer object name".
    if (create.parent !== undefined) assertCustomerParent(create.parent);
  const body = family.createBody(create);
  const objectPath = family.objectPath(name, create.parent);
  /** What the family's hooks measured, merged into the result below. */
  let extra: Readonly<Record<string, unknown>> = {};

  // A preflight must finish before the POST: a rejected service binding must not
  // leave an unreferenced shell in the package.
  if (family.beforeCreate !== undefined) {
    extra = { ...extra, ...((await family.beforeCreate(resolved.session, create)) ?? {}) };
  }

  // Service binding creation on release 754 answers 415 to the v2 media type
  // even though GET returns v2. `Accept: */*` alone does not help there; the
  // same body has to be sent as v1. A 415 means SAP did not process the request,
  // so trying the next media pair is safe.
  const createMedia = [family.media, ...(family.createMediaFallbacks ?? [])];
  let lastMediaError: unknown;
  for (const media of createMedia) {
    try {
      await resolved.session.requestAcceptingAny({
        method: "POST",
        path: `${collectionOf(family, create.parent)}${transportSuffix(args)}`,
        accept: media.accept,
        contentType: media.contentType,
        body,
        timeoutMs: 120_000,
      });
      lastMediaError = undefined;
      break;
    } catch (error) {
      if (!(error instanceof AdtError && error.code === "content-negotiation")) throw error;
      lastMediaError = error;
    }
  }
  if (lastMediaError !== undefined) throw lastMediaError;

  if (family.afterCreate !== undefined) {
    try {
      extra = { ...extra, ...((await family.afterCreate(resolved.session, create, objectPath)) ?? {}) };
    } catch (error) {
      // The POST already created the object, so a rejected payload leaves an empty shell in the
      // package: measured, `CreateCdsView` with a DDL the release cannot parse answered 400 from the
      // PUT and the shell stayed behind — the next create then answers "already exists" and the
      // caller has nothing to work with. Removing it here keeps the promise the tool description
      // makes, and the removal result travels in `details` either way.
      const removal = await deleteObject(resolved.session, objectPath, str(args, "transport_request")).then(
        () => ({ shell_removed: true }),
        (cause: unknown) => ({
          shell_removed: false,
          shell_removal_error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
      const message = error instanceof Error ? error.message : String(error);
      const nextAction = removal.shell_removed
        ? "The object was created and then removed again; nothing is left in the package. Fix the payload and create it once more."
        : `The object was created but could NOT be removed again (${String((removal as { shell_removal_error?: string }).shell_removal_error ?? "unknown")}). Delete it before retrying, or the next create answers "already exists".`;
      // A family that refused the payload on purpose (`NOT_IMPLEMENTED`, `INVALID_ARGUMENT`) keeps its
      // code: the shell cleanup is an addition to its answer, not a different failure.
      if (error instanceof GatewayError) {
        throw new GatewayError(error.code, error.message, { ...(error.details ?? {}), ...removal, nextAction });
      }
      throw new GatewayError("UPSTREAM_FAILED", message, {
        ...removal,
        // Keep the SAP-side facts the caller may branch on: the original error type is lost by
        // wrapping, so it travels here instead of silently disappearing.
        ...(error instanceof AdtError
          ? { sap_code: error.code, status: error.status, method: error.method, path: error.path, sapText: error.sapText }
          : {}),
        nextAction,
      });
    }
  }

  // Measured: a freshly created class cannot be read back in the same session
  // until it has been activated once — every GET answers
  // `500 ... wrong input data for processing`, while a program created the same
  // way is readable immediately. Activating here makes the object usable no
  // matter which family it is; a family whose content cannot be activated yet
  // reports `activated: false` instead of failing the create.
  //
  // `activate:false` is part of several create schemas (service binding, CDS view,
  // domain, ...). Ignoring it silently activated a service binding that the caller
  // explicitly wanted staged, so the flag is honoured here rather than per family.
  const shouldActivate = args["activate"] !== false;
  let activated = false;
  let activationNote: string | undefined;
  if (!shouldActivate) {
    activationNote = "activation skipped (activate=false)";
  } else {
    try {
      const report = await activate(resolved.session, [
        { uri: `/sap/bc/adt${objectPath}`, name, adtType: family.adtType },
      ]);
      activated = report.ok;
      if (!report.ok) activationNote = report.status;
    } catch (error) {
      activationNote = error instanceof Error ? error.message : String(error);
    }
  }

  if (family.afterActivate !== undefined) {
    extra = { ...extra, activated };
    if (shouldActivate) {
      extra = { ...extra, ...((await family.afterActivate(resolved.session, create, objectPath)) ?? {}) };
    }
  }

  // A package stays enqueued to the creating session, so the next write in that same
  // session is refused as "already locked"; ending it here is what makes the chain work.
  await dropSessionIfEnqueuing(runtime, family);

  return {
    success: true,
    name,
    package_name: create.packageName,
    description: create.description,
    adt_type: family.adtType,
    ...(family.afterActivate === undefined ? { activated } : {}),
    ...(activationNote === undefined ? {} : { activation_note: activationNote }),
    ...extra,
    session_id: resolved.sessionId,
    message: low
      ? `Created ${name}. Write its source with Update${family.id}Low inside a lock.`
      : `Created ${name}. Use Update${family.id} to write the source.`,
  };
}

async function update(
  context: DispatchContext,
  low: boolean,
  name: string,
  objectPath: string,
): Promise<unknown> {
  const { args, ctx, runtime, family } = context;
  const resolved = runtime.resolve(ctx.system, str(args, "session_id"), true);

  const sourceParam = family.sourceParam ?? "source_code";
  const isPatch = family.update.kind === "patch";
  const hunks = Array.isArray(args["patch"]) ? (args["patch"] as PatchHunk[]) : undefined;

  const sourcePath = family.sourcePath?.(objectPath) ?? objectPath;

  // A patch is applied to the *active* source server-side, so the caller never has to
  // resend the unchanged lines.: hand-retyping a 90 KB report four times
  // produced two defects (389 missing lines, then one missing period).
  let source = resolveSource(args, sourceParam);
  let patchReport: { applied: { match: string; count: number }[] } | undefined;
  if (hunks !== undefined) {
    if (source !== undefined) {
      throw new GatewayError("INVALID_ARGUMENT", 'Pass "patch" or a full source, not both.', {
        accepted: ["patch", sourceParam, "source_file"],
      });
    }
    if (family.sourcePath === undefined) {
      throw new GatewayError("INVALID_ARGUMENT", `"patch" needs a text source; ${family.id} has none.`, {
        nextAction: `Send the whole document with "${sourceParam}".`,
      });
    }
    const active = await readSource(resolved.session, sourcePath, "active");
    const appliedResult = applyPatch(active, hunks);
    source = appliedResult.text;
    patchReport = { applied: appliedResult.applied };
  }

  if (source === undefined && !isPatch) {
    throw new GatewayError("INVALID_ARGUMENT", `Missing "${sourceParam}" (or "source_file" / "patch").`, {
      family: family.id,
      accepted: [sourceParam, "source_file", "patch"],
    });
  }
  // Where the body goes and what media type it needs — one place, next to the payload builder.
  const { target, accept, contentType } = requestShape(family, objectPath, sourcePath);

  /** Builds the payload for this update, reading the current document when patching. */
  const payloadFor = (): Promise<string> =>
    buildUpdatePayload({
      family,
      source,
      context: () => createContext(args, family, resolved.language, "Update", resolved.session.username),
      session: resolved.session,
      objectPath,
    });

  if (low) {
    const lockHandle = str(args, "lock_handle");
    if (lockHandle === undefined) {
      throw new GatewayError(
        "INVALID_ARGUMENT",
        'Update' + family.id + 'Low needs "lock_handle" from Lock' + family.id + "Low.",
        { family: family.id },
      );
    }
    const transport = str(args, "transport_request");
    const payload = await payloadFor();
    const fingerprint = assertPayloadMatches(payload, args);
    const put = (session: typeof resolved.session, handle: string): Promise<unknown> =>
      session.request({
        method: "PUT",
        path: `${target}?${lowUpdateQuery(handle, transport)}`,
        accept,
        contentType,
        body: payload,
        timeoutMs: 120_000,
      });
    try {
      await put(resolved.session, lockHandle);
    } catch (error) {
      // A package stays enqueued to the session that created it, so the first write in
      // that session is refused as "already locked" even though the handle is fresh.
      // A new session (and a new lock in it) is what SAP accepts — measured.
      if (!isAlreadyLocked(error) || family.dropSessionAfterWrite !== true) throw error;
      await runtime.closeAll();
      const retry = runtime.resolve(ctx.system, undefined, true);
      const freshLock = await lockObject(retry.session, objectPath);
      try {
        await put(retry.session, freshLock.lockHandle);
      } finally {
        await unlockObject(retry.session, objectPath, freshLock.lockHandle);
      }
      await dropSessionIfEnqueuing(runtime, family);
      // No handle to hand back: the retry locked, wrote and released again, and the session that
      // could have held the lock is closed right above. Returning `freshLock.lockHandle` promised a
      // lock that no longer existed — measured, `UnlockPackageLow` with it answered
      // `INVALID_ARGUMENT: No lock of this gateway is open under that handle`, i.e. the gateway
      // refused a handle it had just issued itself.
      return {
        success: true,
        name,
        lock_handle: null,
        lock_released: true,
        activated: false,
        retried_in_new_session: true,
        ...fingerprint,
        transport_used: transport ?? null,
        ...(patchReport === undefined ? {} : { patch: patchReport }),
        session_id: retry.sessionId,
      };
    }
    await dropSessionIfEnqueuing(runtime, family);
    return {
      success: true,
      name,
      lock_handle: lockHandle,
      activated: false,
      ...fingerprint,
      transport_used: transport ?? null,
      ...(patchReport === undefined ? {} : { patch: patchReport }),
      session_id: resolved.sessionId,
    };
  }

  // High-level: own the lock, and release it before activating — activating a
  // locked object answers 403 "currently editing".
  // Source payloads are known without I/O, so they are fingerprinted *before* the lock:
  // a mismatch then costs nothing (no lock, no write, no leftover inactive version).
  // Document families (patch/body) can only build their payload after the lock.
  const transport = str(args, "transport_request");
  const inlinePayload = family.update.kind === "source" ? (source ?? "") : undefined;
  const preFingerprint = inlinePayload === undefined ? undefined : assertPayloadMatches(inlinePayload, args);

  if (preFingerprint !== undefined && family.sourcePath !== undefined && bool(args, "check_no_change", false) === true) {
    try {
      const active = await readSource(resolved.session, sourcePath, "active");
      if (normalizeSource(active) === normalizeSource(inlinePayload ?? "")) {
        return {
          success: true,
          name,
          written: false,
          activated: true,
          no_change: true,
          status: "the active version already equals the requested content",
          ...preFingerprint,
          transport_used: transport ?? null,
          ...(patchReport === undefined ? {} : { patch: patchReport }),
          session_id: resolved.sessionId,
        };
      }
    } catch {
      // Reading the active version only saves a write; if it fails, just write.
    }
  }

  if (family.beforeUpdate !== undefined) {
    await family.beforeUpdate(resolved.session, createContext(args, family, resolved.language, "Update", resolved.session.username), objectPath);
  }
  const lock = await lockObject(resolved.session, objectPath);
  const writeKey = `${resolved.sessionId}|${objectPath}`;
  const overlappingWrite = beginObjectWrite(writeKey);
  let payload = inlinePayload ?? "";
  let fingerprint = preFingerprint;
  let wrote = false;
  try {
    payload = inlinePayload ?? (await payloadFor());
    fingerprint = preFingerprint ?? assertPayloadMatches(payload, args);
    await writeSource(resolved.session, target, payload, {
      lockHandle: lock.lockHandle,
      corrNr: lock.corrNr ?? transport ?? null,
      ...(family.updateTarget === "object" ? { accept, contentType } : {}),
    });
    wrote = true;
  } catch (error) {
    // "Can't save due to errors in source; execute check for details" tells the caller to run a
    // check and then says nothing. Running one here does not help either: SAP refuses the DDL
    // **before** storing it, so there is no draft to check (measured — the check came
    // back with zero messages). What does help is naming the usual cause.
    const message = error instanceof Error ? error.message : String(error);
    if (!/execute check for details/i.test(message)) throw error;
    // A check that cannot run at all and a check that found nothing are different facts; the answer
    // used to state the second one either way.
    let checkFailure: string | undefined;
    const details = await runCheck(resolved.session, target, "inactive").catch((cause: unknown) => {
      checkFailure = cause instanceof Error ? cause.message : String(cause);
      return undefined;
    });
    if (details !== undefined && details.messages.length > 0) {
      throw new GatewayError(
        "UPSTREAM_FAILED",
        `${message} — the check says: ${details.messages.slice(0, 3).join(" · ")}`,
        {
          ...(error instanceof GatewayError ? (error.details ?? {}) : {}),
          check_messages: details.messages,
          errors: details.errors,
        },
      );
    }
    throw new GatewayError("UPSTREAM_FAILED", message, {
      ...(error instanceof GatewayError ? (error.details ?? {}) : {}),
      ...(checkFailure === undefined ? {} : { check_error: checkFailure }),
      nextAction:
        (checkFailure === undefined ? "" : `The check itself did not run (${checkFailure}), so there is no line to point at. `) +
        "SAP refuses this source before storing it, so there is no draft to check. For a table or " +
        "structure the usual cause is a missing `@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE` " +
        "(or another required annotation): start from the DDL `GetTable` / `GetStructure` returns and " +
        "change only what you need.",
    });
  } finally {
    await unlockObject(resolved.session, objectPath, lock.lockHandle);
    endObjectWrite(writeKey);
  }

  // A document write can answer 2xx and keep the old values — measured: `UpdateDomainLow`
  // with `properties.length: 50` answered `written: true` while the domain still said `000040`.
  // Check only the properties the caller actually sent, so SAP's own reformatting stays out of it.
  // Did the document actually keep what the caller sent? (see `spec/confirm.ts`)
  const documentMismatch = await confirmDocumentProperties({
    family,
    args,
    session: resolved.session,
    objectPath,
    wrote,
  });

  const transportUsed = lock.corrNr ?? transport ?? null;
  if (!bool(args, "activate", true)) {
    return {
      success: true,
      name,
      written: wrote,
      activated: false,
      note: "activate=false left an inactive version; activate it or revert before leaving it there.",
      ...(overlappingWrite ? { concurrent_write: CONCURRENT_WRITE_NOTE } : {}),
      ...(documentMismatch === undefined ? {} : { mismatch: documentMismatch }),
      ...(fingerprint ?? {}),
      transport_used: transportUsed,
      ...(patchReport === undefined ? {} : { patch: patchReport }),
      session_id: resolved.sessionId,
    };
  }

  const verified = await verifyActivation(family, resolved.session, {
    objectPath,
    name,
    sourcePath,
    source: payload,
  });

  // Activation failed on a family whose PUT accepts any text: put the last good source back
  // (see `update/rollback.ts`).
  const reverted =
    !verified.activated && /error/i.test(verified.status)
      ? await restorePreviousVersion({
          session: resolved.session,
          family,
          objectPath,
          sourcePath,
          target,
          accept,
          contentType,
          transport: transportUsed,
          activate: (restored) =>
            verifyActivation(family, resolved.session, { objectPath, name, sourcePath, source: restored }),
        })
      : false;
  const attemptRollback = !verified.activated && /error/i.test(verified.status);
  const effectiveStatus = reverted
    ? `${verified.status} — the previous active source was restored, so nothing changed`
    : attemptRollback
      ? `${verified.status} — and the rollback did NOT succeed: the inactive version still holds the rejected source. Read it before writing again.`
      : verified.status;

  const after =
    family.afterUpdate === undefined
      ? {}
      : ((await family.afterUpdate(resolved.session, createContext(args, family, resolved.language, "Update", resolved.session.username), objectPath)) ??
        {});

  return {
    success: verified.activated && documentMismatch === undefined,
    name,
    written: wrote,
    activated: verified.activated,
    status: effectiveStatus,
    ...(overlappingWrite ? { concurrent_write: CONCURRENT_WRITE_NOTE } : {}),
    // Always present: "false" has to be distinguishable from "this path has no rollback".
    reverted,
    ...(attemptRollback && !reverted ? { draft_left: true } : {}),
    ...(documentMismatch === undefined ? {} : { mismatch: documentMismatch }),
    ...(verified.detail === undefined ? {} : verified.detail),
    ...(fingerprint ?? {}),
    transport_used: transportUsed,
    ...(patchReport === undefined ? {} : { patch: patchReport }),
    ...after,
    session_id: resolved.sessionId,
  };
}

interface VerificationResult {
  readonly activated: boolean;
  readonly status: string;
  readonly detail?: Record<string, string>;
}

/**
 * Decides whether an object really went live.
 *
 * For text sources that means "the active version equals what was written". For
 * DDIC objects the platform rewrites the content on save, so equality is not
 * achievable and the honest check is "activation reported no errors and the
 * object reads back non-empty" — claiming a content match there would be false.
 */
async function verifyActivation(
  family: ObjectFamily,
  session: AdtSession,
  request: { objectPath: string; name: string; sourcePath: string; source: string },
): Promise<VerificationResult> {
  if (family.verification !== "readable") {
    const verified = await activateAndVerify(session, {
      uri: `/sap/bc/adt${request.objectPath}`,
      name: request.name,
      adtType: family.adtType,
      sourcePath: request.sourcePath,
      source: request.source,
      ...(family.verification === "normalized" ? { loose: true } : {}),
      ...(family.verification === "tokens" ? { tokens: true } : {}),
    });
    return {
      activated: verified.activated,
      status: verified.report.status,
      ...(verified.comparison.equal ? {} : { detail: { mismatch: verified.comparison.detail ?? "content differs" } }),
    };
  }

  const report = await activate(session, [
    { uri: `/sap/bc/adt${request.objectPath}`, name: request.name, adtType: family.adtType },
  ]);
  let readable = false;
  let detail: Record<string, string> | undefined;
  try {
    const active =
      family.sourcePath === undefined
        ? await session
            .requestAcceptingAny({ path: request.objectPath, accept: family.media.accept })
            .then((response) => response.body)
        : await readSource(session, request.sourcePath, "active");
    readable = active.trim().length > 0;
    if (!readable) detail = { mismatch: "the active version is empty after activation" };
  } catch (error) {
    detail = { mismatch: error instanceof Error ? error.message : String(error) };
  }

  return {
    activated: report.ok && readable,
    status: report.status,
    ...(detail === undefined ? {} : { detail }),
  };
}
