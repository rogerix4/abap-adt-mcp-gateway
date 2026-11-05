/**
 * The 13 verbs, written once.
 *
 * High-level verbs own the whole lifecycle (lock, write, unlock, activate and
 * verify); low-level verbs take a `lock_handle` and change one step. That split
 * is the contract's, not a design choice — 134 of the 335 tools are low-level.
 */

import type { ToolRegistry } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import type { AdtSession } from "../adt/session.js";
import {
  activate,
  activateAndVerify,
  deleteObject,
  readSource,
  runCheck,
  unlockObject,
  writeSource,
  lockObject,
} from "../adt/lifecycle.js";
import { GatewayError } from "../engine/errors.js";
import { AdtError } from "../adt/errors.js";
import { assertCustomerName, assertCustomerParent, FamilyError, type CreateContext, type ObjectFamily } from "./types.js";

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function bool(args: Args, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function requireName(args: Args, family: ObjectFamily, verb: string): string {
  const param = family.nameParamByVerb?.[verb] ?? family.nameParam;
  const name = str(args, param);
  if (name !== undefined) return name;
  // The contract spells the same argument differently on the high and the low tool:
  // `DeleteMetadataExtension` takes `metadata_extension_name`, `DeleteMetadataExtensionLow`
  // takes `name` — measured 2026-11-04, the low delete rejected the documented `name`.
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
    // address it by its own name (measured 2026-11-04: `GetPackage Z001` demanded
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
 * Measured 2026-11-04: create -> lock -> PUT on a package answers "package X is locked" in
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
  // The system answers in the logon language, so the Chinese wording is matched as well.
  return /已锁定|already locked|is locked/i.test(text);
}

/**
 * Query for a low-level PUT: the lock handle, plus `corrNr` when the object is
 * transportable.
 *
 * Measured 2026-11-04: `UpdatePackageLow` on a package in transport layer `ZDS4`
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
        const document = await resolved.session
          .requestAcceptingAny({ path: objectPath, accept: family.media.accept })
          .then((response) => response.body);
        return {
          success: true,
          name,
          version: "active",
          content_type: family.media.accept,
          content: document,
        };
      }

      const sourcePath = family.sourcePath(objectPath);
      const source = await readSource(resolved.session, sourcePath, version);
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
        success: result.deleted,
        name,
        status: result.status,
        ...(beforeDelete === undefined ? {} : { pre_delete: beforeDelete }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
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
        const draft = await readSource(resolved.session, sourcePath, "inactive").catch(() => undefined);
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
      const exists = await resolved.session
        .request({ path: objectPathForCheck, accept: family.media.accept })
        .then(() => true)
        .catch(() => false);
      const packageName = str(args, "package_name");
      // `success` answers the question the tool asks — "is this name free?" — not
      // "did you also tell me the package". Measured 2026-11-04: `HandlerValidate`
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
      const unlock = await unlockObject(resolved.session, objectPath, lockHandle);
      return {
        success: unlock.released,
        name,
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
    // local package (`$TMP`) is a legitimate parent: measured 2026-11-04,
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
    extra = { ...extra, ...((await family.afterCreate(resolved.session, create, objectPath)) ?? {}) };
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
  const source = str(args, sourceParam);
  const isPatch = family.update.kind === "patch";
  if (source === undefined && !isPatch) {
    throw new GatewayError("INVALID_ARGUMENT", `Missing "${sourceParam}".`, { family: family.id });
  }

  const sourcePath = family.sourcePath?.(objectPath) ?? objectPath;
  const contentType =
    family.update.kind === "source" ? "text/plain; charset=utf-8" : family.update.contentType;
  // Tables, structures and DDIC bodies take their content on the object URI,
  // not on a source path.
  const target = family.updateTarget === "object" ? objectPath : sourcePath;
  // A document PUT has to accept the document's own media type. Measured 2026-11-04:
  // `UpdateFunctionGroup` sent `Accept: text/plain` with an XML body and SAP answered
  // "The message content is not acceptable" — the function group is the family whose
  // update is a document, not a source.
  const accept = family.update.kind === "patch" || family.updateTarget === "object" ? family.media.accept : "text/plain";

  /** Builds the payload for this update, reading the current document when patching. */
  const payloadFor = async (): Promise<string> => {
    if (family.update.kind === "source") return source ?? "";
    if (family.update.kind === "body") {
      return family.update.build({
        ...createContext(args, family, resolved.language, "Update", resolved.session.username),
        source: source ?? "",
      });
    }
    // The document is read with a permissive accept: measured 2026-11-04, a function group
    // answers 200 for `Accept: */*` but rejects the bare `…functions.groups.v2+xml` with
    // "The message content is not acceptable", which made `UpdateFunctionGroup` fail on the
    // read that precedes the patch.
    const current = await resolved.session
      .requestAcceptingAny({ path: objectPath, accept: family.media.accept })
      .then((response) => String(response.body ?? ""));
    return family.update.patch(current, createContext(args, family, resolved.language, "Update", resolved.session.username));
  };

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
      // A new session (and a new lock in it) is what SAP accepts — measured 2026-11-04.
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
      return { success: true, name, lock_handle: freshLock.lockHandle, activated: false, retried_in_new_session: true, session_id: retry.sessionId };
    }
    await dropSessionIfEnqueuing(runtime, family);
    return { success: true, name, lock_handle: lockHandle, activated: false, session_id: resolved.sessionId };
  }

  // High-level: own the lock, and release it before activating — activating a
  // locked object answers 403 "currently editing".
  if (family.beforeUpdate !== undefined) {
    await family.beforeUpdate(resolved.session, createContext(args, family, resolved.language, "Update", resolved.session.username), objectPath);
  }
  const lock = await lockObject(resolved.session, objectPath);
  let payload = source ?? "";
  let wrote = false;
  try {
    const transport = str(args, "transport_request");
    payload = await payloadFor();
    await writeSource(resolved.session, target, payload, {
      lockHandle: lock.lockHandle,
      corrNr: lock.corrNr ?? transport ?? null,
      ...(family.updateTarget === "object" ? { accept, contentType } : {}),
    });
    wrote = true;
  } finally {
    await unlockObject(resolved.session, objectPath, lock.lockHandle);
  }

  if (!bool(args, "activate", true)) {
    return { success: true, name, written: wrote, activated: false, session_id: resolved.sessionId };
  }

  const verified = await verifyActivation(family, resolved.session, {
    objectPath,
    name,
    sourcePath,
    source: payload,
  });

  const after =
    family.afterUpdate === undefined
      ? {}
      : ((await family.afterUpdate(resolved.session, createContext(args, family, resolved.language, "Update", resolved.session.username), objectPath)) ??
        {});

  return {
    success: verified.activated,
    name,
    written: wrote,
    activated: verified.activated,
    status: verified.status,
    ...(verified.detail === undefined ? {} : verified.detail),
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
