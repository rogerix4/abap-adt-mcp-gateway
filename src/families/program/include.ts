/**
 * Include (`PROG/I`): a source-only member of the program tree, registered only
 * once its main program carries `INCLUDE <name>.` and has been activated.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { activate, lockObject, readSource, runCheck, unlockObject, writeSource } from "../../adt/lifecycle.js";
import { AdtError } from "../../adt/errors.js";
import { lower, renderCreateBody, type CreateContext, type ObjectFamily } from "../types.js";

const ADTPATH = (path: string) => path;
const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

/**
 * Include (PROG/I): a source-only member of the program tree.
 *
 * Measured: it has its own collection (`/programs/includes`), its own media type
 * and its own root element — posting the program envelope there answers
 * `system expected element ...abapInclude`. Creating it alone leaves it outside
 * the program tree: `D010INC` has no row, the `PROG/I` node never appears in
 * `GetIncludesList`, and the include is dead weight. The row appears only when
 * the main program carries `INCLUDE <name>.` **and** is activated, so the three
 * contract flags are implemented in that order:
 *
 * - `insert_into_main` (default true) — append the statement to the main source.
 * - `activate_main_program` (default true) — activate the main program, which is
 *   what registers the include in `D010INC`.
 * - `skip_program_tree_check` (default false) — run a syntax check on the main
 *   program afterwards and report it.
 */
export function includeFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.programs.includes.v2+xml";
  const envelope = {
    root: "include:abapInclude",
    namespaces: [["include", "http://www.sap.com/adt/programs/includes"] as const],
  };

  /** The main program as the caller named it, or `undefined` when it was not given. */
  const mainOf = (context: CreateContext): string | undefined => {
    const main = context.args["main_program"];
    const value = typeof main === "string" ? main.trim() : "";
    return value.length === 0 ? undefined : value;
  };
  const mainPathOf = (main: string) => `${ADTPATH("/programs/programs")}/${lower(main)}`;

  /**
   * `INCLUDE <name>.` appended at the very end of the main program.
   *
 * Measured on the reference system: putting the statement right after `REPORT`
   * makes the statement that follows it uncompilable — activating the main
   * program then answers `E "Statement is not accessible."` on that line, and the
   * include itself never activates because the program it belongs to does not
   * compile. Appended at the end it compiles and activates cleanly. This is also
   * the layout SAP's own generated programs use: `_TOP` includes carry the
   * declarations, `_F01`-style form includes sit at the bottom.
   */
  const withInclude = (source: string, name: string): string => {
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const statement = `INCLUDE ${lower(name)}.`;
    const present = source.trimEnd();
    return `${present}${eol}${eol}${statement}${eol}`;
  };

  return {
    id: "Include",
    nameParam: "include_name",
    adtType: "PROG/I",
    objectPath: (name) => `/programs/includes/${lower(name)}`,
    collectionPath: "/programs/includes",
    sourcePath: sourceOf,
    media: { accept: media, contentType: media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, "PROG/I"),
    afterCreate: async (session, context, objectPath) => {
      // `CreateInclude` takes an optional `source_code`, so the include exists with
      // its text instead of being an empty shell.
      const source = typeof context.args["source_code"] === "string" ? context.args["source_code"] : undefined;
      if (source !== undefined && source.trim().length > 0) {
        const lock = await lockObject(session, objectPath);
        try {
          await writeSource(session, sourceOf(objectPath), source, {
            lockHandle: lock.lockHandle,
            corrNr: lock.corrNr,
          });
        } finally {
          await unlockObject(session, objectPath, lock.lockHandle);
        }
      }

      if (context.args["insert_into_main"] === false) return { inserted_into_main: false };
      const main = mainOf(context);
      if (main === undefined) {
        return { inserted_into_main: false, insert_note: "main_program is required to register the include" };
      }
      const mainPath = mainPathOf(main);
      const mainSourcePath = sourceOf(mainPath);
      const current = await readSource(session, mainSourcePath, "active");
      const present = new RegExp(`^\\s*INCLUDE\\s+${lower(context.name)}\\s*\\.`, "im").test(current);
      if (present) {
        return { inserted_into_main: true, main_program: main, insert_note: "INCLUDE statement already present" };
      }
      const lock = await lockObject(session, mainPath);
      try {
        await writeSource(session, mainSourcePath, withInclude(current, context.name), {
          lockHandle: lock.lockHandle,
          corrNr: lock.corrNr,
        });
      } finally {
        await unlockObject(session, mainPath, lock.lockHandle);
      }
      return { inserted_into_main: true, main_program: main };
    },
    afterActivate: async (session, context) => {
      const main = mainOf(context);
      if (main === undefined) return {};
      if (context.args["insert_into_main"] === false) {
        return { main_program: main, main_program_activated: false };
      }
      const mainPath = mainPathOf(main);
      if (context.args["activate_main_program"] === false) {
        return {
          main_program: main,
          main_program_activated: false,
          d010inc_note: "not registered until the main program is activated",
        };
      }
      const report = await activate(session, [{ uri: `/sap/bc/adt${mainPath}`, name: main, adtType: "PROG/P" }]);
      const info: Record<string, unknown> = { main_program: main, main_program_activated: report.ok };
      if (!report.ok) info.main_activation_status = report.status;
      if (context.args["skip_program_tree_check"] !== true) {
        const check = await runCheck(session, `/sap/bc/adt${mainPath}`, "active");
        info.program_tree_check = {
          errors: check.errors,
          warnings: check.warnings,
          ...(check.unavailable === undefined ? {} : { unavailable: check.unavailable }),
          messages: check.messages,
        };
      }
      return info;
    },
    // `UpdateInclude.main_program`: an include only compiles inside its program, so
    // the check the caller asked for has to run on the main program.
    afterUpdate: async (session, context) => {
      const main = mainOf(context);
      if (main === undefined) return {};
      const mainPath = mainPathOf(main);
      const check = await runCheck(session, `/sap/bc/adt${mainPath}`, "active");
      return {
        main_program: main,
        program_tree_check: {
          errors: check.errors,
          warnings: check.warnings,
          ...(check.unavailable === undefined ? {} : { unavailable: check.unavailable }),
          messages: check.messages,
        },
      };
    },
    /**
     * `DeleteInclude.remove_from_main` (default true) — drop the `INCLUDE <name>.` statement from the
     * main program, activate it, then let the delete run.
     *
     * Without this the argument was declared and never read: ADT answers
 * `403 其它程序中已索引了程序 X` because the parent still names the include (measured,
     * with and without the flag).
     */
    beforeDelete: async (session, context) => {
      const main = mainOf(context as CreateContext);
      if (main === undefined || context.args["remove_from_main"] === false) return {};
      const mainPath = mainPathOf(main);
      const mainSourcePath = sourceOf(mainPath);
      // Measured: when the parent program is already deleted (a probe deleted the
      // program before its include), reading its source answers 404 and the whole delete failed —
      // although the include itself could still go. Nothing to remove from a program that is gone.
      const current = await readSource(session, mainSourcePath, "active").catch((error: unknown) => {
        if (error instanceof AdtError && error.code === "not-found") return undefined;
        throw error;
      });
      if (current === undefined) {
        return {
          main_program: main,
          removed_from_main: false,
          remove_note: "the main program no longer exists, so there is no INCLUDE statement to remove",
        };
      }
      const pattern = new RegExp(
        `^[ \\t]*INCLUDE[ \\t]+${lower(context.name)}[ \\t]*\\.[ \\t]*\\r?\\n?`,
        "gim",
      );
      if (!pattern.test(current)) {
        return { main_program: main, removed_from_main: false, remove_note: "no INCLUDE statement found" };
      }
      const next = current.replace(pattern, "");
      const lock = await lockObject(session, mainPath);
      try {
        await writeSource(session, mainSourcePath, next, { lockHandle: lock.lockHandle, corrNr: lock.corrNr });
      } finally {
        await unlockObject(session, mainPath, lock.lockHandle);
      }
      const report = await activate(session, [{ uri: `/sap/bc/adt${mainPath}`, name: main, adtType: "PROG/P" }]);
      return { main_program: main, removed_from_main: true, main_program_activated: report.ok };
    },
    update: { kind: "source" },
  };
}
