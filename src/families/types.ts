/**
 * Object family descriptors.
 *
 * The contract has 10 families with exactly the same 13 verbs: create (high and
 * low), read, get, update (high and low), delete (high and low), activate,
 * check, validate, lock, unlock. Only four things differ per family: the
 * parameter that carries the name, the URI, the ADT type, and the media types.
 *
 * So the verbs are written once as a generator over this descriptor, and adding
 * a family means adding one table entry — not thirteen handlers.
 */

export interface CreateContext {
  readonly name: string;
  /** Container name for families that live inside one (function groups). */
  readonly parent?: string;
  readonly description: string;
  readonly packageName: string;
  readonly language: string;
  /**
   * Logon user, for documents that demand a responsible person.
   *
 * Measured: creating a package without `adtcore:responsible` answers
   * "enter a valid user (instead of blanks) as the person responsible".
   */
  readonly responsible?: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * The XML envelope ADT expects when creating an object.
 *
 * `root` and `namespace` are measured, not guessed: reading a standard object of
 * the same type returns exactly this element, and creating one is the same
 * envelope without content.
 */
export interface CreateEnvelope {
  /** Qualified root element, e.g. `class:abapClass`. */
  readonly root: string;
  /** Namespace declarations for the envelope, without the `xmlns:` prefix. */
  readonly namespaces: readonly (readonly [string, string])[];
  /** Extra attributes on the root, e.g. `class:final="false"`. */
  readonly attributes?: (context: CreateContext) => readonly (readonly [string, string])[];
  /** Children placed after `adtcore:packageRef`, e.g. the includes to create. */
  readonly children?: (context: CreateContext) => string;
}

export interface ObjectFamily {
  /** Tool-name infix, e.g. `Program` in `CreateProgram`. */
  readonly id: string;
  /** Argument that carries the object name, e.g. `program_name`. */
  readonly nameParam: string;
  /**
   * Verbs whose name argument differs from `nameParam`.
   *
   * Not a nicety: `MetadataExtension` reads with `metadata_extension_name` but
   * creates and locks with `name`, and the contract cannot be changed.
   */
  readonly nameParamByVerb?: Readonly<Record<string, string>>;
  /**
   * Argument that carries the container the object lives in.
   *
   * Only function modules need it: an `FUGR/FF` has no address of its own, it is
   * `/functions/groups/<group>/fmodules/<module>`. Every other family passes
   * `undefined` and ignores it.
   */
  readonly parentParam?: string;
  /**
   * True when the container is only needed to CREATE the object (packages: a package
   * is addressed by its own name for Get / Check / Validate / Lock).
   */
  readonly parentOptional?: boolean;
  /** Tool-name overrides where the contract does not spell the family out (`CheckBdefLow`). */
  readonly verbToolName?: Readonly<Record<string, string>>;
  /**
   * Set when SAP keeps the object enqueued to the writing session, so the next write in
   * the same session is refused as "already locked".
   *
   * Measured on packages: create -> lock -> PUT answers "package X is locked", while the
   * same chain in a new session works. The handlers drop the session after a successful write.
   */
  readonly dropSessionAfterWrite?: boolean;
  /**
   * Set when SAP's ABAP check cannot say anything useful about this family.
   *
   * The Check verb then answers `errors: 0` with this text in `unavailable` instead of
   * handing over a message about SAP's own generated source as if it were a defect.
   */
  readonly checkUnavailable?: string;
  /**
   * Verbs this family must not register, because a dedicated handler owns them.
   *
   * `UpdateServiceBinding` is a publish/unpublish job, not a PUT of the document —
   * the generic update re-uploaded the binding and SAP answered
   * "the description of <binding> is missing".
   */
  readonly skipVerbs?: readonly string[];
  /** Argument that carries the source text. Defaults to `source_code`. */
  readonly sourceParam?: string;
  /** `adtcore:type`, e.g. `PROG/P`. */
  readonly adtType: string;
  /** Path below `/sap/bc/adt` for the object itself. */
  readonly objectPath: (name: string, parent?: string) => string;
  /** Path of the collection used to create one, e.g. `/programs/programs`. */
  readonly collectionPath: string | ((parent?: string) => string);
  /** Source path when the family stores its content as plain text. */
  readonly sourcePath?: (objectPath: string) => string;
  /** Media types for reading and creating the object. */
  readonly media: { readonly accept: string; readonly contentType: string };
  /**
   * Extra create media pairs for releases that reject the current one.
   *
   * Measured on release 754: service-binding GET answers v2, but POST rejects
   * v2 with 415; the same body is accepted as v1. SAP did not process a 415, so
   * retrying the POST with a different media pair is safe.
   */
  readonly createMediaFallbacks?: readonly { readonly accept: string; readonly contentType: string }[];
  /** Builds the create request body. Absent for families created some other way. */
  readonly createBody?: (context: CreateContext) => string;
  /**
   * Preflight that must pass before the create POST.
   *
   * Service bindings use it for the service definition, the installed binding type
   * and the CTS transport check; a failure here must not leave a shell behind.
   */
  readonly beforeCreate?: (
    session: import("../adt/session.js").AdtSession,
    context: CreateContext,
  ) => Promise<void | Readonly<Record<string, unknown>>>;
  /** Envelope form, used when the body is the generic `createBody` shape. */
  readonly envelope?: CreateEnvelope;
  /** Update payload: plain text source, or a body built from the arguments. */
  readonly update:
    | { readonly kind: "source" }
    | {
        readonly kind: "body";
        readonly contentType: string;
        readonly build: (context: CreateContext & { readonly source: string }) => string;
      }
    /**
     * Read-modify-write: the platform's own shape for DDIC objects, whose update
     * verbs take structured fields rather than a `source_code` document.
     */
    | {
        readonly kind: "patch";
        readonly contentType: string;
        readonly patch: (currentXml: string, context: CreateContext) => string;
      };
  /**
   * Where an update is written.
   *
   * `source` means PUT the text source path (`.../source/main`). `object` means
   * PUT the object URI itself with the payload — measured for DDIC tables and
   * structures, whose content is not a DDL *source* but a `blue:content`
   * element, and where posting to `source/main` answers
   * "Can't save due to errors in source".
   */
  readonly updateTarget?: "source" | "object";
  /**
   * How activation success is decided.
   *
   * `content` (default): the active version must equal what was written, after
   * normalising line endings and trailing whitespace.
   * `normalized`: same, but blank lines are ignored too — SAP stores some
   * objects in sections and re-joins them with blank lines the caller never
   * wrote (function module signature and implementation).
   * `readable`: the platform rewrites the object's content on save (DDIC adds
   * `@AbapCatalog` annotations and re-formats DDL), so byte equality can never
   * hold — success is "activation reported no errors and the object reads back
   * non-empty".
   */
  readonly verification?: "content" | "readable" | "normalized" | "tokens";
  /**
   * Work that must happen before a high-level delete.
   *
   * Service bindings use it to unpublish a published binding, which the generic
   * DELETE cannot do; a failure here must abort the delete.
   */
  readonly beforeDelete?: (
    session: import("../adt/session.js").AdtSession,
    context: CreateContext,
  ) => Promise<void | Readonly<Record<string, unknown>>>;
  /**
   * Extra work right after the object was created.
   *
   * Measured need: a domain accepts fixed values only through a later update —
   * sending them in the create body answers `400 internal error while writing`,
   * while create-then-update stores them correctly.
   */
  readonly afterCreate?: (
    session: import("../adt/session.js").AdtSession,
    context: CreateContext,
    objectPath: string,
  ) => Promise<void | Readonly<Record<string, unknown>>>;
  /**
   * Extra work after the new object has been activated.
   *
   * Measured need: an include's `INCLUDE <name>.` statement must be in the main
   * program *and* the include must be active before the main program is
   * activated — otherwise the activation compiles the empty shell and D010INC
   * never gets the row that makes the include part of the program tree.
   * Whatever a hook returns is merged into the create result.
   */
  readonly afterActivate?: (
    session: import("../adt/session.js").AdtSession,
    context: CreateContext,
    objectPath: string,
  ) => Promise<void | Readonly<Record<string, unknown>>>;
  /**
   * Extra work right before a high-level update touches the object.
   *
   * Measured need: a behaviour implementation's definition clause (`FOR BEHAVIOR OF`)
   * lives in `source/main`, while the update writes the implementations include. The
   * clause has to be in place *before* activation, so it cannot be a post-hook.
   */
  readonly beforeUpdate?: (
    session: import("../adt/session.js").AdtSession,
    context: CreateContext,
    objectPath: string,
  ) => Promise<void>;
  /**
   * Extra work after a high-level update.
   *
   * Measured need: `UpdateInclude` takes `main_program` and its description
   * promises a program-wide syntax check — an include is only meaningful inside
   * its program, so the check has to run on the main program, not on the include.
   * Whatever a hook returns is merged into the update result.
   */
  readonly afterUpdate?: (
    session: import("../adt/session.js").AdtSession,
    context: CreateContext,
    objectPath: string,
  ) => Promise<void | Readonly<Record<string, unknown>>>;
}

/** Lower-cases the object name for the URI; ADT is case-insensitive but the paths are lower. */
export function lower(name: string): string {
  return name.trim().toLowerCase();
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `Z*` / `Y*` only: writing to a standard namespace is not a user decision. */
export function assertCustomerName(name: string): void {
  if (!/^[ZY][A-Z0-9_/]*$/i.test(name.trim())) {
    throw new FamilyError(
      "invalid-name",
      `"${name}" is not a customer object name.`,
      "Object names must start with Z or Y; this gateway only writes customer namespaces.",
    );
  }
}

/**
 * A container may be a local package (`$TMP`) — measured: creating a package
 * *below* `$TMP` was refused as "not a customer object name", although a local child
 * package is exactly what `$TMP` is for. Any other system namespace stays off-limits.
 */
export function assertCustomerParent(name: string): void {
  if (/^\$[A-Z0-9_/]*$/i.test(name.trim())) return;
  assertCustomerName(name);
}

export class FamilyError extends Error {
  readonly code: string;
  readonly nextAction: string;

  constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.name = "FamilyError";
    this.code = code;
    this.nextAction = nextAction;
  }
}

const ADT_CORE = "http://www.sap.com/adt/core";

/**
 * Renders the generic create envelope.
 *
 * Every family measured so far creates an object with the same shape: a typed
 * root element, `adtcore` identity attributes, optional type-specific attributes
 * and children, then `adtcore:packageRef`. Keeping that in one function means the
 * per-family table only lists what actually differs.
 */
export function renderCreateBody(
  envelope: CreateEnvelope,
  context: CreateContext,
  adtType: string,
): string {
  const declarations = [["adtcore", ADT_CORE] as const, ...envelope.namespaces]
    .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
    .join(" ");

  const attributes = [
    `adtcore:description="${escapeXml(context.description.slice(0, 60))}"`,
    `adtcore:language="${escapeXml(context.language)}"`,
    `adtcore:name="${escapeXml(context.name)}"`,
    `adtcore:type="${escapeXml(adtType)}"`,
    `adtcore:masterLanguage="${escapeXml(context.language)}"`,
    ...(envelope.attributes?.(context) ?? []).map(([key, value]) => `${key}="${escapeXml(value)}"`),
  ].join(" ");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<${envelope.root} ${declarations} ${attributes}>` +
    `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
    (envelope.children?.(context) ?? "") +
    `</${envelope.root}>`
  );
}
