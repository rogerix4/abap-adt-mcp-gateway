/**
 * Undoing a write that SAP accepted but could not compile.
 *
 * `UpdateClass` and `UpdateInterface` are refused by the PUT itself, so nothing is stored. A program
 * source PUT accepts any text, so the rejected draft stays and blocks the next activation — measured
 *: `UpdateProgram` with `THIS IS NOT ABAP` answered `written: true, activated: false`.
 * The active version still holds the last good source, so writing that back over the draft and
 * activating it again leaves the object exactly as it was.
 */
import { lockObject, readSource, unlockObject, writeSource } from "../../adt/lifecycle.js";
import type { AdtSession } from "../../adt/session.js";
import type { ObjectFamily } from "../types.js";

export interface RollbackRequest {
  readonly session: AdtSession;
  readonly family: ObjectFamily;
  readonly objectPath: string;
  readonly sourcePath: string;
  /** Where the body went on the failed write (object URI or source path). */
  readonly target: string;
  readonly accept: string;
  readonly contentType: string;
  readonly transport: string | null;
  /** Re-activate the restored source, so the object is not left with a draft. */
  readonly activate: (source: string) => Promise<unknown>;
}

/** `true` when the previous active source was put back. */
export async function restorePreviousVersion(request: RollbackRequest): Promise<boolean> {
  const { session, family, objectPath, sourcePath, target, accept, contentType, transport } = request;
  if (family.sourcePath === undefined) return false;
  const previous = await readSource(session, sourcePath, "active").catch(() => undefined);
  if (previous === undefined) return false;
  const lock = await lockObject(session, objectPath).catch(() => undefined);
  if (lock === undefined) return false;

  let restored = false;
  try {
    await writeSource(session, target, previous, {
      lockHandle: lock.lockHandle,
      corrNr: lock.corrNr ?? transport,
      ...(family.updateTarget === "object" ? { accept, contentType } : {}),
    });
    restored = true;
  } catch {
    // Restoring is best effort; the caller still reports what activation said.
  } finally {
    await unlockObject(session, objectPath, lock.lockHandle);
  }
  if (restored) await request.activate(previous).catch(() => undefined);
  return restored;
}
