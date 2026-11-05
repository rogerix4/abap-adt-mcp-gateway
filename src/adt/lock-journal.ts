/**
 * The lock journal: object URL -> lock handle, on disk.
 *
 * A lock handle only exists in the answer that created it. Lose that answer — an
 * error on the same call, a process that restarts, a media type that is wrong —
 * and the object stays locked to this user with no way back except SM12 or the
 * session timing out. Keeping the handle next to nothing else costs one file and
 * turns that dead end into "release it before the next lock".
 *
 * The file lives under `%LOCALAPPDATA%/abap-adt-mcp-gateway/locks-<hash>.json`, hashed
 * from base URL + client + user so two logons of the same system never share a journal.
 * Writes merge with what is already on disk: two processes must not erase each other's
 * handles.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LockJournalOwner {
  readonly baseUrl: string;
  readonly client: string;
  readonly username: string;
}

const digest = (owner: LockJournalOwner): string =>
  createHash("sha1")
    .update(`${owner.baseUrl}|${owner.client}|${owner.username}`)
    .digest("hex")
    .slice(0, 12);

/** `ABAP_ADT_MCP_LOCK_JOURNAL` overrides the file outright (tests, shared sandboxes). */
export function lockJournalPath(owner: LockJournalOwner): string {
  const explicit = process.env["ABAP_ADT_MCP_LOCK_JOURNAL"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const base = process.env["LOCALAPPDATA"] ?? process.env["HOME"] ?? ".";
  return join(base, "abap-adt-mcp-gateway", `locks-${digest(owner)}.json`);
}

export class LockJournal {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  get file(): string {
    return this.#file;
  }

  /** Reads what is on disk; an unreadable or corrupt file counts as empty. */
  read(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key.length > 0 && typeof value === "string" && value.length > 0) out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  handleFor(objectUrl: string): string | undefined {
    const handle = this.read()[objectUrl];
    return handle === undefined || handle.length === 0 ? undefined : handle;
  }

  remember(objectUrl: string, handle: string): void {
    if (objectUrl.length === 0 || handle.length === 0) return;
    const all = this.read();
    all[objectUrl] = handle;
    this.#write(all);
  }

  /** Drops every entry that points at this handle. */
  forget(handle: string): void {
    const all = this.read();
    let changed = false;
    for (const [key, value] of Object.entries(all)) {
      if (value === handle) {
        delete all[key];
        changed = true;
      }
    }
    if (changed) this.#write(all);
  }

  forgetObject(objectUrl: string): void {
    const all = this.read();
    if (all[objectUrl] === undefined) return;
    delete all[objectUrl];
    this.#write(all);
  }

  #write(all: Record<string, string>): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    } catch {
      // A journal that cannot be written must not fail the call it is watching.
    }
  }
}

export function lockJournalFor(owner: LockJournalOwner): LockJournal {
  return new LockJournal(lockJournalPath(owner));
}
