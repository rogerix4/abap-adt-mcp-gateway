/**
 * The tools whose payload has to be computed before it can be sent.
 *
 * The CUA is one document per program, and the bridge only offers "read the
 * document" and "write the document". A GUI status is a row in `STA` plus a
 * title row in `TIT`, so create / patch / delete read the document, change the
 * rows they own, and write it back — that is logic, not a route.
 *
 * Everything else about screens and the CUA is a plain one-call route and stays
 * in `routes.ts`.
 */

import type { ToolRegistry, ToolContext } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import { GatewayError } from "../engine/errors.js";
import { isCuaMissingError, RfcBridge } from "../adt/rfc.js";
import { activate, deleteObject, lockObject, unlockObject } from "../adt/lifecycle.js";

/** Local includes are plain text, both ways. */
const TEXT = "text/plain";

type Args = Record<string, unknown>;
type CuaRow = Record<string, unknown>;

const CUA_TABLES = ["STA", "FUN", "MEN", "MTX", "ACT", "BUT", "PFK", "SET", "DOC", "TIT", "BIV"] as const;
type CuaTable = (typeof CUA_TABLES)[number];

/** Natural key of a row per table — the same keys SE41 merges on. */
const ROW_KEYS: Readonly<Record<CuaTable, (row: CuaRow) => string>> = {
  STA: (row) => `STA:${String(row.CODE ?? "")}`,
  FUN: (row) => `FUN:${String(row.CODE ?? "")}`,
  PFK: (row) => `PFK:${String(row.CODE ?? "")}|${String(row.PFNO ?? "")}`,
  BUT: (row) => `BUT:${String(row.PFK_CODE ?? "")}|${String(row.CODE ?? "")}|${String(row.NO ?? "")}`,
  TIT: (row) => `TIT:${String(row.CODE ?? "")}`,
  MEN: (row) => `MEN:${String(row.CODE ?? "")}|${String(row.NO ?? "")}`,
  MTX: (row) => `MTX:${String(row.CODE ?? "")}`,
  ACT: (row) => `ACT:${String(row.CODE ?? "")}|${String(row.NO ?? "")}`,
  SET: (row) => `SET:${String(row.STATUS ?? "")}|${String(row.FUNCTION ?? "")}`,
  DOC: (row) => `DOC:${String(row.OBJ_TYPE ?? "")}|${String(row.OBJ_CODE ?? "")}`,
  BIV: (row) => `BIV:${String(row.CODE ?? "")}|${String(row.POS ?? "")}`,
};

export interface CuaDocument {
  ADM?: CuaRow;
  [table: string]: unknown;
}

const asRows = (value: unknown): CuaRow[] => (Array.isArray(value) ? (value as CuaRow[]) : []);

const emptyCua = (): CuaDocument => {
  const document: CuaDocument = { ADM: {} };
  for (const table of CUA_TABLES) document[table] = [];
  return document;
};

/** Field-level merge per table: the change wins, untouched fields survive. */
function mergeCua(base: CuaDocument, changes: CuaDocument): CuaDocument {
  const merged: CuaDocument = { ADM: { ...(base.ADM ?? {}), ...(changes.ADM ?? {}) } };
  for (const table of CUA_TABLES) {
    const key = ROW_KEYS[table];
    const rows = new Map<string, CuaRow>();
    for (const row of asRows(base[table])) rows.set(key(row), row);
    for (const row of asRows(changes[table])) {
      const existing = rows.get(key(row));
      rows.set(key(row), existing === undefined ? row : { ...existing, ...row });
    }
    merged[table] = [...rows.values()];
  }
  return merged;
}

/** `N` / `D` / normal dialogs are stored as `D`; only `P` and `C` differ. */
function toStaModal(statusType: unknown): string {
  const value = String(statusType ?? "").trim().toUpperCase();
  if (value === "P" || value === "POPUP") return "P";
  if (value === "C" || value === "CONTEXT") return "C";
  return "D";
}

const arg = (args: Args, name: string): string | undefined => {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * A boolean argument, however the caller spelled it.
 *
 * `arg()` above only returns strings, so `String(arg(args, "activate_on_update") ?? "") === "true"`
 * was always false for a JSON `true` — measured live: `UpdateLocalTestClass
 * {activate_on_update: true}` answered `activated: false` and left the test class inactive,
 * i.e. the flag was declared, documented and ignored. Accept the boolean and the two string
 * spellings; anything else is "not set".
 */
const flag = (args: Args, name: string): boolean => {
  const value = args[name];
  return value === true || value === "true" || value === "X";
};

const required = (args: Args, name: string, tool: string, alternatives: readonly string[] = []): string => {
  const value = arg(args, name) ?? alternatives.map((other) => arg(args, other)).find((found) => found !== undefined);
  if (value === undefined) {
    const accepted = [name, ...alternatives].join('" / "');
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: missing "${accepted}".`);
  }
  return value;
};

const normalizeCua = (result: unknown): CuaDocument =>
  result !== null && typeof result === "object"
    ? { ...emptyCua(), ...(result as CuaDocument) }
    : emptyCua();

/**
 * Reads the CUA document and answers `undefined` when the program has none.
 *
 * `RS_CUA_INTERNAL_FETCH` answers `sy-subrc=1` for a program without a GUI status;
 * that is an empty result, not a broken bridge. Callers that need an empty shell
 * (`CreateGuiStatus`) and callers that report `count: 0` (`GetGuiStatusList`) must
 * not turn it into `UPSTREAM_FAILED`.
 */
async function tryFetchCua(bridge: RfcBridge, program: string): Promise<CuaDocument | undefined> {
  try {
    const { result } = await bridge.dispatch("CUA_FETCH", { program });
    return normalizeCua(result);
  } catch (error) {
    if (isCuaMissingError(error)) return undefined;
    throw error;
  }
}

/** Reads the CUA document; an absent one is an empty shell for create, an error otherwise. */
async function fetchCua(
  bridge: RfcBridge,
  program: string,
  tool: string,
  options: { readonly required?: boolean } = {},
): Promise<CuaDocument> {
  const document = await tryFetchCua(bridge, program);
  if (document !== undefined) return document;
  if (tool === "CreateGuiStatus" || tool === "CreateGuiStatusLow") return emptyCua();
  throw new GatewayError("UPSTREAM_FAILED", `${tool}: ${program} has no GUI status (CUA).`, {
    ...(options.required === true
      ? { nextAction: `check that ${program} is a program with a GUI status and is readable in this system` }
      : { nextAction: "use CreateGuiStatus to create the first status; ReadGuiStatus reports an empty CUA as count 0" }),
  });
}

/** Whether a fetched document actually carries CUA rows (as opposed to `ADM` only). */
const hasCuaRows = (document: CuaDocument): boolean =>
  CUA_TABLES.some((table) => asRows(document[table]).length > 0);

const writeCua = (bridge: RfcBridge, program: string, document: CuaDocument): Promise<unknown> =>
  bridge.dispatch("CUA_WRITE", { program, cua_data: JSON.stringify(document) });

/** The tool names this module implements, so the route table leaves them alone. */
export const BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "CreateGuiStatus",
  "CreateGuiStatusLow",
  "UpdateGuiStatus",
  "UpdateGuiStatusLow",
  "ReadGuiStatus",
  "GetGuiStatusList",
  "PatchGuiStatus",
  "DeleteGuiStatus",
  "DeleteGuiStatusLow",
  "GetTextElement",
  "ReadTextElementsBulk",
  "GetTcodeUsage",
  "GetJobUsage",
  "CreateTextElement",
  "UpdateTextElement",
  "DeleteTextElement",
  "WriteTextElementsBulk",
  "UpdateLocalDefinitions",
  "UpdateLocalMacros",
  "UpdateLocalTypes",
  "UpdateLocalTestClass",
  "UpdateCdsUnitTest",
  "ActivateClassTestClassesLow",
  "DeleteCdsUnitTest",
]);

/**
 * A GUI status is not written from scratch — it is copied from the reference status
 * and then edited (user ruling: "copy STANDARD_FULLSCREEN from SAPLKKBL and
 * change it").
 *
 * A status built from nothing carries no standard function codes (back / exit / cancel
 * / print / help), so the screen it belongs to has no toolbar and no way back. The
 * reference program lives in the always-installed KKB function group.
 */
const REFERENCE_PROGRAM = "SAPLKKBL";
const REFERENCE_STATUS = "STANDARD_FULLSCREEN";
/**
 * Programs tried in order when the bridge cannot read the preferred one's CUA.
 *
 * Measured: `GetGuiStatusList` lists 40 statuses for SAPLKKBL, but the CUA
 * document the bridge reads for it comes back **empty**, so the copy-from-reference step failed on
a * a release where the list and the document disagree. The candidates are the always-installed list
 * ALV / selection-screen / message-class programs.
 */
const REFERENCE_CANDIDATES: readonly string[] = [REFERENCE_PROGRAM, "SAPMV45A", "SAPLSPO1", "SAPMSCC0", "SAPLALV_GRID"];

/**
 * Narrows a whole reference CUA (which has ~40 statuses) to the one status being
 * created.
 *
 * Keeps one `STA` row, the reference status's `SET` rows renamed to the new code, the
 * `FUN` rows those functions refer to, and the `PFK`/`BUT` rows of the reference's
 * function-key code. `TIT` holds 3-character title texts rather than statuses, so it
 * stays as-is; the description is `STA.INT_NOTE`, not a `TIT` row keyed by the status
 * name. Returns `undefined` when the reference document has no such status.
 */
export function narrowReferenceStatus(
  referenceDocument: CuaDocument,
  status: string,
  description: string | undefined,
  statusType: unknown,
  referenceCode: string = REFERENCE_STATUS,
): CuaDocument | undefined {
  const wanted = referenceCode.toUpperCase();
  const source = asRows(referenceDocument.STA).find(
    (row) => String(row.CODE ?? "").toUpperCase() === wanted,
  );
  if (source === undefined) return undefined;

  const refSet = asRows(referenceDocument.SET).filter(
    (setRow) => String(setRow.STATUS ?? "").toUpperCase() === wanted,
  );
  const functions = new Set(refSet.map((setRow) => String(setRow.FUNCTION ?? "").trim()));
  const pfkCode = String(source.PFKCODE ?? "").trim();

  const row: CuaRow = { ...source, CODE: status, MODAL: toStaModal(statusType) };
  if (description !== undefined) row.INT_NOTE = description.slice(0, 60);

  const document: CuaDocument = { ...referenceDocument, STA: [row] };
  document.SET = refSet.map((setRow) => ({ ...setRow, STATUS: status }));
  if (functions.size > 0) {
    document.FUN = asRows(referenceDocument.FUN).filter((funRow) =>
      functions.has(String(funRow.CODE ?? "").trim()),
    );
  }
  if (pfkCode.length > 0) {
    document.PFK = asRows(referenceDocument.PFK).filter(
      (pfkRow) => String(pfkRow.PFK_CODE ?? "").trim() === pfkCode,
    );
    document.BUT = asRows(referenceDocument.BUT).filter(
      (butRow) => String(butRow.PFK_CODE ?? "").trim() === pfkCode,
    );
  }
  return document;
}

async function createStatus(args: Args, ctx: ToolContext, runtime: GatewayRuntime, tool: string): Promise<unknown> {
  const program = required(args, "program_name", tool).toUpperCase();
  const status = required(args, "status_name", tool).toUpperCase();
  const description = arg(args, "description");
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);

  // Base: the whole reference CUA (it brings the function codes the status refers to).
  let document: CuaDocument | undefined;
  let referenceProgram = REFERENCE_PROGRAM;
  for (const candidate of REFERENCE_CANDIDATES) {
    const found = await tryFetchCua(bridge, candidate);
    if (found !== undefined && hasCuaRows(found)) {
      document = found;
      referenceProgram = candidate;
      break;
    }
  }
  if (document === undefined) {
    throw new GatewayError(
      "UPSTREAM_FAILED",
      `${tool}: no readable reference CUA among ${REFERENCE_CANDIDATES.join(", ")}; the bridge returned an empty document for each.`,
      {
        nextAction:
          "pass a program the bridge can read (GuiStatus of a Z program with a status) or create the status with UpdateGuiStatus from a known CUA document",
      },
    );
  }
  const reference = asRows(document.STA).find((row) => String(row.CODE ?? "").toUpperCase() === REFERENCE_STATUS);
  // Measured: `GetGuiStatusList SAPLKKBL` lists STANDARD_FULLSCREEN, but the
  // CUA document the bridge reads does not contain it — so a hard failure here made the tool
  // unusable on a release where the reference moved. Take the named status when it is there, and
  // otherwise a status this document really has, preferring one that carries function keys (that is
  // what the copy is for: back / exit / cancel / print / help).
  const referenceCode =
    reference !== undefined
      ? REFERENCE_STATUS
      : (asRows(document.STA).find((row) => String(row.PFKCODE ?? "").trim().length > 0)?.CODE ??
        asRows(document.STA)[0]?.CODE);
  if (referenceCode === undefined) {
    throw new GatewayError("UPSTREAM_FAILED", `${tool}: ${REFERENCE_PROGRAM} returned no GUI status at all.`, {
      nextAction: `read ${REFERENCE_PROGRAM} with GetGuiStatus to see which statuses exist`,
    });
  }

  // Create builds the *first* status. A program that already has a CUA is changed
  // with UpdateGuiStatus / PatchGuiStatus; merging the whole reference into it is what
  // used to leave 40 unrelated SAPLKKBL statuses behind.
  const own = await tryFetchCua(bridge, program);
  if (own !== undefined && hasCuaRows(own)) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: ${program} already has a GUI status definition.`, {
      nextAction: "use UpdateGuiStatus to replace the document or PatchGuiStatus to merge rows",
    });
  }

  const narrowed = narrowReferenceStatus(document, status, description, args.status_type, String(referenceCode));
  if (narrowed === undefined) {
    throw new GatewayError("UPSTREAM_FAILED", `${tool}: ${REFERENCE_PROGRAM} has no status ${String(referenceCode)}.`, {
      nextAction: `read ${REFERENCE_PROGRAM} with GetGuiStatus to see which statuses exist`,
    });
  }
  document = narrowed;

  await writeCua(bridge, program, document);
  return {
    success: true,
    transport: "rfc",
    program_name: program,
    status_name: status,
    created: true,
    copied_from: `${referenceProgram}/${String(referenceCode)}`,
    statuses: asRows(document.STA).length,
    set_rows: asRows(document.SET).length,
    function_codes: asRows(document.FUN).length,
    activated: true,
  };
}

/** Accepts the schema's object or JSON string; unwraps a `{ cua_data: ... }` envelope. */
function parseCuaDocument(raw: unknown, tool: string): CuaDocument {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: "cua_data" is not valid JSON.`);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: "cua_data" must be a CUA document object.`);
  }
  const record = value as Record<string, unknown>;
  if (record["cua_data"] !== undefined) return parseCuaDocument(record["cua_data"], tool);
  if (Array.isArray(record["statuses"])) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      `${tool}: "cua_data" is the compact statuses view, not a writable CUA document.`,
      { nextAction: "read the full document with ReadGuiStatus and send that back (ADM / STA / FUN / ...)" },
    );
  }
  return { ...emptyCua(), ...(value as CuaDocument) };
}

/**
 * Full-document replace, straight into `CUA_WRITE`.
 *
 * The old route ran `CUA_FETCH` first, which both refused the first CUA (sy-subrc=1)
 * and sent the parsed object to an ABAP `TYPE string` parameter. `CUA_WRITE` is a
 * replace: no fetch, no merge, and the JSON string is built here once.
 */
async function updateStatus(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
): Promise<unknown> {
  const program = required(args, "program_name", tool).toUpperCase();
  const raw = args["cua_data"];
  if (raw === undefined || raw === null) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: missing "cua_data".`);
  }
  const document = parseCuaDocument(raw, tool);
  if (asRows(document.STA).length === 0) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: refusing to write a CUA with no STA rows.`, {
      nextAction: "use DeleteGuiStatus to remove one status; a full replace must keep at least one status",
    });
  }

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);
  await writeCua(bridge, program, document);
  return {
    success: true,
    transport: "rfc",
    program_name: program,
    replaced: true,
    statuses: asRows(document.STA).length,
    ...(arg(args, "transport_request") === undefined
      ? {}
      : { transport_request: arg(args, "transport_request") }),
    activated: true,
  };
}

/** `ReadGuiStatus` (full document) and `GetGuiStatusList` (status list, empty CUA = count 0). */
async function readCua(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
): Promise<unknown> {
  const program = required(args, "program_name", tool).toUpperCase();
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), false);
  const bridge = new RfcBridge(resolved.session);
  const document = (await tryFetchCua(bridge, program)) ?? emptyCua();

  if (tool === "GetGuiStatusList") {
    const statuses = asRows(document.STA).map((row) => ({
      code: String(row.CODE ?? "").trim(),
      type: String(row.MODAL ?? "").trim(),
      description: String(row.INT_NOTE ?? "").trim(),
    }));
    return {
      success: true,
      transport: "rfc",
      program_name: program,
      count: statuses.length,
      statuses,
      ...(statuses.length === 0 ? { note: "the program has no GUI status (CUA); CreateGuiStatus can create the first one" } : {}),
      session_id: resolved.sessionId,
    };
  }

  return {
    success: true,
    transport: "rfc",
    program_name: program,
    ...document,
    count: asRows(document.STA).length,
    ...(asRows(document.STA).length === 0 ? { note: "the program has no GUI status (CUA)" } : {}),
    session_id: resolved.sessionId,
  };
}

async function patchStatus(args: Args, ctx: ToolContext, runtime: GatewayRuntime): Promise<unknown> {
  const tool = "PatchGuiStatus";
  const program = required(args, "program_name", tool).toUpperCase();
  // The schema says object (a JSON string is also accepted), so do not go through
  // `arg`, which only returns non-empty strings.
  const raw = args["changes"];
  if (raw === undefined || raw === null) throw new GatewayError("INVALID_ARGUMENT", `${tool}: missing "changes".`);

  let changes: CuaDocument;
  try {
    changes = (typeof raw === "string" ? JSON.parse(raw) : raw) as CuaDocument;
  } catch {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: "changes" is not valid JSON.`);
  }

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);
  const document = await fetchCua(bridge, program, tool);
  await writeCua(bridge, program, mergeCua(document, changes));
  return {
    success: true,
    transport: "rfc",
    program_name: program,
    patched: Object.keys(changes),
    // Measured live: a patched `FUN` row really landed (it is in the full document),
    // so `CUA_WRITE` writes the active version and the schema's `activate` has nothing to do.
    // Say that instead of echoing the flag: a caller who passed `activate: true` used to see the
    // flag vanish from the answer and could not tell whether the rows were live.
    activated: true,
    note: "CUA_WRITE has no inactive stage: the merged rows are written active.",
  };
}

/**
 * Remove one status from the program's CUA and write the document back.
 *
 * `DeleteGuiStatus` locks the program itself; `DeleteGuiStatusLow` was handed a
 * handle by `LockGuiStatusLow` and must not release it.
 */
async function removeStatus(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
  lockHandle: string | undefined,
): Promise<unknown> {
  const program = required(args, "program_name", tool).toUpperCase();
  const status = required(args, "status_name", tool).toUpperCase();

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);
  const document = await fetchCua(bridge, program, tool);

  const before = asRows(document.STA).length;
  const keep = (row: CuaRow): boolean => String(row.CODE ?? "") !== status;
  document.STA = asRows(document.STA).filter(keep);
  document.TIT = asRows(document.TIT).filter(keep);
  document.SET = asRows(document.SET).filter((row) => String(row.STATUS ?? "") !== status);
  if (asRows(document.STA).length === before) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: GUI status ${status} does not exist in ${program}.`);
  }

  await writeCua(bridge, program, document);
  return {
    success: true,
    transport: "rfc",
    program_name: program,
    status_name: status,
    deleted: true,
    ...(lockHandle === undefined ? {} : { lock_handle: lockHandle, lock_kept: true }),
  };
}

async function deleteStatus(args: Args, ctx: ToolContext, runtime: GatewayRuntime): Promise<unknown> {
  return removeStatus(args, ctx, runtime, "DeleteGuiStatus", undefined);
}

/** One text-pool row, in the shape the textpool function module exchanges. */
interface TextPoolRow {
  ID: string;
  KEY: string;
  ENTRY: string;
  LENGTH: number;
}

const MAX_ENTRY_LEN = 132;

/** `R` rows are keyed by the program name; everything else by its own key. */
function toPoolRow(type: string, key: string | undefined, text: string, program: string): TextPoolRow {
  void program;
  const id = type.trim().toUpperCase();
  // The program title (`R`) has no business key — there is exactly one per program.
  const rowKey = (key ?? "").trim().slice(0, 8);
  return { ID: id, KEY: rowKey, ENTRY: text, LENGTH: text.length };
}

const poolKey = (row: TextPoolRow): string => {
  const id = row.ID.toUpperCase();
  // Measured: the read lists the title with an empty KEY while the update
  // compared it against the first eight characters of the program name, so
  // `UpdateTextElement` answered "R/<program> does not exist" for a row it had just
  // returned. The title is identified by its ID alone.
  if (id === "R") return "R";
  return `${id}::${row.KEY.trim().toUpperCase()}`;
};

const asPoolRows = (value: unknown): TextPoolRow[] =>
  (Array.isArray(value) ? value : []).map((entry) => {
    const row = entry as Record<string, unknown>;
    const text = String(row.ENTRY ?? row.entry ?? "");
    return {
      ID: String(row.ID ?? row.id ?? "").toUpperCase(),
      KEY: String(row.KEY ?? row.key ?? ""),
      ENTRY: text,
      LENGTH: Number(row.LENGTH ?? row.length ?? text.length),
    };
  });

async function readPool(bridge: RfcBridge, program: string, language: string): Promise<TextPoolRow[]> {
  const { result } = await bridge.textpool("READ", { program, language });
  return asPoolRows(result);
}

/**
 * Writes the pool back.
 *
 * `WRITE_INACTIVE` is not implemented by every release of the bridge module, so
 * a staging request falls back to the active write and says so.
 */
async function writePool(
  bridge: RfcBridge,
  program: string,
  language: string,
  rows: readonly TextPoolRow[],
  activate: boolean,
): Promise<{ action: string; fellBack: boolean }> {
  const params = { program, language, textpool_json: JSON.stringify(rows) };  if (!activate) {
    try {
      await bridge.textpool("WRITE_INACTIVE", params);
      return { action: "write_inactive", fellBack: false };
    } catch {
      // Fall through: only the active write is available here.
    }
  }
  await bridge.textpool("WRITE", params);
  return { action: "write_active", fellBack: !activate };
}

async function writeTextElements(args: Args, ctx: ToolContext, runtime: GatewayRuntime, tool: string): Promise<unknown> {
  const program = required(args, "program_name", tool).toUpperCase();
  const entries = args["text_elements"];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: "text_elements" must be a non-empty array.`);
  }

  const caller: TextPoolRow[] = [];
  const perType: Record<string, number> = {};
  for (const [index, raw] of entries.entries()) {
    const entry = raw as Record<string, unknown>;
    const type = String(entry.type ?? "").toUpperCase();
    const text = entry.text;
    if (!["R", "I", "S", "H"].includes(type)) {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: text_elements[${index}] has unsupported type "${type}".`);
    }
    if (typeof text !== "string") {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: text_elements[${index}] "text" must be a string.`);
    }
    if (text.length > MAX_ENTRY_LEN) {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: text_elements[${index}] exceeds ${MAX_ENTRY_LEN} chars.`);
    }
    const key = entry.key;
    if (type !== "R" && (typeof key !== "string" || key.trim() === "")) {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: text_elements[${index}] type "${type}" requires "key".`);
    }
    if (type === "S" && typeof key === "string" && key.trim().length > 8) {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: selection key "${key}" exceeds 8 chars.`);
    }
    perType[type] = (perType[type] ?? 0) + 1;
    caller.push(toPoolRow(type, typeof key === "string" ? key : undefined, text, program));
  }
  if ((perType.R ?? 0) > 1) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: only one R-type entry is allowed per program.`);
  }

  const language = (arg(args, "language") ?? "").toUpperCase();
  const replace = args["replace_existing"] !== false;
  const activate = args["activate"] === true;

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);

  let rows = caller;
  const steps: string[] = [];
  if (!replace) {
    const existing = await readPool(bridge, program, language);
    const merged = new Map<string, TextPoolRow>();
    for (const row of existing) merged.set(poolKey(row), row);
    for (const row of caller) merged.set(poolKey(row), row);
    rows = [...merged.values()];
    steps.push("read_existing_for_merge");
  }

  const written = await writePool(bridge, program, language, rows, activate);
  steps.push(written.action);

  return {
    success: true,
    transport: "rfc",
    program_name: program,
    language: language || null,
    total_entries: caller.length,
    total_rows_written: rows.length,
    per_type: perType,
    replace_existing: replace,
    // Measured live: `WriteTextElementsBulk {activate: false}` answered
    // `activate: false` **and** a note saying the rows were written active — the field said the
    // opposite of the outcome. `activate` now reports what happened; the request is kept beside it.
    activate: written.fellBack ? true : activate,
    ...(written.fellBack ? { activate_requested: activate, activated_by_bridge: true } : {}),
    rfc_action: written.action,
    steps_completed: steps,
    ...(written.fellBack
      ? { note: "WRITE_INACTIVE is not supported by this bridge; the rows were written active." }
      : {}),
  };
}

/** Create / update / delete touch one row of the pool and write it back. */
async function changeTextElement(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
  mode: "create" | "update" | "delete",
): Promise<unknown> {
  const program = required(args, "program_name", tool).toUpperCase();
  const type = required(args, "text_type", tool).toUpperCase();
  const language = (arg(args, "language") ?? "").toUpperCase();
  const activate = args["activate"] === true;

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const bridge = new RfcBridge(resolved.session);
  const rows = await readPool(bridge, program, language);

  // The contract lists `key` as optional on create, and SAP's own editor takes the next free
  // number for you. Requiring it here answered `missing "key"` to a caller that sent exactly what
  // the schema asked for (measured live ). Update/delete still need it: they have to
  // name the row they change.
  let key = arg(args, "key");
  if (key === undefined && type !== "R") {
    if (mode !== "create") {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: missing "key".`, {
        nextAction: `Pass the key the row has in the pool (GetTextElement lists them).`,
      });
    }
    const used = rows
      .filter((row) => row.ID === type)
      .map((row) => Number(row.KEY))
      .filter((value) => Number.isFinite(value) && value > 0);
    const next = used.length === 0 ? 1 : Math.max(...used) + 1;
    key = String(next).padStart(3, "0");
  }

  const target = toPoolRow(type, key, "", program);
  const index = rows.findIndex((row) => poolKey(row) === poolKey(target));

  if (mode === "create" && index >= 0) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: text element ${type}/${target.KEY} already exists.`, {
      nextAction: "use UpdateTextElement",
    });
  }
  if (mode !== "create" && index < 0) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: text element ${type}/${target.KEY} does not exist.`);
  }

  if (mode === "delete") {
    rows.splice(index, 1);
  } else {
    const text = required(args, "text", tool);
    if (text.length > MAX_ENTRY_LEN) {
      throw new GatewayError("INVALID_ARGUMENT", `${tool}: "text" exceeds ${MAX_ENTRY_LEN} chars.`);
    }
    const row = toPoolRow(type, key, text, program);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  }

  const written = await writePool(bridge, program, language, rows, activate);
  return {
    success: true,
    transport: "rfc",
    program_name: program,
    text_type: type,
    key: target.KEY,
    [mode === "delete" ? "deleted" : mode === "create" ? "created" : "updated"]: true,
    rfc_action: written.action,
    ...(written.fellBack
      ? { note: "WRITE_INACTIVE is not supported by this bridge; the rows were written active." }
      : {}),
  };
}

/**
 * Reading the text pool.
 *
 * ADT has no text-element resource on this stack (`/discovery` lists no collection
 * under `/textelements`, and the path answers 404 "no suitable resource"), so this tool
 * has to read it the only way that works here: through the textpool function module.
 */async function readTextElements(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
): Promise<unknown> {
  const program = required(args, "program_name", tool).toUpperCase();
  const language = (arg(args, "language") ?? "").toUpperCase();
  const type = arg(args, "text_type")?.toUpperCase();
  const key = arg(args, "key")?.toUpperCase();

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), false);
  const rows = await readPool(new RfcBridge(resolved.session), program, language);
  const selected = rows.filter(
    (row) =>
      (type === undefined || row.ID.toUpperCase() === type) &&
      (key === undefined || row.KEY.trim().toUpperCase() === key),
  );
  const entries = selected.map((row) => ({ type: row.ID, key: row.KEY.trim(), text: row.ENTRY }));
  const ofType = (...ids: readonly string[]): typeof entries =>
    entries.filter((entry) => ids.includes(entry.type.toUpperCase()));
  return {
    success: true,
    transport: "rfc",
    program_name: program,
    language: language === "" ? "(bridge default)" : language,
    match: tool === "GetTextElement" && key !== undefined ? selected[0] ?? null : undefined,
    // The description promises a partition by element type (R / I / S / H); the flat
    // list stays for callers that iterate over everything.
    symbols: ofType("I"),
    selection_texts: ofType("S"),
    program_title: ofType("R"),
    list_headings: ofType("H"),
    text_elements: entries,
    count: selected.length,
  };
}

/**
 * Workload: were these transactions / programs actually used?
 *
 * No ADT resource answers this — the numbers come from the workload aggregates, which
 * only the `ZMCP_WL_*` bridges read (`TBTCO` / `TBTCP` for jobs, the ST03N monthly
 * aggregates for transactions). The modules are plain ABAP; they are imported by
 * `tools/scripts/import-abap-bridges.mjs` and smoke-tested there. The answer is one
 * boolean per name plus `coverage` — the months that actually hold data — because
 * "false" over three months of data is not the same statement as over twelve.
 */
async function workloadUsage(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
  config: { readonly fm: string; readonly listArg: string; readonly param: string; readonly label: string },
): Promise<unknown> {
  const rawList = args[config.listArg];
  const list: unknown[] = Array.isArray(rawList) ? rawList : [];
  const names = list.map((entry) => String(entry).trim().toUpperCase()).filter((entry) => entry.length > 0);
  if (names.length === 0) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: "${config.listArg}" must list at least one ${config.label}.`);
  }
  const rawMonths = Number(args["months"] ?? 12);
  const months = Number.isFinite(rawMonths) ? Math.min(36, Math.max(1, Math.trunc(rawMonths))) : 12;
  const destination = arg(args, "destination") ?? "";

  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), false);
  const raw = await new RfcBridge(resolved.session).call(config.fm, {
    [config.param]: names.join(","),
    IV_MONTHS: String(months),
    ...(destination === "" ? {} : { IV_RFCDEST: destination }),
  });
  const subrc = Number(raw.EV_SUBRC ?? 0);
  // subrc 4 is an answer, not a failure: "no workload data in the requested window".
  // The bridge still returns the `{"<name>":false}` map and coverage 0, which is what
  // the caller needs to judge (false over zero months is not "unused").
  if (subrc !== 0 && subrc !== 4) {
    throw new GatewayError("UPSTREAM_FAILED", `${tool}: ${config.fm} answered subrc=${subrc} ${raw.EV_MESSAGE ?? ""}`, {
      nextAction: "import the bridge with tools/scripts/import-abap-bridges.mjs and check it is active",
    });
  }
  let usage: unknown = raw.EV_RESULT ?? "";
  try {
    usage = JSON.parse(String(raw.EV_RESULT ?? ""));
  } catch {
    /* keep the raw text */
  }
  return {
    success: true,
    transport: "rfc",
    system_id: raw.EV_SYSID,
    months,
    ...(raw.EV_COVERAGE === undefined ? {} : { coverage_months: Number(raw.EV_COVERAGE) }),
    ...(raw.EV_OLDEST === undefined ? {} : { data_since: raw.EV_OLDEST }),
    ...(subrc === 4 ? { warning: raw.EV_MESSAGE ?? "no workload data in the requested window" } : {}),
    usage,
  };
}

/**
 * Writing a class's local include needs a lock on that very include, and ADT wants
 * the handle in the query — so the write is lock / PUT / unlock, not one request.
 * `UpdateCdsUnitTest` writes the same `testclasses` include under a different name.
 */
const LOCAL_INCLUDE_WRITES: Readonly<Record<string, readonly [segment: string, codeArg: string]>> = {
  UpdateLocalDefinitions: ["definitions", "definitions_code"],
  UpdateLocalMacros: ["macros", "macros_code"],
  // ADT has no `includes/types`: local types go to the implementations include
  // (`includes/types` answers "URI-Mapping cannot be performed due to invalid URI").
  UpdateLocalTypes: ["implementations", "local_types_code"],
  UpdateLocalTestClass: ["testclasses", "test_class_code"],
  UpdateCdsUnitTest: ["testclasses", "test_class_source"],
};

async function writeLocalInclude(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
): Promise<unknown> {
  const target = LOCAL_INCLUDE_WRITES[tool];
  if (target === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool} is not a local-include write.`);
  }
  const [segment, codeArg] = target;
  const className = required(args, "class_name", tool);
  // The contract spells it `local_types_code`; an earlier build looked for `types_code`,
  // so the tool answered `missing "types_code"` for its own documented argument.
  const source = required(args, codeArg, tool, codeArg === "local_types_code" ? ["types_code"] : []);
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const include = `/oo/classes/${encodeURIComponent(className.toLowerCase())}/includes/${segment}`;

  const lock = await lockObject(resolved.session, include);
  let status: number;
  try {
    const response = await resolved.session.request({
      method: "PUT",
      path: `${include}?lockHandle=${encodeURIComponent(lock.lockHandle)}`,
      accept: TEXT,
      contentType: TEXT,
      body: source,
    });
    status = response.status;
  } finally {
    await unlockObject(resolved.session, include, lock.lockHandle);
  }
  // `activate_on_update` is declared on the four `UpdateLocal*` verbs but was never read, so a
  // caller could not get the include into the active version without a second tool call (the
  // write only touches the inactive one). Measured: `UpdateCdsUnitTest` answers
  // `activated: false`, and the tests it wrote are not what `RunUnitTest` runs.
  const activation = flag(args, "activate_on_update")
    ? await activate(resolved.session, [
          {
            uri: `/sap/bc/adt/oo/classes/${encodeURIComponent(className.toLowerCase())}`,
            name: className.toUpperCase(),
            adtType: "CLAS/OC",
          },
        ])
      : undefined;
  return {
    success: true,
    class_name: className,
    include: segment,
    status,
    characters: source.length,
    activated: activation === undefined ? false : activation.ok,
    ...(activation === undefined
      ? {}
      : { activation: { status: activation.status, errors: activation.errors, warnings: activation.warnings } }),
    ...(lock.corrNr === null ? {} : { corr_nr: lock.corrNr }),
  };
}

/**
 * Clearing a class's local include.
 *
 * Measured: `DELETE /oo/classes/<c>/includes/definitions` answers **405**
 * "Resource controller does not support method DELETE" — there is no delete for an
 * include. What empties it is a PUT of an empty source under a lock, which is exactly what
 * the editor does when the last line is removed; the class is then activated so the empty
 * include is what SAP holds.
 */
const LOCAL_INCLUDE_CLEARS: Readonly<Record<string, string>> = {
  DeleteLocalDefinitions: "definitions",
  DeleteLocalMacros: "macros",
  DeleteLocalTestClass: "testclasses",
  DeleteLocalTypes: "implementations",
};

async function clearLocalInclude(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
): Promise<unknown> {
  const segment = LOCAL_INCLUDE_CLEARS[tool];
  if (segment === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool} is not a local-include clear.`);
  }
  const className = required(args, "class_name", tool);
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const include = `/oo/classes/${encodeURIComponent(className.toLowerCase())}/includes/${segment}`;

  const lock = await lockObject(resolved.session, include);
  let status = 0;
  try {
    const response = await resolved.session.request({
      method: "PUT",
      path: `${include}?lockHandle=${encodeURIComponent(lock.lockHandle)}`,
      accept: TEXT,
      contentType: TEXT,
      body: "\n",
    });
    status = response.status;
  } finally {
    await unlockObject(resolved.session, include, lock.lockHandle);
  }

  // `activate_on_delete` defaults to true: an include the caller deleted should not come
  // back on the next activation.
  let activated: boolean | undefined;
  if (args["activate_on_delete"] !== false) {
    const report = await activate(resolved.session, [
      {
        uri: `/sap/bc/adt/oo/classes/${encodeURIComponent(className.toLowerCase())}`,
        name: className.toUpperCase(),
        adtType: "CLAS/OC",
      },
    ]);
    activated = report.ok;
    if (!report.ok) {
      return { success: false, class_name: className, include: segment, status, activated, detail: report.status };
    }
  }
  return {
    success: true,
    class_name: className,
    include: segment,
    status,
    cleared: true,
    ...(activated === undefined ? {} : { activated }),
  };
}

/** Activating "the test classes of a class" is an activation of that class. */
async function activateClassTestClasses(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
): Promise<unknown> {
  const className = required(args, "class_name", tool);
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const report = await activate(resolved.session, [
    {
      uri: `/sap/bc/adt/oo/classes/${encodeURIComponent(className.toLowerCase())}`,
      name: className.toUpperCase(),
      adtType: "CLAS/OC",
    },
  ]);
  return { success: report.ok, class_name: className, status: report.status, errors: report.errors, warnings: report.warnings };
}

/** `DeleteCdsUnitTest` removes the generated class, so it deletes like one. */
async function deleteCdsUnitTest(
  args: Args,
  ctx: ToolContext,
  runtime: GatewayRuntime,
  tool: string,
): Promise<unknown> {
  const className = required(args, "class_name", tool);
  const resolved = runtime.resolve(ctx.system, arg(args, "session_id"), true);
  const result = await deleteObject(
    resolved.session,
    `/oo/classes/${encodeURIComponent(className.toLowerCase())}`,
  );
  return {
    success: result.deleted,
    class_name: className,
    deleted: result.deleted,
    status: result.status,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

export function registerBridgeTools(registry: ToolRegistry, runtime: GatewayRuntime): void {
  const register = (name: string, handler: (args: Args, ctx: ToolContext) => Promise<unknown>): void => {
    if (registry.has(name)) registry.register(name, handler);
  };
  register("CreateGuiStatus", (args, ctx) => createStatus(args, ctx, runtime, "CreateGuiStatus"));
  register("CreateGuiStatusLow", (args, ctx) => createStatus(args, ctx, runtime, "CreateGuiStatusLow"));
  register("UpdateGuiStatus", (args, ctx) => updateStatus(args, ctx, runtime, "UpdateGuiStatus"));
  register("UpdateGuiStatusLow", (args, ctx) => updateStatus(args, ctx, runtime, "UpdateGuiStatusLow"));
  register("ReadGuiStatus", (args, ctx) => readCua(args, ctx, runtime, "ReadGuiStatus"));
  register("GetGuiStatusList", (args, ctx) => readCua(args, ctx, runtime, "GetGuiStatusList"));
  register("PatchGuiStatus", (args, ctx) => patchStatus(args, ctx, runtime));
  register("DeleteGuiStatus", (args, ctx) => deleteStatus(args, ctx, runtime));
  register("DeleteGuiStatusLow", (args, ctx) =>
    removeStatus(args, ctx, runtime, "DeleteGuiStatusLow", required(args, "lock_handle", "DeleteGuiStatusLow")),
  );
  register("WriteTextElementsBulk", (args, ctx) => writeTextElements(args, ctx, runtime, "WriteTextElementsBulk"));
  register("GetTextElement", (args, ctx) => readTextElements(args, ctx, runtime, "GetTextElement"));
  register("ReadTextElementsBulk", (args, ctx) => readTextElements(args, ctx, runtime, "ReadTextElementsBulk"));
  register("GetTcodeUsage", (args, ctx) =>
    workloadUsage(args, ctx, runtime, "GetTcodeUsage", {
      fm: "ZMCP_WL_TCODE_USAGE",
      listArg: "tcodes",
      param: "IV_TCODES",
      label: "transaction",
    }),
  );
  register("GetJobUsage", (args, ctx) =>
    workloadUsage(args, ctx, runtime, "GetJobUsage", {
      fm: "ZMCP_WL_JOB_USAGE",
      listArg: "programs",
      param: "IV_PROGRAMS",
      label: "program",
    }),
  );
  register("CreateTextElement", (args, ctx) => changeTextElement(args, ctx, runtime, "CreateTextElement", "create"));
  register("UpdateTextElement", (args, ctx) => changeTextElement(args, ctx, runtime, "UpdateTextElement", "update"));
  register("DeleteTextElement", (args, ctx) => changeTextElement(args, ctx, runtime, "DeleteTextElement", "delete"));
  for (const tool of Object.keys(LOCAL_INCLUDE_WRITES)) {
    register(tool, (args, ctx) => writeLocalInclude(args, ctx, runtime, tool));
  }
  for (const tool of Object.keys(LOCAL_INCLUDE_CLEARS)) {
    register(tool, (args, ctx) => clearLocalInclude(args, ctx, runtime, tool));
  }
  register("ActivateClassTestClassesLow", (args, ctx) =>
    activateClassTestClasses(args, ctx, runtime, "ActivateClassTestClassesLow"),
  );
  register("DeleteCdsUnitTest", (args, ctx) => deleteCdsUnitTest(args, ctx, runtime, "DeleteCdsUnitTest"));

  // A unit-test run is a read-only result: ADT offers POST (start), GET (status) and GET
  // (result) on `/abapunit/runs`, and answers 405 to PUT and DELETE — measured.
  register("UpdateUnitTest", async () => {
    throw new GatewayError(
      "NOT_IMPLEMENTED",
      "A unit test run cannot be updated: ADT has no PUT on /abapunit/runs (HTTP 405).",
      { nextAction: "Start a new run with CreateUnitTest / RunUnitTest and read it with GetUnitTest." },
    );
  });
  register("DeleteUnitTest", async () => {
    throw new GatewayError(
      "NOT_IMPLEMENTED",
      "A unit test run cannot be deleted: ADT has no DELETE on /abapunit/runs (HTTP 405).",
      { nextAction: "Runs expire on their own; to remove the test code, clear the test-class include." },
    );
  });

  // `CreateCdsUnitTest` creates the test class for a CDS view: the POST that used to go out
  // carried an empty body and SAP answered "the system expected element '{…oo/classes}abapClass'".
  register("CreateCdsUnitTest", async (args, ctx) => {
    const className = required(args, "class_name", "CreateCdsUnitTest");
    const packageName = required(args, "package_name", "CreateCdsUnitTest");
    const view = required(args, "cds_view_name", "CreateCdsUnitTest");
    if (!registry.has("CreateClass")) {
      throw new GatewayError("NOT_IMPLEMENTED", "CreateCdsUnitTest needs CreateClass in this build.");
    }
    const created = (await registry.call(
      "CreateClass",
      {
        class_name: className,
        description: arg(args, "description") ?? `Unit test for ${view}`.slice(0, 60),
        package_name: packageName,
        ...(arg(args, "transport_request") === undefined ? {} : { transport_request: arg(args, "transport_request") }),
      },
      ctx,
    )) as Record<string, unknown>;
    return {
      ...created,
      cds_view_name: view,
      next: "write the tests with UpdateCdsUnitTest (test_class_source), then run them with RunUnitTest",
    };
  });
}
