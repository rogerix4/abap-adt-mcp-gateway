/**
 * Confirms that a document write really changed what it was asked to change.
 *
 * Measured: `UpdateDomainLow` answered `written: true` for `properties: { length: 50 }`
 * while the stored domain still said `000040` — the payload was built from the flat arguments and a
 * JSON number was dropped. The write path therefore re-reads the document and asks the family's
 * `PropertySpec` whether the values it was given are in there.
 *
 * Only keys the caller actually sent are checked, so SAP's own reformatting of everything else stays
 * out of the verdict — a raw XML comparison would flag every write.
 */
import type { AdtSession } from "../../adt/session.js";
import type { ObjectFamily } from "../types.js";
import { missingProperty, propertySpecOf } from "./properties.js";

export interface DocumentConfirmation {
  readonly family: ObjectFamily;
  readonly args: Readonly<Record<string, unknown>>;
  readonly session: AdtSession;
  readonly objectPath: string;
  /** Nothing was written, so there is nothing to confirm. */
  readonly wrote: boolean;
}

/** A message when a property the caller sent is missing from the stored document. */
export async function confirmDocumentProperties(request: DocumentConfirmation): Promise<string | undefined> {
  const { family, args, session, objectPath, wrote } = request;
  if (!wrote) return undefined;
  const spec = propertySpecOf(family.id);
  // Families whose update is a body rather than a patch still stage a document; both carry the
  // `object` target, and the spec decides whether this family has anything to verify.
  if (spec === undefined || family.updateTarget !== "object") return undefined;
  const stored = await session
    .requestAcceptingAny({ path: objectPath, accept: family.media.accept })
    .then((response) => String(response.body ?? ""))
    .catch(() => undefined);
  if (stored === undefined) return "could not read the document back to confirm the change";
  return missingProperty(spec, args, stored);
}
