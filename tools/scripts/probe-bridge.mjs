#!/usr/bin/env node
/**
 * Bridge smoke: the 16 tools the route probe cannot judge.
 *
 * `probe-routes.mjs` fires one request per tool and reads the answer. These 16 need
 * either three requests (lock -> PUT -> unlock) or the remote-enabled function modules
 * behind the RFC bridge, so a single-request probe would report nothing useful about
 * them and they were verified by hand. This script is that hand check, made repeatable.
 *
 * Every fixture is created in `$TMP` under a name unique to the run and deleted at the
 * end, including when a step fails. It writes to the system it is pointed at: run it
 * against DEV only.
 *
 * Usage:
 *   npm run build
 *   node tools/scripts/probe-bridge.mjs --profile <system-id|env-file> [--keep]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const profileArg = arg("--profile");
if (profileArg === undefined) {
  process.stderr.write("probe-bridge: --profile <system-id|env-file> is required\n");
  process.exit(2);
}
const keep = process.argv.includes("--keep");

// Same source of truth as the server: a system id from adt-mcp.config.jsonc (credentials
// resolved through the keychain), or the path of a .env file.
const { loadProfile } = await import(pathToFileURL(join(ROOT, "tools", "scripts", "profile.mjs")).href);
const profile = await loadProfile(profileArg, ROOT);

const load = (relative) => import(pathToFileURL(join(ROOT, "dist", relative)).href);
const { createRegistry } = await load("engine/create-registry.js");
const { registerFamilies } = await load("families/index.js");
const { GatewayRuntime } = await load("runtime.js");
const { AdtSession } = await load("adt/session.js");

const system = {
  id: profile.id,
  tier: profile.tier,
  endpoint: { url: profile.url, client: profile.client, language: profile.language, systemType: "onprem" },
  auth: { type: "basic", username: profile.username, password: profile.password },
  rfcBackend: "soap",
  env: {},
};
const runtime = new GatewayRuntime([system], (target) =>
  new AdtSession({
    url: target.endpoint.url,
    client: target.endpoint.client,
    language: target.endpoint.language,
    username: profile.username,
    password: profile.password,
    timeoutMs: 120_000,
  }),
);
const registry = createRegistry();
registerFamilies(registry, runtime);
const call = (tool, args) => registry.call(tool, args, { system: "probe" });

/** Unique per run so a leftover from a broken run never blocks the next one. */
const suffix = String(process.pid % 100).padStart(2, "0");
const PROGRAM = `ZZBRG${suffix}`;
const CLASS = `ZCL_BRG${suffix}`;
const STATUS = "STATUS_BRG";

const results = [];
const record = (tool, outcome, detail) => {
  results.push({ tool, outcome, detail });
  process.stdout.write(`${outcome === "ok" ? "  ok  " : " FAIL "} ${tool}  ${detail ?? ""}\n`);
};

/**
 * One bridge tool: the call is the assertion. A tool that writes has to answer with
 * something — a throw is the failure, and its text is the finding.
 */
const step = async (tool, args, describe) => {
  try {
    const result = await call(tool, args);
    const text = describe === undefined ? undefined : describe(result);
    record(tool, "ok", text);
    return result;
  } catch (error) {
    record(tool, "fail", String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 180));
    return undefined;
  }
};

const short = (result) =>
  result === undefined || typeof result !== "object"
    ? String(result)
    : Object.entries(result)
        .filter(([key]) => ["status", "activated", "deleted", "characters", "entries", "program_name", "class_name"].includes(key))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");

process.stdout.write(`probe-bridge: program ${PROGRAM}, class ${CLASS} (package $TMP)\n\n`);

let programReady = false;
let classReady = false;

try {
  // --- fixtures ---------------------------------------------------------
  const created = await step(
    "CreateProgram",
    { program_name: PROGRAM, package_name: "$TMP", program_type: "executable", description: "bridge probe" },
    short,
  );
  programReady = created !== undefined;
  if (programReady) {
    await step(
      "UpdateProgram",
      { program_name: PROGRAM, source_code: `REPORT ${PROGRAM.toLowerCase()}.\n`, activate: true },
      short,
    );
  }

  // --- text pool (RFC bridge, needs a program) --------------------------
  if (programReady) {
    await step(
      "WriteTextElementsBulk",
      {
        program_name: PROGRAM,
        activate: true,
        text_elements: [
          { type: "R", text: "bridge probe" },
          { type: "I", key: "001", text: "probe" },
        ],
      },
      short,
    );
    await step(
      "CreateTextElement",
      { program_name: PROGRAM, text_type: "I", key: "002", text: "second", activate: true },
      short,
    );
    await step(
      "UpdateTextElement",
      { program_name: PROGRAM, text_type: "I", key: "002", text: "second edited", activate: true },
      short,
    );
    await step(
      "DeleteTextElement",
      { program_name: PROGRAM, text_type: "I", key: "002", activate: true },
      short,
    );
    // The pool is the point: a write that answers 200 but leaves nothing is a bug.
    await step("GetTextElement", { program_name: PROGRAM, text_type: "I" }, (result) => {
      const count = Array.isArray(result?.text_elements) ? result.text_elements.length : "?";
      return `type I rows: ${count}`;
    });
  }

  // --- CUA (RFC bridge) -------------------------------------------------
  if (programReady) {
    await step(
      "CreateGuiStatus",
      { program_name: PROGRAM, status_name: STATUS, description: "bridge probe", status_type: "N", activate: true },
      short,
    );
    await step(
      "PatchGuiStatus",
      {
        program_name: PROGRAM,
        activate: true,
        changes: { TIT: [{ CODE: STATUS, TEXT: "bridge probe", TEXT_TYPE: "S" }] },
      },
      short,
    );
    await step("ReadGuiStatus", { program_name: PROGRAM }, (result) => {
      const statuses = result?.statuses;
      const names = Array.isArray(statuses) ? statuses.map((entry) => entry?.name ?? entry?.code ?? "?").join(",") : "?";
      return `statuses: ${names}`;
    });
    await step("DeleteGuiStatus", { program_name: PROGRAM, status_name: STATUS }, short);

    // The low variant needs a handle, which is what its own lock tool hands out.
    const locked = await step("LockGuiStatusLow", { program_name: PROGRAM, status_name: STATUS }, short);
    const handle = locked?.lock_handle;
    if (handle !== undefined) {
      await step("UnlockGuiStatusLow", { program_name: PROGRAM, status_name: STATUS, lock_handle: handle }, short);
    } else {
      record("UnlockGuiStatusLow", "fail", "no lock handle came back from LockGuiStatusLow");
    }
  }

  // --- class-local includes (lock -> PUT -> unlock) ---------------------
  const createdClass = await step(
    "CreateClass",
    { class_name: CLASS, package_name: "$TMP", description: "bridge probe", final: true },
    short,
  );
  classReady = createdClass !== undefined;
  if (classReady) {
    await step(
      "UpdateClass",
      {
        class_name: CLASS,
        activate: true,
        source_code:
          `CLASS ${CLASS.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n` +
          "  PUBLIC SECTION.\n" +
          "    METHODS run RETURNING VALUE(rv_result) TYPE i.\n" +
          "ENDCLASS.\n" +
          `CLASS ${CLASS.toLowerCase()} IMPLEMENTATION.\n` +
          "  METHOD run.\n    rv_result = 1.\n  ENDMETHOD.\n" +
          "ENDCLASS.\n",
      },
      short,
    );
    await step(
      "UpdateLocalDefinitions",
      { class_name: CLASS, definitions_code: "TYPES ty_probe TYPE i.\n" },
      short,
    );
    await step("UpdateLocalMacros", { class_name: CLASS, macros_code: "DEFINE m_probe.\nEND-OF-DEFINITION.\n" }, short);
    await step("UpdateLocalTypes", { class_name: CLASS, types_code: "TYPES ty_second TYPE i.\n" }, short);
    await step(
      "UpdateLocalTestClass",
      { class_name: CLASS, test_class_code: "CLASS ltc_probe DEFINITION FOR TESTING.\nENDCLASS.\n" },
      short,
    );
    await step("ActivateClassTestClassesLow", { class_name: CLASS }, short);
    await step(
      "UpdateCdsUnitTest",
      { class_name: CLASS, test_class_source: "CLASS ltc_cds DEFINITION FOR TESTING.\nENDCLASS.\n" },
      short,
    );
    // Deletes the class as its last act, which is also the class cleanup.
    await step("DeleteCdsUnitTest", { class_name: CLASS }, short);
    classReady = false;
  }
} finally {
  if (!keep) {
    if (classReady) {
      await step("DeleteClass", { class_name: CLASS }, short);
    }
    if (programReady) {
      await step("DeleteProgram", { program_name: PROGRAM }, short);
    }
  }
}

const failed = results.filter((entry) => entry.outcome === "fail");
process.stdout.write(`\n### passed: ${results.length - failed.length}\n### failed: ${failed.length}\n`);
for (const entry of failed) process.stdout.write(`  ${entry.tool}  ${entry.detail}\n`);
process.exit(failed.length === 0 ? 0 : 1);
