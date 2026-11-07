/**
 * How an update becomes a request body — one function per write shape.
 *
 * Extracted from `handlers.update()` (S2 of `docs/ARCHITECTURE.md`): the dispatch decides *which*
 * verb and *which* object, the shape decides *what to send*. Keeping the three shapes apart is what
 * makes them individually testable, and it is where the "read the current document, change only what
 * the caller set" behaviour belongs.
 */
import type { AdtSession } from "../../adt/session.js";
import type { CreateContext, ObjectFamily } from "../types.js";

export interface PayloadRequest {
  readonly family: ObjectFamily;
  /** The source text the caller sent, already resolved from `source_code` / `source_file` / `patch`. */
  readonly source: string | undefined;
  /** Built lazily so the context carries the current arguments and language. */
  readonly context: () => CreateContext;
  readonly session: AdtSession;
  readonly objectPath: string;
}

/** The body to PUT for this update. */
export async function buildUpdatePayload(request: PayloadRequest): Promise<string> {
  const { family, source } = request;
  if (family.update.kind === "source") return source ?? "";
  if (family.update.kind === "body") {
    return family.update.build({ ...request.context(), source: source ?? "" });
  }
  // The document is read with a permissive accept: measured, a function group answers 200
  // for `Accept: */*` but rejects the bare `…functions.groups.v2+xml` with "The message content is
  // not acceptable", which made `UpdateFunctionGroup` fail on the read that precedes the patch.
  const current = await request.session
    .requestAcceptingAny({ path: request.objectPath, accept: family.media.accept })
    .then((response) => String(response.body ?? ""));
  return family.update.patch(current, request.context());
}

/**
 * The content type and the URI a body goes to.
 *
 * Tables, structures and DDIC bodies take their content on the object URI, not on a source path, and
 * a document PUT has to accept the document's own media type (measured: sending
 * `Accept: text/plain` with an XML body made SAP answer "The message content is not acceptable").
 */
export function requestShape(family: ObjectFamily, objectPath: string, sourcePath: string): {
  target: string;
  accept: string;
  contentType: string;
} {
  return {
    target: family.updateTarget === "object" ? objectPath : sourcePath,
    accept: family.update.kind === "patch" || family.updateTarget === "object" ? family.media.accept : "text/plain",
    contentType: family.update.kind === "source" ? "text/plain; charset=utf-8" : family.update.contentType,
  };
}
