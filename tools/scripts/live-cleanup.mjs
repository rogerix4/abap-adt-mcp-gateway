#!/usr/bin/env node
/**
 * Deletes a list of probe objects through the registry — the teardown lever for the live sweeps.
 *
 * Why it exists (2026-11-07): `live-tools.mjs` reports "231/231 checks passed" and still leaves its
 * main probes behind (`ZMMR_MCP_LTPROG`, `ZCL_MCP_LTCLAS`, `ZTMM_MCP_LTTABL`, …). A `--allow-writes`
 * run therefore builds up `$TMP` garbage run after run, and the report says nothing about it: the
 * per-step `Delete*` calls are *probes* (they prove the delete verb works on a throwaway twin), not
 * a teardown of the objects the other groups needed.
 *
 * Deliberate shape: the plan is data, not code. Every step is a gateway tool call with explicit
 * arguments (`{ "tool": "DeleteTable", "args": { "table_name": "…" } }`), so a wrong name is visible
 * in the input file instead of being computed somewhere in this script.
 *
 * Usage:
 *   node tools/scripts/live-cleanup.mjs --profile <system-id|env-file> --plan plan.json [--stop-on-error]
 *
 * `plan.json` is an array of `{ tool, args }`. Order matters: put structures/tables before the data
 * elements they reference, and data elements before their domains — SAP refuses the reverse.
 * Exit code: 0 when every step settled (including "already gone"), 1 otherwise.
 */

import { readFileSync } from "node:fs";

import { openLive } from "./live-registry.mjs";

const ROOT = process.cwd();

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const profileArg = arg("--profile");
const planPath = arg("--plan");
const stopOnError = process.argv.includes("--stop-on-error");

if (!profileArg || !planPath) {
  console.error("usage: live-cleanup.mjs --profile <system-id|env-file> --plan plan.json [--stop-on-error]");
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (!Array.isArray(plan) || plan.length === 0) {
  console.error(`plan ${planPath} is empty — nothing to do`);
  process.exit(2);
}

const { call } = await openLive({ profile: profileArg, root: ROOT });

let failed = 0;
for (const item of plan) {
  const tool = item?.tool;
  const args = item?.args ?? {};
  // `DeleteObjectLow` is the generic route (object_type + object_name); every other verb has its own
  // tool. A typo in `tool` must fail loudly instead of silently doing nothing.
  if (typeof tool !== "string" || tool.length === 0) {
    failed += 1;
    console.log(`ERR   (no tool) ${JSON.stringify(item)}`);
    if (stopOnError) break;
    continue;
  }
  try {
    const answer = await call(tool, args);
    const text = typeof answer === "string" ? answer : JSON.stringify(answer ?? null);
    const gone = /"already_gone"\s*:\s*true/.test(text);
    console.log(`${gone ? "GONE " : "OK   "} ${tool.padEnd(28)} ${JSON.stringify(args).slice(0, 70)} :: ${text.slice(0, 80)}`);
  } catch (error) {
    failed += 1;
    const code = error?.code ?? "error";
    const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 140);
    console.log(`ERR   ${tool.padEnd(28)} ${JSON.stringify(args).slice(0, 70)} :: ${code} ${message}`);
    if (stopOnError) break;
  }
}

console.log(failed === 0 ? `\nplan complete: ${plan.length} step(s), 0 error(s)` : `\nplan finished: ${plan.length} step(s), ${failed} error(s)`);
process.exit(failed === 0 ? 0 : 1);
