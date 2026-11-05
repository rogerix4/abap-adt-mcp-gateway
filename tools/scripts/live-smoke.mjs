#!/usr/bin/env node
/**
 * Live smoke test: runs one complete object lifecycle against a real system.
 *
 * This is the repeatable form of the check that closed Q1 — it exercises the
 * engine's own primitives, then asserts the thing that actually matters:
 * after activation the active source equals what was written.
 *
 * Nothing is hard-coded: the target comes from a profile (a system id from
 * `adt-mcp.config.jsonc`, or a `.env` file). Credentials are resolved there and never
 * printed.
 *
 * Usage:
 *   npm run build
 *   node tools/scripts/live-smoke.mjs --profile <path/to/system.env> [--keep]
 *
 * The probe object is created in $TMP and deleted at the end. It is never run
 * against a business object.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const CT_PROGRAM = "application/vnd.sap.adt.programs.programs.v2+xml";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function loadModules() {
  const load = (relative) => import(pathToFileURL(join(ROOT, "dist", relative)).href);
  try {
    const session = await load("adt/session.js");
    const lifecycle = await load("adt/lifecycle.js");
    return { AdtSession: session.AdtSession, ...lifecycle };
  } catch (error) {
    process.stderr.write(`live-smoke: cannot load dist/ (${error.message}). Run "npm run build" first.\n`);
    process.exit(2);
  }
}

function loadProfile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  for (const key of ["SAP_URL", "SAP_CLIENT", "SAP_USERNAME", "SAP_PASSWORD"]) {
    if (env[key] === undefined || env[key].length === 0) {
      process.stderr.write(`live-smoke: profile is missing ${key}\n`);
      process.exit(2);
    }
  }
  return env;
}

const profilePath = arg("--profile");
if (profilePath === undefined) {
  process.stderr.write("live-smoke: --profile <path> is required\n");
  process.exit(2);
}

const keep = process.argv.includes("--keep");
const env = loadProfile(profilePath);
const language = env.SAP_LANGUAGE || "EN";
const { AdtSession, lockObject, unlockObject, writeSource, activateAndVerify, runCheck, deleteObject, readSource } =
  await loadModules();

const session = new AdtSession({
  url: env.SAP_URL,
  client: env.SAP_CLIENT,
  language,
  username: env.SAP_USERNAME,
  password: env.SAP_PASSWORD,
  timeoutMs: 120_000,
});

const name = `ZZSM${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const lower = name.toLowerCase();
const rel = `/programs/programs/${lower}`;
const abs = `/sap/bc/adt/programs/programs/${lower}`;
const sourcePath = `${rel}/source/main`;
const source = `REPORT ${lower}.\n\nWRITE: / 'engine smoke'.\n`;

const createBody =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" ' +
  `adtcore:description="engine smoke" adtcore:language="${language}" adtcore:name="${name}" ` +
  `adtcore:masterLanguage="${language}" adtcore:type="PROG/P" program:programType="1" program:application="*">` +
  '<adtcore:packageRef adtcore:name="$TMP"/></program:abapProgram>';

const step = (label, detail) => process.stdout.write(`${label.padEnd(14)}: ${detail}\n`);
const results = { activated: false, removed: false, gone: false };
let lock;

try {
  await session.request({
    method: "POST",
    path: "/programs/programs",
    accept: CT_PROGRAM,
    contentType: CT_PROGRAM,
    body: createBody,
  });
  step("create", `ok (${name} in $TMP)`);

  const skeleton = await readSource(session, sourcePath, "active");
  step("read active", `${skeleton.trim().split(/\r?\n/).length} line(s)`);

  lock = await lockObject(session, rel);
  step("lock", `handle ${lock.lockHandle.slice(0, 6)}…, transport ${lock.corrNr ?? "(none)"}`);

  await writeSource(session, sourcePath, source, { lockHandle: lock.lockHandle, corrNr: lock.corrNr });
  const draft = await readSource(session, sourcePath, "inactive");
  step("write", draft.includes("engine smoke") ? "draft holds the new source" : "DRAFT MISSING");

  // Activation while our own lock is held answers 403 "currently editing".
  await unlockObject(session, rel, lock.lockHandle);
  lock = undefined;
  step("unlock", "ok");

  const check = await runCheck(session, abs, "active");
  step("check", `${check.errors} error(s), ${check.warnings} warning(s)${check.unavailable ? `, unavailable` : ""}`);

  const verified = await activateAndVerify(session, { uri: abs, name, adtType: "PROG/P", sourcePath, source });
  results.activated = verified.activated;
  step("activate", `"${verified.report.status}", ok=${verified.report.ok}`);
  step("verify", verified.activated ? "active source matches what was written" : `MISMATCH — ${verified.comparison.detail}`);
} catch (error) {
  process.stderr.write(`live-smoke FAILED at a lifecycle step: ${error.code ?? "?"} ${error.message}\n`);
  if (error.nextAction) process.stderr.write(`  next: ${error.nextAction}\n`);
} finally {
  if (lock !== undefined) await unlockObject(session, rel, lock.lockHandle).catch(() => {});

  if (!keep) {
    try {
      const removed = await deleteObject(session, rel);
      results.removed = removed.deleted;
      step("delete", `deleted=${removed.deleted}, status=${removed.status}`);

      const after = await session
        .request({ path: `${sourcePath}?version=active`, accept: "text/plain" })
        .then(() => "STILL THERE")
        .catch((error) => (error.status === 404 ? "gone (404)" : `unexpected ${error.status}`));
      results.gone = after.startsWith("gone");
      step("read back", after);
    } catch (error) {
      step("delete", `failed: ${error.message}`);
    }
  } else {
    step("delete", `skipped (--keep), object is ${name}`);
  }
}

const passed = results.activated && (keep || (results.removed && results.gone));
process.stdout.write(`\nlive-smoke: ${passed ? "PASS" : "FAIL"}\n`);
process.exitCode = passed ? 0 : 1;
