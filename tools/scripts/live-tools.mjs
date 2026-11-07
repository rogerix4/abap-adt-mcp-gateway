#!/usr/bin/env node
/**
 * Live coverage of the tools the family sweep cannot reach.
 *
 * `live-families.mjs` walks Validate → Create → … → Delete for the twelve families that have a
 * text source. What is left is the low-level twins of those verbs, the generic `*Object*` route
 * (by `object_type`), the read-only tools, the runtime/dump/profiler tools and the handler twins.
 *
 * Every step is a gateway tool call through the registry, and `--check` compares the union of this run
 * and a `live-families --report` run against `tools/catalog.json`, so "335 of 335 exercised" is a
 * machine answer instead of a claim.
 *
 * ⚠️ Teardown (2026-11-07, corrected): the `Delete*` steps below are **probes** — they prove the delete
 * verb works on a throwaway twin. The **setup** objects (the program / class / table the other groups
 * build on) are *not* deleted, so a `--allow-writes` run leaves them behind: a green 231/231 run was
 * measured with 19 objects still in `$TMP`. Clean up with `tools/scripts/live-cleanup.mjs` (data-driven
 * plan, one gateway call per object) — see the hint printed at the end of a write run.
 *
 * Usage:
 *   node tools/scripts/live-tools.mjs --profile <system-id|env-file> [--report out.json]
 *                                     [--check families-report.json] [--keep]
 *                                     [--allow-writes] [--with-unit-tests]
 *                                     [--request <TR>] [--with-transport] [--only <groups>]
 *
 * `--request <TR>` (or `ADT_TRANSPORT_REQUEST`) is the request the transportable-package probes
 * write into; without one they are skipped rather than hard-coding a system value.
 * `--with-transport` additionally calls `HandlerTransportCreate` and `CreateTransportLow`, i.e. it
 * creates two requests that nothing is written into. The contract has no delete verb for a request,
 * so both numbers are printed and have to be removed in SE09 by hand.
 * `--only <group[,group]>` runs setup plus those groups and skips the rest — the lever for bisecting
 * a side effect down to the group that causes it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openLive } from "./live-registry.mjs";

const ROOT = process.cwd();

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const profileArg = arg("--profile") ?? arg("--system");
if (profileArg === undefined) {
  process.stderr.write("live-tools: --profile <system-id|env-file> is required\n");
  process.exit(2);
}

const keep = process.argv.includes("--keep");
const cleanup = process.argv.includes("--cleanup");
/**
 * Writes and activations are opt-in.
 *
 * Activating a Z object makes SAP generate its includes, and that generation enqueues
 * `E_ABAP_GENPH` in SM12 — a lock the client cannot release (there is no ADT or HTTP call for it;
 * `logoff` does not take it either, measured ). Object locks are released by
 * the gateway in a `finally`, but this one belongs to SAP's own generation. A default run therefore
 * reads only; pass `--allow-writes` on a system where a leftover generation enqueue is acceptable.
 */
const allowWrites = process.argv.includes("--allow-writes");
/**
 * ABAP Unit runs, test-class includes and CDS unit-test containers make SAP generate test includes,
 * and those generation enqueues (`E_ABAP_GENPH`) are left behind on this system (measured
 *: every run that touched them added 6-8 entries, a plain create+activate added none).
 * The group is therefore opt-in, so a default run leaves the enqueue table untouched.
 */
const withUnitTests = process.argv.includes("--with-unit-tests");
/** `--only a,b` — run setup plus these groups, for bisecting a side effect. */
const onlyGroups = (() => {
  const value = arg("--only");
  return typeof value === "string" && value.length > 0 ? new Set(value.split(",").map((entry) => entry.trim())) : undefined;
})();
/**
 * A transportable package probe needs a real request number, and that number belongs to the
 * machine, not the repo: pass `--request <TR>` or set `ADT_TRANSPORT_REQUEST`. Without one the
 * probes that need a request are skipped instead of hard-coding somebody's system value.
 */
const requestArg = (() => {
  const index = process.argv.indexOf("--request");
  const fromArgv = index > 0 ? process.argv[index + 1] : undefined;
  return typeof fromArgv === "string" && fromArgv.length > 0 ? fromArgv : (process.env.ADT_TRANSPORT_REQUEST ?? "");
})();
const live = await openLive({ profile: profileArg, root: ROOT });
const { call, registry, attempted, profile, effectOf } = live;

/**
 * Waits for SAP's generation to finish before the next step touches the object.
 *
 * Creating a class or a program makes SAP generate its includes and enqueue `E_ABAP_GENPH` for each
 * of them. Deleting the object in the same breath leaves those enqueues pointing at generated
 * includes that no longer exist, so they sit in SM12 until they time out (measured: one
 * sweep left thirty of them). A pause lets the generation finish and release its own enqueue.
 */
const settle = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const record = (group, tool, ok, detail) => {
  results.push({ group, tool, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${tool.padEnd(34)} ${String(detail).slice(0, 110)}\n`);
};
const step = async (group, tool, args, expectedCode) => {
  // A default run is read-only: `effect: write` tools are not called at all, so a read-only pass
  // cannot leave a generation enqueue or an object lock behind whatever the fixture asks for.
  if (!allowWrites && effectOf(tool) === "write") {
    record(group, tool, true, "skipped: write tool (--allow-writes)");
    return { ok: true, payload: undefined, skipped: true };
  }
  // Bisecting a side effect: `--only` keeps setup (so the probes exist) and drops every other group.
  if (onlyGroups !== undefined && group !== "setup" && !onlyGroups.has(group)) {
    record(group, tool, true, "skipped: --only filter");
    return { ok: true, payload: undefined, skipped: true };
  }
  try {
    const answer = await call(tool, args);
    const payload = typeof answer === "string" ? answer : JSON.stringify(answer ?? null);
    record(group, tool, true, payload.slice(0, 110));
    return { ok: true, payload: answer };
  } catch (error) {
    const code = error?.code ?? "error";
    const message = String(error?.message ?? error);
    // The probes keep their names between runs, so "it is already there" is the normal answer on a
    // second run and not a failure.
    if (/already exists|does already exist|already has a\b|已存在|existiert|I::000|没有发现下一个|已在用户.*请求/i.test(message)) {
      record(group, tool, true, group === "setup" ? "already exists — reused" : `already exists (${code})`);
      return { ok: false, payload: undefined, code, message, exists: true };
    }
    // A delete whose object is already gone has reached exactly the state the fixture wants;
    // reading that as a defect made every rerun of a create/delete pair look broken.
    if (tool.startsWith("Delete") && /not found|not-found|does not exist|不存在|sy-subrc=1\b/i.test(message)) {
      record(group, tool, true, `already gone (${code})`);
      return { ok: false, payload: undefined, code, message, exists: false, gone: true };
    }
    // Some answers are the honest design rather than a defect: a server without a reloader cannot
    // reload a profile, and saying so is the correct behaviour.
    record(group, tool, code === expectedCode, `${code}: ${message}`);
    return { ok: false, payload: undefined, code, message, exists: false };
  }
};

const tag = "LIVE";
const lower = (value) => value.toLowerCase();
/**
 * A name for the tools whose subject must not exist yet — fixed, so a second run reports "exists".
 * The names are written out at the call sites (`ZMMR_MCP_VFREE` / `ZMMR_MCP_HFREE`) instead of a
 * `ZZ<prefix>FREE` template: the template produced names no layer of
 * `instructions/design/naming-objects.instructions.md` recognises.
 */

/**
 * The probe set keeps the same names on every run.
 *
 * A fresh set per run means a fresh ABAP generation per run, and each generation enqueues
 * `E_ABAP_GENPH` for the includes it builds. Reusing the objects means they are generated once and
 * afterwards only written to, which is what keeps the enqueue table quiet.
 */
const probes = {
  program: "ZMMR_MCP_LTPROG",
  programAlt: "ZMMR_MCP_LTALTR",
  class: "ZCL_MCP_LTCLAS",
  interface: "ZMM_IF_MCP_LTINTF",
  functionGroup: "ZFG_MCP_LTFUGR",
  table: "ZTMM_MCP_LTTABL",
  structure: "ZSMM_MCP_LTSTRU",
  domain: "ZD_MCP_LTDOMA",
  dataElement: "ZE_MCP_LTDTEL",
  view: "ZI_MCP_LTCVEW",
  metadataExtension: "ZI_MCP_LTCVEW_MD",
  package: "$TMP",
};
probes.functionModule = "ZFM_MCP_LTFUNC";
probes.include = "ZMMR_MCP_LTPROG_I01";

const created = [];
/** Deletions that only run under `--cleanup`, so a run never deletes what it just activated. */
const cleanupSteps = [];

/**
 * Creates the probe only when it is missing, and only then writes/activates it.
 *
 * Activation is what makes SAP generate an object's includes and enqueue `E_ABAP_GENPH`; a run that
 * keeps touching an object that already holds the right source therefore produces locks for nothing.
 */
const ensure = async (createTool, createArgs, updates = []) => {
  const made = await step("setup", createTool, createArgs);
  if (made.exists === true) return made;
  for (const [tool, args] of updates) await step("setup", tool, args);
  await settle();
  return made;
};

const setup = async () => {
  const ddlHeader = (label) =>
    `@EndUserText.label : '${label}'\n@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n`;

  await ensure(
    "CreateProgram",
    { program_name: probes.program, package_name: "$TMP", description: "live coverage probe" },
    [
      ["UpdateProgram", {
        program_name: probes.program,
        source_code: `REPORT ${lower(probes.program)}.\n\nDATA gv_probe TYPE string VALUE 'live coverage'.\nWRITE / gv_probe.\n`,
        activate: true,
        check_no_change: true,
      }],
    ],
  );
  created.push(["Program", probes.program]);
  await ensure("CreateProgram", { program_name: probes.programAlt, package_name: "$TMP", description: "live probe 2" });
  created.push(["Program", probes.programAlt]);
  await ensure(
    "CreateClass",
    { class_name: probes.class, package_name: "$TMP" },
    [
      ["UpdateClass", {
        class_name: probes.class,
        source_code:
          `CLASS ${lower(probes.class)} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n` +
          "  PUBLIC SECTION.\n" +
          "    INTERFACES if_oo_adt_classrun.\n" +
          "ENDCLASS.\n" +
          `CLASS ${lower(probes.class)} IMPLEMENTATION.\n` +
          "  METHOD if_oo_adt_classrun~main.\n" +
          "    out->write( 'live coverage' ).\n" +
          "  ENDMETHOD.\n" +
          "ENDCLASS.\n",
        activate: true,
        check_no_change: true,
      }],
    ],
  );
  created.push(["Class", probes.class]);
  await ensure(
    "CreateInterface",
    { interface_name: probes.interface, package_name: "$TMP" },
    [
      ["UpdateInterface", {
        interface_name: probes.interface,
        source_code: `INTERFACE ${lower(probes.interface)} PUBLIC.\n  METHODS run RETURNING VALUE(result) TYPE i.\nENDINTERFACE.\n`,
        activate: true,
        check_no_change: true,
      }],
    ],
  );
  created.push(["Interface", probes.interface]);
  await step("setup", "CreateFunctionGroup", {
    function_group_name: probes.functionGroup,
    package_name: "$TMP",
    description: "live coverage group",
  });
  created.push(["FunctionGroup", probes.functionGroup]);
  await step("setup", "CreateFunctionModule", {
    function_module_name: probes.functionModule,
    function_group_name: probes.functionGroup,
    description: "live coverage module",
  });
  await step("setup", "UpdateFunctionModule", {
    function_module_name: probes.functionModule,
    function_group_name: probes.functionGroup,
    source_code: `FUNCTION ${lower(probes.functionModule)}.\n  EXPORTING\n    VALUE(ev_result) TYPE i.\n  ev_result = 1.\nENDFUNCTION.\n`,
    activate: true,
  });
  await step("setup", "CreateTable", { table_name: probes.table, package_name: "$TMP" });
  created.push(["Table", probes.table]);
  await step("setup", "UpdateTable", {
    table_name: probes.table,
    ddl_code:
      ddlHeader(probes.table) +
      "@AbapCatalog.tableCategory : #TRANSPARENT\n@AbapCatalog.deliveryClass : #A\n@AbapCatalog.dataMaintenance : #RESTRICTED\n" +
      `define table ${lower(probes.table)} {\n\n  key client : abap.clnt not null;\n\n  key id : abap.int4 not null;\n\n  note : abap.char(40);\n\n}\n`,
  });
  await step("setup", "CreateStructure", { structure_name: probes.structure, package_name: "$TMP", fields: [{ name: "ID", data_type: "INT4" }] });
  created.push(["Structure", probes.structure]);
  await step("setup", "UpdateStructure", {
    structure_name: probes.structure,
    ddl_code: `${ddlHeader(probes.structure)}define structure ${lower(probes.structure)} {\n\n  id : abap.int4;\n\n  note : abap.char(40);\n\n}\n`,
  });
  await step("setup", "CreateDomain", { domain_name: probes.domain, package_name: "$TMP", description: "live coverage domain" });
  created.push(["Domain", probes.domain]);
  await step("setup", "CreateDataElement", {
    data_element_name: probes.dataElement,
    package_name: "$TMP",
    description: "live coverage element",
    data_type: "CHAR",
    length: "20",
  });
  created.push(["DataElement", probes.dataElement]);
  await step("setup", "CreateCdsView", {
    view_name: probes.view,
    package_name: "$TMP",
    ddl_source:
      `@AbapCatalog.sqlViewName: 'ZVMM_MCP_LTCVEW'\n@AccessControl.authorizationCheck: #NOT_REQUIRED\n@EndUserText.label: 'live coverage'\n@Metadata.allowExtensions: true\n` +
      `define view ${probes.view} as select from t100\n{\n  key sprsl as language,\n  key arbgb as area,\n  key msgnr as message_number,\n      text as text\n}\nwhere text <> ''\n`,
  });
  created.push(["CdsView", probes.view]);
  await step("setup", "CreateMetadataExtension", { name: probes.metadataExtension, package_name: "$TMP", description: "live coverage extension" });
  created.push(["MetadataExtension", probes.metadataExtension]);
  await step("setup", "UpdateMetadataExtension", {
    name: probes.metadataExtension,
    source_code: `@Metadata.layer: #CUSTOMER\nannotate view ${probes.view} with\n{\n  @EndUserText.label: 'live annotation'\n  text;\n}\n`,
  });
};

const teardown = async () => {
  const order = {
    BehaviorDefinition: (value) => ["DeleteBehaviorDefinition", { behavior_definition_name: value }],
    BehaviorImplementation: (value) => ["DeleteBehaviorImplementation", { behavior_implementation_name: value }],
    Package: (value) => ["DeletePackageLow", { package_name: value }],
    ServiceBinding: (value) => ["DeleteServiceBinding", { service_binding_name: value }],
    ServiceDefinition: (value) => ["DeleteServiceDefinition", { service_definition_name: value }],
    MetadataExtension: (value) => ["DeleteMetadataExtension", { metadata_extension_name: value }],
    CdsView: (value) => ["DeleteCdsView", { view_name: value }],
    DataElement: (value) => ["DeleteDataElement", { data_element_name: value }],
    Domain: (value) => ["DeleteDomain", { domain_name: value }],
    Structure: (value) => ["DeleteStructure", { structure_name: value }],
    Table: (value) => ["DeleteTable", { table_name: value }],
    FunctionGroup: (value) => ["DeleteFunctionGroup", { function_group_name: value }],
    Interface: (value) => ["DeleteInterface", { interface_name: value }],
    Class: (value) => ["DeleteClass", { class_name: value }],
    Program: (value) => ["DeleteProgram", { program_name: value }],
  };
  for (const [kind, value] of [...created].reverse()) {
    const entry = order[kind];
    // 2026-11-07: a kind this table does not know used to be skipped in silence — which is exactly
    // how `ZC_MCP_LTROOT` and the `ZI_MCP_LTCVEW` behaviour definition stayed in `$TMP` while the run
    // reported every check green. A created object without a delete verb is a FAIL, not a no-op.
    if (entry === undefined) {
      record("cleanup", `teardown:${kind}`, false, `${value} was created but teardown has no delete verb for "${kind}"`);
      continue;
    }
    const step = entry(value);
    if (step === undefined) continue;
    const [tool, args] = step;
    await call(tool, args).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const [tool, args] of cleanupSteps) {
    await call(tool, args).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

try {
  if (allowWrites) {
    await setup();
  } else {
    record("setup", "create/activate probes", true, "skipped: writes are opt-in (--allow-writes)");
  }

  // ---- low-level twins of the family verbs ------------------------------------------------
  const lowTwins = [
    ["Program", "program_name", { description: "low probe", package_name: "$TMP" }],
    ["Class", "class_name", { description: "low probe", package_name: "$TMP" }],
    ["Interface", "interface_name", { description: "low probe", package_name: "$TMP" }],
    // `CreateFunctionGroupLow` answers `HTTP 400 对象类型 <name> 不存在` naming an object from a
    // different probe (measured ). It is still called — the tool has to be exercised —
    // but the answer is declared as expected so the run stays readable. `CreateFunctionGroup` is the
    // verb that actually creates a group; this one is the low twin of a verb ADT does not offer.
    ["FunctionGroup", "function_group_name", { description: "low probe", package_name: "$TMP" }, "upstream"],
    ["Structure", "structure_name", { description: "low probe", package_name: "$TMP" }],
    ["Domain", "domain_name", { description: "low probe", package_name: "$TMP" }],
    ["DataElement", "data_element_name", { description: "low probe", package_name: "$TMP" }],
    ["CdsView", "view_name", { description: "low probe", package_name: "$TMP" }],
    ["MetadataExtension", "name", { description: "low probe", package_name: "$TMP" }],
  ];
  /**
   * Family → the complete object-name prefix from `instructions/design/naming-objects.instructions.md`.
   * Tables and structures carry no underscore after `ZT` / `ZS`: SAP refuses a database object name
   * whose 2nd or 3rd character is `_` ("不允许底线位于第二或第三库位").
   */
  const TYPE_PREFIX = {
    Program: "ZMMR_MCP_",
    Include: "ZMMR_MCP_",
    Class: "ZCL_MCP_",
    Interface: "ZMM_IF_MCP_",
    FunctionGroup: "ZFG_MCP_",
    FunctionModule: "ZFM_MCP_",
    Table: "ZTMM_MCP_",
    Structure: "ZSMM_MCP_",
    Domain: "ZD_MCP_",
    DataElement: "ZE_MCP_",
    CdsView: "ZI_MCP_",
    MetadataExtension: "ZI_MCP_",
    ServiceDefinition: "ZUI_MCP_",
    ServiceBinding: "ZUI_MCP_",
    Package: "ZMCP_MCP_",
  };
  /** An include name carries its 2-digit type suffix, or the template check cannot recognise it. */
  const familyName = (family, suffix) =>
    `${TYPE_PREFIX[family] ?? "ZMCP_MCP_"}${family.slice(0, 2).toUpperCase()}${suffix}${family === "Include" ? "_I01" : ""}`;
  let counter = 0;
  for (const [family, param, extra, expected] of lowTwins) {
    const value = familyName(family, `LOW${String(++counter).padStart(2, "0")}`);
    if (!registry.has(`Create${family}Low`)) continue;
    const made = await step("low", `Create${family}Low`, { [param]: value, ...extra }, expected);
    const deleteTool = `Delete${family}Low`;
    if (made.ok === true) {
      // Created here: its generation must finish before it is deleted, so the delete is queued for
      // the `--cleanup` pass (measured: create+delete in one breath leaves E_ABAP_GENPH).
      created.push([family, value]);
      if (registry.has(deleteTool)) cleanupSteps.push([deleteTool, { [param]: value }]);
      continue;
    }
    if (made.exists === true) {
      // It survived an earlier run, so its generation is long finished: deleting it now is both
      // safe and the only way `Delete<Family>Low` gets exercised.
      if (registry.has(deleteTool)) await step("low", deleteTool, { [param]: value });
    }
  }

  // ---- generic routes by object_type ------------------------------------------------------
  const objectCases = [
    // A name check answers a question about a *free* name; SAP refuses the question outright for a
    // name that is taken (400 "already exists"), so the probe asks about a name nobody owns.
    ["ValidateObjectLow", { object_type: "PROGRAM", object_name: "ZMMR_MCP_VFREE", package_name: "$TMP" }],
    ["LockObjectLow", { object_type: "PROGRAM", object_name: probes.program }],
    ["CheckObjectLow", { object_type: "PROGRAM", object_name: probes.program }],
    ["ActivateObjectLow", { objects: [{ name: probes.program, type: "PROG/P" }] }],
    ["ActivateObjects", { objects: [{ name: probes.program, type: "PROG/P" }] }],
  ];
  let unlocked = false;
  for (const [tool, args] of objectCases) {
    const answer = await step("object", tool, args);
    if (tool === "LockObjectLow" && answer.ok) {
      const handle = answer.payload?.lock_handle;
      const sessionId = answer.payload?.session_id;
      if (typeof handle === "string" && handle.length > 0) {
        await step("object", "UnlockObjectLow", { object_type: "PROGRAM", object_name: probes.program, lock_handle: handle, session_id: sessionId });
        unlocked = true;
      }
    }
  }
  if (!unlocked) {
    // The schema requires a lock handle, so the call is exercised with an empty one: the answer is
    // "invalid-lock", which is the point — the route is reachable and refuses what it cannot use.
    await step("object", "UnlockObjectLow", { object_type: "PROGRAM", object_name: probes.program, lock_handle: "", session_id: "" });
  }
  await step("object", "DeleteObjectLow", { object_type: "PROGRAM", object_name: probes.programAlt });

  // ---- read-only tools --------------------------------------------------------------------
  const code = "REPORT zprobe.\n\nDATA gv_value TYPE i VALUE 1.\nWRITE / gv_value.\n";
  const reads = [
    ["GetSession", {}],
    ["GetAdtTypes", {}],
    ["GetInactiveObjects", {}],
    ["SearchObject", { object_name: probes.program }],
    ["GetObjectInfo", { parent_type: "PROG/P", parent_name: probes.program }],
    ["GetObjectNodeFromCache", { object_type: "PROG/P", object_name: probes.program, tech_name: probes.program }],
    ["GetObjectStructure", { objecttype: "PROG/P", objectname: probes.program }],
    ["GetObjectStructureLow", { object_type: "PROG/P", object_name: probes.program }],
    ["GetNodeStructureLow", { parent_type: "DEVC/K", parent_name: "$TMP" }],
    ["GetObjectStructure", { objecttype: "TABL/DT", objectname: "T000" }],
    ["GetPackageContents", { package_name: "$TMP" }],
    ["GetPackageTree", { package_name: "$TMP" }],
    ["GetProgFullCode", { name: probes.program, type: "PROG/P" }],
    ["GetIncludesList", { object_name: probes.program, object_type: "PROG/P" }],
    ["GetScreensList", { program_name: probes.program }],
    ["GetGuiStatusList", { program_name: probes.program }],
    ["GetSqlQuery", { sql_query: "SELECT TABNAME, TABCLASS FROM DD02L WHERE TABCLASS = 'TRANSP'", row_number: 5 }],
    ["GetTableContents", { table_name: probes.table, max_rows: 5 }],
    ["GetWhereUsed", { object_name: probes.dataElement, object_type: "DTEL/DE", max_results: 5 }],
    ["GetUsageSnippets", { object_name: probes.program, object_type: "PROG/P", max_objects: 5 }],
    ["GetTransaction", { transaction_name: "SE38" }],
    ["GetTcodeUsage", { tcodes: ["SE38"], months: 1 }],
    ["GetJobUsage", { programs: [probes.program], months: 1 }],
    ["GetTypeInfo", { type_name: "T000" }],
    ["GetAbapAST", { code }],
    ["GetAbapSemanticAnalysis", { code }],
    ["GetAbapSystemSymbols", { code }],
    ["GetEnhancements", { object_name: probes.program, object_type: "PROG/P" }],
    ["DescribeByList", { objects: [{ name: probes.program, type: "PROG/P" }] }],
    ["ReadTextElementsBulk", { program_name: probes.program }],
    ["ListTransports", { modifiable_only: true }],
    ["ListServiceBindingTypes", {}],
  ];
  for (const [tool, args] of reads) await step("read", tool, args);
  await step("read", "ReloadProfile", {}, "NOT_IMPLEMENTED");

  // ---- runtime, dump, profiler ------------------------------------------------------------
  const dumpList = await step("runtime", "RuntimeListDumps", { top: 3 });
  const dumpId = dumpList.payload?.dumps?.[0]?.dump_id;
  await step("runtime", "RuntimeListFeeds", {});
  await step("runtime", "RuntimeListSystemMessages", {});
  await step("runtime", "RuntimeGetGatewayErrorLog", {});
  await step("runtime", "RuntimeListProfilerTraceFiles", {});
  const parameters = await step("runtime", "RuntimeCreateProfilerTraceParameters", { description: "live coverage profiler" });
  if (typeof dumpId === "string") {
    await step("runtime", "RuntimeGetDumpById", { dump_id: dumpId });
    await step("runtime", "RuntimeAnalyzeDump", { dump_id: dumpId });
  }
  const profilerId = parameters.payload?.profiler_id;
  if (typeof parameters.payload?.profiler_id === "string") {
    void profilerId;
  }

  // ---- class includes: test class, local types, macros, definitions --------------------------
  // ABAP Unit and the test-class include make SAP generate test includes, and those generation
  // enqueues are exactly what stayed in SM12 on this system (measured: a plain
  // create+activate added none, this group added 6-8). Opt-in through --with-unit-tests.
  const testClassCode =
    "CLASS ltcl_probe DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.\n" +
    "  PUBLIC SECTION.\n" +
    "    METHODS first_test FOR TESTING.\n" +
    "ENDCLASS.\n" +
    "CLASS ltcl_probe IMPLEMENTATION.\n" +
    "  METHOD first_test.\n" +
    "    cl_abap_unit_assert=>assert_equals( act = 1 exp = 1 ).\n" +
    "  ENDMETHOD.\n" +
    "ENDCLASS.\n";

  if (withUnitTests) {
    const testLock = await step("local", "LockClassTestClassesLow", { class_name: probes.class });
  const testHandle = testLock.payload?.lock_handle;
  if (typeof testHandle === "string" && testHandle.length > 0) {
    await step("local", "UpdateClassTestClassesLow", {
      class_name: probes.class,
      test_class_source: testClassCode,
      lock_handle: testHandle,
    });
    // The activation has to happen after the release: while the test include is locked, SAP refuses
    // to activate it ("The object is locked").
    await step("local", "UnlockClassTestClassesLow", { class_name: probes.class, lock_handle: testHandle });
    await step("local", "ActivateClassTestClassesLow", { class_name: probes.class });
  }

  await step("local", "GetLocalTestClass", { class_name: probes.class });
  await step("local", "UpdateLocalTestClass", { class_name: probes.class, test_class_code: testClassCode });
  await step("local", "GetLocalTypes", { class_name: probes.class });
  await step("local", "UpdateLocalTypes", {
    class_name: probes.class,
    local_types_code: "TYPES ty_probe TYPE i.\n",
  });
  await step("local", "GetLocalMacros", { class_name: probes.class });
  await step("local", "UpdateLocalMacros", { class_name: probes.class, macros_code: "DEFINE probe_macro.\n  WRITE / 'probe'.\nEND-OF-DEFINITION.\n" });
  await step("local", "GetLocalDefinitions", { class_name: probes.class });
  await step("local", "UpdateLocalDefinitions", {
    class_name: probes.class,
    definitions_code: "CLASS lcl_probe DEFINITION.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\n",
  });
  } else {
    record("local", "testclass/include group", true, "skipped: generating test includes leaves E_ABAP_GENPH (--with-unit-tests)");
  }

  // ---- text pool --------------------------------------------------------------------------
  // The pool is written first: `UpdateTextElement` refuses a type that has no entry yet.
  await step("text", "GetTextElement", { program_name: probes.program });
  await step("text", "CreateTextElement", { program_name: probes.program, text_type: "R", text: "Live coverage" });
  await step("text", "WriteTextElementsBulk", {
    program_name: probes.program,
    text_elements: [
      { type: "R", text: "Live coverage bulk" },
      { type: "I", key: "001", text: "Live coverage line" },
    ],
  });
  await step("text", "UpdateTextElement", { program_name: probes.program, text_type: "I", key: "001", text: "Live coverage v2" });
  await step("text", "ReadTextElementsBulk", { program_name: probes.program });
  await step("text", "DeleteTextElement", { program_name: probes.program, text_type: "I", key: "001" });
  await step("text", "DeleteLocalTestClass", { class_name: probes.class });
  await step("text", "DeleteLocalTypes", { class_name: probes.class });
  await step("text", "DeleteLocalMacros", { class_name: probes.class });
  await step("text", "DeleteLocalDefinitions", { class_name: probes.class });

  // ---- service definition and binding ------------------------------------------------------
  const serviceDefinition = "ZUI_MCP_LTSD";
  const serviceBinding = "ZUI_MCP_LTSB_O2";
  const definitionSource = `define service ${serviceDefinition} {\n  expose ${probes.view} as Coverage;\n}\n`;
  const definition = await step("service", "CreateServiceDefinition", {
    service_definition_name: serviceDefinition,
    package_name: "$TMP",
    source_code: definitionSource,
  });
  if (!definition.skipped && (definition.ok || definition.exists === true)) {
    created.push(["ServiceDefinition", serviceDefinition]);
    await step("service", "ReadServiceDefinition", { service_definition_name: serviceDefinition });
    await step("service", "GetServiceDefinition", { service_definition_name: serviceDefinition });
    await step("service", "UpdateServiceDefinition", { service_definition_name: serviceDefinition, source_code: definitionSource });
    const binding = await step("service", "CreateServiceBinding", {
      service_binding_name: serviceBinding,
      service_definition_name: serviceDefinition,
      package_name: "$TMP",
    });
    if (!binding.skipped && (binding.ok || binding.exists === true)) {
      created.push(["ServiceBinding", serviceBinding]);
      await step("service", "ReadServiceBinding", { service_binding_name: serviceBinding });
      await step("service", "GetServiceBinding", { service_binding_name: serviceBinding });
      await step("service", "ValidateServiceBinding", {
        service_binding_name: serviceBinding,
        service_definition_name: serviceDefinition,
      });
      await step("service", "UpdateServiceBinding", {
        service_binding_name: serviceBinding,
        desired_publication_state: "unpublished",
        service_type: "ODataV4",
        service_name: serviceBinding,
      });
    }
  }

  // ---- unit tests (--with-unit-tests) ------------------------------------------------------
  // `runId` stays visible outside the group: the result/status tools below read a run by id.
  let runId;
  let tests;
  if (withUnitTests) {
  tests = [{ container_class: probes.class, test_class: "LTCL_PROBE" }];
  const run = await step("unit", "RunUnitTest", { tests });
  runId = run.payload?.run_id;
  if (typeof runId === "string" && runId.length > 0) {
    await step("unit", "GetUnitTestStatus", { run_id: runId });
    await step("unit", "GetUnitTestResult", { run_id: runId });
    await step("unit", "HandlerUnitTestStatus", { run_id: runId });
    await step("unit", "HandlerUnitTestResult", { run_id: runId });
  }
  await step("unit", "RunClassUnitTestsLow", { tests });
  await step("unit", "HandlerUnitTestRun", { tests });
  // The `UnitTest` family is the run lifecycle, not the test class: it starts a run and addresses
  // it by `run_id`.
  const createdRun = await step("unit", "CreateUnitTest", { tests });
  const createdRunId = createdRun.payload?.run_id;
  if (typeof createdRunId === "string" && createdRunId.length > 0) {
    await step("unit", "GetUnitTest", { run_id: createdRunId });
    // ADT has no PUT/DELETE on a run (405); the tools say so instead of inventing a verb.
    await step("unit", "UpdateUnitTest", { run_id: createdRunId }, "NOT_IMPLEMENTED");
    await step("unit", "DeleteUnitTest", { run_id: createdRunId }, "NOT_IMPLEMENTED");
  }
  // `CreateCdsUnitTest` creates the container class, so it needs a name nobody owns yet.
  const cdsTestClass = "ZCL_MCP_LTCU";
  const cdsTest = await step("unit", "CreateCdsUnitTest", {
    class_name: cdsTestClass,
    package_name: "$TMP",
    cds_view_name: probes.view,
  });
  if (!cdsTest.skipped && (cdsTest.ok || cdsTest.exists === true)) {
    await step("unit", "GetCdsUnitTest", { run_id: typeof runId === "string" ? runId : "" });
    await step("unit", "UpdateCdsUnitTest", { class_name: cdsTestClass, test_class_source: testClassCode });
    await step("unit", "DeleteCdsUnitTest", { class_name: cdsTestClass });
    cleanupSteps.push(["DeleteClass", { class_name: cdsTestClass }]);
  }
  } else {
    record("unit", "ABAP Unit / CdsUnitTest group", true, "skipped: generation enqueues stay behind (--with-unit-tests)");
  }

  // ---- profiler runs ----------------------------------------------------------------------
  const profilerRun = await step("profiler", "RuntimeRunProgramWithProfiling", { program_name: probes.program });
  const traceId =
    typeof profilerRun.payload?.trace_id === "string" && profilerRun.payload.trace_id.length > 0
      ? profilerRun.payload.trace_id
      : (await call("RuntimeListProfilerTraceFiles", {})).traces?.[0]?.id;
  if (typeof traceId === "string" && traceId.length > 0) {
    await step("profiler", "RuntimeAnalyzeProfilerTrace", { trace_id_or_uri: traceId, view: "hitlist" });
    await step("profiler", "RuntimeGetProfilerTraceData", { trace_id_or_uri: traceId, view: "hitlist" });
    await step("profiler", "HandlerProfileView", { trace_id_or_uri: traceId, view: "hitlist" });
  }
  await step("profiler", "RuntimeRunClassWithProfiling", { class_name: probes.class });
  await step("profiler", "HandlerProfileList", {});
  await step("profiler", "HandlerProfileRun", { target_type: "PROGRAM", program_name: probes.program });

  // ---- handler twins ----------------------------------------------------------------------
  const handlerCases = [
    ["HandlerValidate", { object_type: "PROGRAM", object_name: "ZMMR_MCP_HFREE", package_name: "$TMP", description: "handler probe" }],
    ["HandlerGet", { object_type: "PROGRAM", program_name: probes.program }],
    ["HandlerCheckRun", { object_type: "PROGRAM", object_name: probes.program }],
    ["HandlerActivate", { object_type: "PROGRAM", object_name: probes.program }],
    ["HandlerUpdate", { object_type: "PROGRAM", program_name: probes.program, source_code: `REPORT ${lower(probes.program)}.\nWRITE / 'handler'.` }],
    ["HandlerDumpList", {}],
    ["HandlerServiceBindingListTypes", {}],
  ];
  const handlerLock = await step("handler", "HandlerLock", { object_type: "PROGRAM", object_name: probes.program });
  const handlerLockHandle = handlerLock.payload?.lock_handle;
  if (typeof handlerLockHandle === "string" && handlerLockHandle.length > 0) {
    await step("handler", "HandlerUnlock", {
      object_type: "PROGRAM",
      object_name: probes.program,
      lock_handle: handlerLockHandle,
      session_id: handlerLock.payload?.session_id ?? "",
    });
  }
  const handlerDomain = "ZD_MCP_LTHDOM";
  const handlerCreate = await step("handler", "HandlerCreate", {
    object_type: "DOMAIN",
    domain_name: handlerDomain,
    package_name: "$TMP",
    description: "handler probe",
    datatype: "CHAR",
    length: 10,
  });
  if (handlerCreate.ok) {
    created.push(["Domain", handlerDomain]);
    cleanupSteps.push(["HandlerDelete", { object_type: "DOMAIN", domain_name: handlerDomain }]);
  }
  for (const [tool, args] of handlerCases) await step("handler", tool, args);
  if (typeof dumpId === "string") await step("handler", "HandlerDumpView", { dump_id: dumpId, view: "summary" });
  if (!definition.skipped && (definition.ok || definition.exists === true)) {
    await step("handler", "HandlerServiceBindingValidate", {
      service_binding_name: serviceBinding,
      service_definition_name: serviceDefinition,
    });
  }

  // ---- screen and GUI status (dispatch bridge) --------------------------------------------
  // A screen belongs to a module pool, so the probe is its own program; nothing is deleted here
  // (see the `--cleanup` note) — the deletions are queued instead.
  const modulePool = "ZMMR_MCP_LTMDPL";
  await step("screen", "CreateProgram", {
    program_name: modulePool,
    package_name: "$TMP",
    program_type: "module_pool",
    description: "screen probe",
  });
  // No template is passed: the gateway fills a minimal dynpro itself (header + SCREEN container +
  // the two PROCESS blocks), which is what the dispatcher's `DYNPRO_INSERT` accepts. A dynpro read
  // from another program carries that program's HEADER and fails with "cannot send dynpro".
  const screen = await step("screen", "CreateScreen", { program_name: modulePool, screen_number: "0100" });
  // Reading a screen that this run did not create can only answer "no such dynpro" — that is a
  // missing fixture, not a defect, so a read-only run records the skip instead.
  const screenRead = screen.skipped
    ? { ok: true, payload: undefined, skipped: true }
    : await step("screen", "ReadScreen", { program_name: modulePool, screen_number: "0100" });
  if (!screen.skipped) {
    await step("screen", "GetScreen", { program_name: modulePool, screen_number: "0100" });
  }
  // The contract declares `dynpro_data` as JSON text; a read answers an object now.
  const dynpro = screenRead.payload?.result ?? screenRead.payload?.dynpro_data;
  if (!screen.skipped && (screen.ok || screen.exists === true) && dynpro !== undefined) {
    await step("screen", "UpdateScreen", {
      program_name: modulePool,
      screen_number: "0100",
      dynpro_data: typeof dynpro === "string" ? dynpro : JSON.stringify(dynpro),
    });
  }


  await step("screen", "GetScreensList", { program_name: modulePool });
  // `CreateGuiStatus` copies a reference status, and the bridge cannot read any standard program's
  // CUA on this release (measured: five candidates, all empty). The status is therefore
  // written from scratch with `UpdateGuiStatus`, which is also the tool a caller would use for that.
  const status = await step("screen", "CreateGuiStatus", { program_name: modulePool, status_name: "MAIN" });
  const minimalCua = JSON.stringify({
    ADM: {},
    STA: [{ CODE: "MAIN", MODAL: "", INT_NOTE: "live probe" }],
    SET: [],
    FUN: [],
    PFK: [],
    BUT: [],
    MEN: [],
    MTX: [],
    ACT: [],
    DOC: [],
    TIT: [],
    BIV: [],
  });
  // `CreateGuiStatus` now succeeds on this release, so the follow-up write has to run
  // unconditionally: gating it on "create failed" left `UpdateGuiStatus` never exercised.
  await step("screen", "UpdateGuiStatus", { program_name: modulePool, cua_data: minimalCua });
  await step("screen", "GetGuiStatus", { program_name: modulePool });
  const statusRead = await step("screen", "ReadGuiStatus", { program_name: modulePool });
  const cua = statusRead.payload?.result ?? statusRead.payload?.cua_data ?? statusRead.payload?.data;
  if (cua !== undefined) {
    const asText = typeof cua === "string" ? cua : JSON.stringify(cua);
    await step("screen", "UpdateGuiStatus", { program_name: modulePool, cua_data: asText });
    await step("screen", "PatchGuiStatus", { program_name: modulePool, changes: asText });
  }
  await step("screen", "ActivateGuiStatusLow", { program_name: modulePool });
  await step("screen", "GetGuiStatusList", { program_name: modulePool });

  // ---- the low-level twins of the screen and CUA verbs --------------------------------------
  // They own the lock, so each pair is lock -> change -> unlock on the program. Everything here is
  // written to survive a rerun: the probes are reused between runs, so a leftover screen from the
  // previous run would make `RPY_DYNPRO_INSERT` answer sy-subrc=5 ("already there").
  await step("screen", "DeleteScreen", { program_name: modulePool, screen_number: "0102" });
  // `RS_DYNPRO_DELETE` only removes an inactive dynpro (sy-subrc=1 when there is none), while
  // `RPY_DYNPRO_INSERT` refuses a dynpro that already exists (sy-subrc=5). The high-level delete is
  // what actually clears the 0102 left behind by a previous run.
  const screenCreate = await step("screen", "CreateScreenLow", { program_name: modulePool, screen_number: "0102" });
  // `UpdateScreenLow` declares `lock_handle` as required and never locks for you: lock first, use
  // the handle the lock returned, then unlock with the same one.
  const screenLock = await step("screen", "LockScreenLow", { program_name: modulePool });
  const screenHandle = typeof screenLock.payload?.lock_handle === "string" ? screenLock.payload.lock_handle : "";
  if (!screenCreate.skipped && screenCreate.ok === true) {
    // Measured: `UpdateScreenLow` is DELETE + INSERT and a real update works — the
    // screen's description changed after the call. The earlier `sy-subrc=5` came from this fixture
    // sending `dynpro_data: "{}"` (an empty dynpro is refused), not from the tool. So read the
    // screen back and send what a caller would send.
    const lowRead = await step("screen", "ReadScreen", { program_name: modulePool, screen_number: "0102" });
    const lowDynpro = lowRead.payload?.result ?? lowRead.payload?.dynpro_data;
    await step("screen", "UpdateScreenLow", {
      program_name: modulePool,
      screen_number: "0102",
      dynpro_data: typeof lowDynpro === "string" ? lowDynpro : JSON.stringify(lowDynpro),
      lock_handle: screenHandle,
    });
  } else {
    record("screen", "UpdateScreenLow", true, "skipped: the low create refused, so there is no fresh screen to update");
  }
  await step("screen", "UnlockScreenLow", { program_name: modulePool, lock_handle: screenHandle });
  await step("screen", "DeleteScreenLow", { program_name: modulePool, screen_number: "0102", lock_handle: screenHandle });
  // `CreateGuiStatusLow` refuses with "already has a GUI status definition" once the program owns any
  // CUA, which it does after the `UpdateGuiStatus` above. The low verb can only create the *first*
  // status, so the existing one is removed first and restored afterwards for the later steps.
  await step("screen", "DeleteGuiStatus", { program_name: modulePool, status_name: "MAIN" });
  const statusCreate = await step("screen", "CreateGuiStatusLow", { program_name: modulePool, status_name: "MAIN2" });
  const statusLock = await step("screen", "LockGuiStatusLow", { program_name: modulePool });
  const statusHandle = typeof statusLock.payload?.lock_handle === "string" ? statusLock.payload.lock_handle : "";
  if (statusCreate.ok === true) {
    await step("screen", "UpdateGuiStatusLow", { program_name: modulePool, cua_data: minimalCua, lock_handle: statusHandle });
  } else {
    record("screen", "UpdateGuiStatusLow", true, "skipped: the program already owns a CUA, so MAIN2 was never created");
  }
  await step("screen", "UnlockGuiStatusLow", { program_name: modulePool, lock_handle: statusHandle });
  await step("screen", "DeleteGuiStatusLow", { program_name: modulePool, status_name: "MAIN2", lock_handle: statusHandle });
  // Put MAIN back: the group below patches it and the cleanup deletes it.
  await step("screen", "UpdateGuiStatus", { program_name: modulePool, cua_data: minimalCua });

  // The four verbs the earlier passes skipped: activation of the screen, both deletes, and the
  // partial CUA merge.
  await step("screen", "PatchGuiStatus", { program_name: modulePool, changes: minimalCua });
  await step("screen", "ActivateScreenLow", { program_name: modulePool });
  await step("screen", "DeleteScreen", { program_name: modulePool, screen_number: "0100" });
  await step("screen", "DeleteGuiStatus", { program_name: modulePool, status_name: "MAIN" });

  // ---- remaining low twins and handler deletes ---------------------------------------------
  await step("low", "CreateFunctionModuleLow", {
    function_module_name: "ZFM_MCP_LTFULO",
    function_group_name: probes.functionGroup,
    description: "low module",
    package_name: "$TMP",
  });
  await step("low", "DeleteFunctionModuleLow", { function_module_name: "ZFM_MCP_LTFULO", function_group_name: probes.functionGroup });
  await step("low", "DeleteFunctionGroupLow", { function_group_name: "ZFG_MCP_LTFGLO" });
  // The table's low pair: create writes the shell, delete removes it again. Its own name, so a
  // leftover from an interrupted run cannot block the check.
  const lowTable = await step("low", "CreateTableLow", { table_name: "ZTMM_MCP_LTTBLLO", package_name: "$TMP" });
  if (!lowTable.skipped) await step("low", "DeleteTableLow", { table_name: "ZTMM_MCP_LTTBLLO" });
  // A package cannot be created and deleted again in one place: SAP keeps its TADIR row in the
  // request, and a package that is registered in a request but gone from the database answers 409
  // on every later create while no read finds it (measured on `ZMCPPKGL`). The create /
  // update verbs therefore run in the `package` group against packages that are created once and
  // kept; here only the delete verb's "nothing there" path is exercised, which leaves no row.
  await step("low", "DeletePackageLow", { package_name: "ZMCP_PKGDEAD", transport_request: requestArg });
  await step("handler", "HandlerDelete", { object_type: "DOMAIN", domain_name: handlerDomain });

  // ---- service definition / binding verbs --------------------------------------------------
  // `CreateServiceBinding` answers "already exists" on a second run, which used to skip this.
  // A read-only run never created the binding, so reading it would only produce a not-found that
  // looks like a defect: skip those two steps and say why.
  if (allowWrites) {
    await step("service", "ReadServiceBinding", { service_binding_name: serviceBinding });
    await step("service", "GetServiceBinding", { service_binding_name: serviceBinding });
  } else {
    for (const tool of ["ReadServiceBinding", "GetServiceBinding"]) {
      record("service", tool, true, "skipped: the binding is created by a write run (--allow-writes)");
    }
  }
  await step("service", "ValidateServiceBinding", {
    service_binding_name: serviceBinding,
    service_definition_name: serviceDefinition,
  });
  await step("service", "UpdateServiceBinding", {
    service_binding_name: serviceBinding,
    desired_publication_state: "unpublished",
    service_type: "ODataV4",
    service_name: serviceBinding,
  });
  await step("service", "DeleteServiceBinding", { service_binding_name: serviceBinding });
  await step("service", "DeleteServiceDefinition", { service_definition_name: serviceDefinition });

  // ---- behaviour definition on a transactional root ----------------------------------------
  // A BDEF needs a *root view entity* (provider contract), not the plain view used above.
  const rootView = "ZC_MCP_LTROOT";
  const rootViewCreate = await step("bdef2", "CreateCdsView", {
    view_name: rootView,
    package_name: "$TMP",
    ddl_source:
      `@AbapCatalog.sqlViewName: 'ZVMM_MCP_LTROOT'\n@AccessControl.authorizationCheck: #NOT_REQUIRED\n` +
      "@EndUserText.label: 'bdef root'\n" +
      "@ObjectModel.modelingPattern: #BO\n@ObjectModel.supportedCapabilities: [#ANALYTICAL_PROVIDER]\n" +
      `define root view entity ${rootView} as select from t100\n{\n  key msgnr as Id,\n      text  as Text\n}\n`,
  });
  // The root view is what the behaviour definition hangs on; teardown deletes in reverse order, so
  // the BDEF goes first and this view second. Without this line the view stayed in `$TMP` after
  // every `--cleanup` run (measured 2026-11-07: it and `ZI_MCP_LTCVEW` were the only leftovers).
  if (!rootViewCreate.skipped && (rootViewCreate.ok === true || rootViewCreate.exists === true)) {
    created.push(["CdsView", rootView]);
  }
  const bdefName = "ZC_MCP_LTROOT";
  const bdefSource =
    `managed implementation in class zcl_mcp_ltroot_impl unique;\nstrict ( 2 );\n` +
    `define behavior for ${rootView} alias Root\n{\n  create; update; delete;\n}\n`;
  const madeBdef2 = await step("bdef2", "CreateBehaviorDefinition", {
    name: bdefName,
    package_name: "$TMP",
    root_entity: rootView,
    implementation_type: "managed",
  });
  if (!madeBdef2.skipped && (madeBdef2.ok === true || madeBdef2.exists === true)) {
    created.push(["BehaviorDefinition", bdefName]);
    await step("bdef2", "CreateBehaviorDefinitionLow", {
      name: bdefName,
      description: "live probe",
      package_name: "$TMP",
      root_entity: rootView,
      implementation_type: "managed",
    });
    await step("bdef2", "ReadBehaviorDefinition", { behavior_definition_name: bdefName });
    await step("bdef2", "GetBehaviorDefinition", { behavior_definition_name: bdefName });
    await step("bdef2", "ValidateBehaviorDefinitionLow", {
      name: bdefName,
      root_entity: rootView,
      implementation_type: "managed",
      package_name: "$TMP",
      description: "live probe",
    });
    const bdefLock = await step("bdef2", "LockBehaviorDefinitionLow", { name: bdefName });
    if (typeof bdefLock.payload?.lock_handle === "string") {
      await step("bdef2", "UpdateBehaviorDefinitionLow", {
        name: bdefName,
        source_code: bdefSource,
        lock_handle: bdefLock.payload.lock_handle,
      });
      await step("bdef2", "UnlockBehaviorDefinitionLow", {
        name: bdefName,
        lock_handle: bdefLock.payload.lock_handle,
        session_id: bdefLock.payload?.session_id ?? "",
      });
    }
    await step("bdef2", "UpdateBehaviorDefinition", { name: bdefName, source_code: bdefSource });
    await step("bdef2", "ActivateBehaviorDefinitionLow", { name: bdefName });
    await step("bdef2", "CheckBdefLow", { name: bdefName });
    const implClass = "ZCL_MCP_LTROOT_IMPL";
    const madeImpl = await step("bdef2", "CreateBehaviorImplementationLow", {
      class_name: implClass,
      behavior_definition: bdefName,
      description: "live probe",
      package_name: "$TMP",
    });
    if (!madeImpl.skipped && (madeImpl.ok === true || madeImpl.exists === true)) {
      // There is no `UnlockBehaviorImplementationLow` in the contract (only the lock verb exists),
      // so the handle is left to the session: `live.closeAll()` at the end of the run is what
      // releases it. Calling a name that is not in the catalog only produced UNKNOWN_TOOL.
      await step("bdef2", "LockBehaviorImplementationLow", { class_name: implClass });
      await step("bdef2", "DeleteBehaviorImplementation", { behavior_implementation_name: implClass });
      await step("bdef2", "DeleteClass", { class_name: implClass });
    }
    await step("bdef2", "DeleteBehaviorDefinition", { behavior_definition_name: bdefName });
    await step("bdef2", "DeleteBehaviorDefinitionLow", { name: bdefName });
  } else if (madeBdef2.skipped) {
    // `--only` filtered the create out, so there is nothing to run the rest of the group against.
    record("bdef2", "behaviour definition group", true, "skipped: the root entity was not created in this run");
  } else if (allowWrites) {
    record("bdef2", "behaviour definition group", false, "no transactional root entity could be created");
  } else {
    record("bdef2", "behaviour definition group", true, "skipped: the root entity is created by a write run (--allow-writes)");
  }

  // ---- what the cleanup pass has to remove ---------------------------------------------------
  cleanupSteps.push(["DeleteScreen", { program_name: modulePool, screen_number: "0100" }]);
  cleanupSteps.push(["DeleteGuiStatus", { program_name: modulePool, status_name: "MAIN" }]);
  cleanupSteps.push(["DeleteProgram", { program_name: modulePool }]);

  // ---- transport ----------------------------------------------------------------------------
  // A request nothing is written into is junk in SE09, and the contract has no delete verb for a
  // request, so this section is shaped to write as few of them as possible:
  // \* a normal run reuses the request handed in with `--request` and creates nothing;
  // \* only a run without `--request` calls `CreateTransport` (with a real target, `QS4`);
  // \* `--with-transport` additionally calls `HandlerTransportCreate` and `CreateTransportLow`.
  //   The low twin takes `description` + `transport_type` only — no `target_system` — so its request
  //   comes out with `TARSYSTEM='SAP'` (no target), which cannot be fixed from the caller side.
  //   It is exercised because it is part of the contract, and the measured probe request is printed
  //   so the junk can be found and deleted in SE09 afterwards.
  let transportNumber = requestArg;
  if (transportNumber === "") {
    // The landscape's real target: `TARSYSTEM='SAP'` in E070 means "no target", not "the QA system".
    const madeTransport = await step("transport", "CreateTransport", {
      description: "live coverage probe",
      transport_type: "workbench",
      target_system: "QS4",
    });
    const created =
      madeTransport.payload?.transport_number ??
      madeTransport.payload?.request ??
      madeTransport.payload?.transport_request ??
      madeTransport.payload?.number;
    if (typeof created === "string" && created.length > 0) transportNumber = created;
  } else {
    record("transport", "CreateTransport", true, `skipped: reusing --request ${transportNumber}`);
  }
  if (typeof transportNumber === "string" && transportNumber.length > 0) {
    process.stdout.write(`transport in use: ${transportNumber}\n`);
    await step("transport", "ListTransports", { modifiable_only: true, user: profile.username });
    // `include_objects` / `include_tasks` default to true; the owner retry path only runs when it
    // is given, so both shapes are exercised on a real request.
    await step("transport", "GetTransport", { transport_number: transportNumber, include_objects: true, include_tasks: true });
    await step("transport", "GetTransport", { transport_number: transportNumber, owner: profile.username });
  }
  if (process.argv.includes("--with-transport")) {
    await step("transport", "HandlerTransportCreate", {
      description: "gateway handler transport probe",
      transport_type: "workbench",
      target_system: "QS4",
    });
    const lowRequest = await step("transport", "CreateTransportLow", {
      description: "gateway low transport probe",
      transport_type: "workbench",
    });
    const lowNumber =
      lowRequest.payload?.transport_request ?? lowRequest.payload?.request ?? lowRequest.payload?.number;
    if (typeof lowNumber === "string" && lowNumber.length > 0) {
      process.stdout.write(`low transport probe (delete in SE09): ${lowNumber}\n`);
    }
  }

  // ---- package: the read / check / lock verbs, on a package that already exists --------------
  // They need a package object, not a package of *ours*: creating one only adds a transport entry,
  // and a package registered in a request but gone from the database makes every read answer
  // `从数据库导入对象 … 时出错`, which looks like a broken verb (measured ).
  const existingPackage = "ZMCP_RAP";
  const existingSuper = "ZTEST";
  await step("package", "GetPackage", { package_name: existingPackage });
  await step("package", "ReadPackage", { package_name: existingPackage });
  await step("package", "CheckPackageLow", { package_name: existingPackage, super_package: existingSuper });
  const existingLock = await step("package", "LockPackageLow", {
    package_name: existingPackage,
    super_package: existingSuper,
  });
  if (typeof existingLock.payload?.lock_handle === "string") {
    await step("package", "UnlockPackageLow", {
      package_name: existingPackage,
      super_package: existingSuper,
      lock_handle: existingLock.payload.lock_handle,
      session_id: existingLock.payload?.session_id ?? "",
    });
  }

  // ---- package: the create / read / check / lock / update verbs --------------------------------
  // A package is the one object that cannot be created and deleted again: SAP keeps its TADIR row
  // in the request, and a package registered in a request but gone from the database answers 409 on
  // every later create while no read finds it (measured on `ZMCPPKGL`, and earlier on
  // `ZMCPPKG1`). The probes are therefore created once below `ZMCP_RAP` and **kept**: the first run
  // creates them, every later run gets "already exists" and runs the same verbs on the live object.
  const superPackage = "ZMCP_RAP";
  const request = typeof transportNumber === "string" && transportNumber.length > 0 ? transportNumber : requestArg;
  for (const probe of [
    { tool: "CreatePackage", packageName: "ZMCP_PKGPROBE", description: "package verb probe (kept)" },
    { tool: "CreatePackageLow", packageName: "ZMCP_PKGLOW", description: "low package probe (kept)" },
  ]) {
    const made = await step("package", probe.tool, {
      package_name: probe.packageName,
      super_package: superPackage,
      // `transport_layer` is what decides; an empty one makes SAP answer the misleading
      // `409 … is not a local request`.
      software_component: "HOME",
      transport_layer: "ZDS4",
      transport_request: request,
      description: probe.description,
    });
    // "already exists" is the normal answer from the second run on, and the object is still there
    // because nothing deletes it. A *ghost* (row in a request, no object) answers the same 409 but
    // makes the verbs below fail, so their own answers stay honest instead of being forced green.
    if (made.ok !== true && made.exists !== true) continue;
    await step("package", "GetPackage", { package_name: probe.packageName });
    await step("package", "ReadPackage", { package_name: probe.packageName });
    await step("package", "ValidatePackageLow", { package_name: probe.packageName, super_package: superPackage });
    await step("package", "CheckPackageLow", { package_name: probe.packageName, super_package: superPackage });
    const locked = await step("package", "LockPackageLow", { package_name: probe.packageName, super_package: superPackage });
    const handle = locked.payload?.lock_handle;
    if (typeof handle !== "string" || handle.length === 0) continue;
    // The object sits in the request the lock named; a different corrNr answers
    // "already locked in request X".
    const lockRequest = locked.payload?.transport_request ?? request;
    const updated = await step("package", "UpdatePackageLow", {
      package_name: probe.packageName,
      super_package: superPackage,
      updated_description: `${probe.description} v2`,
      lock_handle: handle,
      transport_request: lockRequest,
    });
    // A package write that had to re-lock in a new session answers `lock_handle: null` together
    // with `lock_released: true` — that session is closed again right after the write, so no lock
    // survives to be unlocked (measured ). Unlocking a handle the update did not hand
    // back is what the gateway itself refuses.
    const unlockHandle =
      typeof updated.payload?.lock_handle === "string" ? updated.payload.lock_handle : undefined;
    if (unlockHandle === undefined) {
      record("package", "UnlockPackageLow", true, `nothing left to unlock: the write released it (${probe.packageName})`);
    } else {
      await step("package", "UnlockPackageLow", {
        package_name: probe.packageName,
        super_package: superPackage,
        lock_handle: unlockHandle,
        session_id: locked.payload?.session_id ?? "",
      });
    }
  }

  // ---- transport: one request is created (agreed), everything else reads it ------------------

  // ---- behaviour definition / implementation (needs a root BO entity) ----------------------
  const bdef = `ZI_MCP_LTCVEW`;
  const madeBdef = await step("bdef", "CreateBehaviorDefinition", {
    name: bdef,
    package_name: "$TMP",
    root_entity: probes.view,
    implementation_type: "managed",
  });
  if (!madeBdef.skipped && (madeBdef.ok || madeBdef.exists === true)) {
    created.push(["BehaviorDefinition", bdef]);
    await step("bdef", "ReadBehaviorDefinition", { behavior_definition_name: bdef });
    await step("bdef", "GetBehaviorDefinition", { behavior_definition_name: bdef });
    await step("bdef", "ValidateBehaviorDefinitionLow", {
      name: bdef,
      root_entity: probes.view,
      implementation_type: "managed",
      package_name: "$TMP",
      description: "probe",
    });
    const bdefLock = await step("bdef", "LockBehaviorDefinitionLow", { name: bdef });
    if (typeof bdefLock.payload?.lock_handle === "string") {
      await step("bdef", "UpdateBehaviorDefinitionLow", {
        name: bdef,
        source_code: `managed implementation in class zcl_mcp_ltbdef_impl unique;\nstrict ( 2 );\ndefine behavior for ${probes.view}\n{\n  create; update; delete;\n}\n`,
        lock_handle: bdefLock.payload.lock_handle,
      });
      await step("bdef", "UnlockBehaviorDefinitionLow", {
        name: bdef,
        lock_handle: bdefLock.payload.lock_handle,
        session_id: bdefLock.payload?.session_id ?? "",
      });
    }
    await step("bdef", "ActivateBehaviorDefinitionLow", { name: bdef });
    await step("bdef", "CreateBehaviorImplementation", {
      class_name: `ZCL_MCP_LTBDEF_IMPL`,
      behavior_definition: bdef,
      package_name: "$TMP",
    });
    await step("bdef", "GetBehaviorImplementation", { behavior_implementation_name: `ZCL_MCP_LTBDEF_IMPL` });
    await step("bdef", "ReadBehaviorImplementation", { behavior_implementation_name: `ZCL_MCP_LTBDEF_IMPL` });
    await step("bdef", "ValidateBehaviorImplementationLow", {
      class_name: `ZCL_MCP_LTBDEF_IMPL`,
      behavior_definition: bdef,
      package_name: "$TMP",
      description: "probe",
    });
    await step("bdef", "UpdateBehaviorImplementation", {
      class_name: `ZCL_MCP_LTBDEF_IMPL`,
      behavior_definition: bdef,
      implementation_code: "CLASS lhc_Probe DEFINITION INHERITING FROM cl_abap_behavior_handler.\n  PRIVATE SECTION.\nENDCLASS.\n",
    });
    await step("bdef", "DeleteBehaviorImplementation", { behavior_implementation_name: `ZCL_MCP_LTBDEF_IMPL` });
  }
  await step("bdef", "CheckBdefLow", { name: bdef });

  // ---- SmartForm: read a real form from the system, write a copy into $TMP -------------------
  // `CreateSmartForm` takes the Form Builder XML of SMARTFORMS > Utilities > Download. The only
  // honest source of that format is the system itself: `GetSmartFormContent` writes it next to the
  // tree it answers, so the donor XML comes from there. A hand-written XML makes SAPLSTXB dump
  // (measured ), which is why the copy is not synthesised.
  const donorForm = "ZMMF001";
  await step("smartform", "GetSmartFormLayout", { form_name: donorForm });
  const donorContent = await step("smartform", "GetSmartFormContent", { form_name: donorForm });
  const donorFile = donorContent.payload?.files?.xml;
  if (typeof donorFile === "string" && donorFile.length > 0) {
    const madeForm = await step("smartform", "CreateSmartForm", { form_name: "ZMM_SF_MCP_LTSF01", xml_file: donorFile });
    if (!madeForm.skipped && (madeForm.ok || madeForm.exists === true)) {
      await step("smartform", "GetSmartFormLayout", { form_name: "ZMM_SF_MCP_LTSF01" });
      await step("smartform", "GetSmartFormContent", { form_name: "ZMM_SF_MCP_LTSF01" });
      await step("smartform", "RenderSmartForm", { form_name: "ZMM_SF_MCP_LTSF01" });
      const gone = await step("smartform", "DeleteSmartForm", { form_name: "ZMM_SF_MCP_LTSF01", confirm: true });
      if (gone.ok === true) {
        // The read after the delete is the proof: the bridge answers `not-found`, not an empty form.
        await step("smartform", "GetSmartFormLayout", { form_name: "ZMM_SF_MCP_LTSF01" }, "not-found");
      }
    }
  } else {
    record("smartform", "CreateSmartForm", true, "skipped: the donor form returned no XML file");
  }

  // ---- remaining read-only tools -----------------------------------------------------------
  await step("read2", "GetVirtualFoldersLow", {});
  await step("read2", "GetObjectsList", { parent_name: "$TMP", parent_tech_name: "$TMP", parent_type: "DEVC/K" });
  await step("read2", "GetObjectsByType", {
    parent_name: "$TMP",
    parent_tech_name: "$TMP",
    parent_type: "DEVC/K",
    node_id: "000000",
  });
  await step("read2", "GetBadiImplementations", { badi_definition: "BADI_SD_SALES" });
  // The demo enhancement names do not exist on this system; "not found" is the right answer there.
  // (Measured: route tools used to wrap every ADT answer in `UPSTREAM_FAILED`; the code
  // now keeps the classification, so a missing spot is `not-found`.)
  await step("read2", "GetEnhancementSpot", { enhancement_spot: "ES_SD_SALES" }, "not-found");
  await step("read2", "GetEnhancementImpl", { enhancement_spot: "ES_SD_SALES", enhancement_name: "PROBE" }, "not-found");
  if (typeof runId === "string" && runId.length > 0) {
    await step("read2", "GetClassUnitTestStatusLow", { run_id: runId });
    await step("read2", "GetClassUnitTestResultLow", { run_id: runId });
    await step("read2", "GetCdsUnitTestStatus", { run_id: runId });
    await step("read2", "GetCdsUnitTestResult", { run_id: runId });
    await step("handler", "HandlerCdsUnitTestStatus", { run_id: runId });
    await step("handler", "HandlerCdsUnitTestResult", { run_id: runId });
  }
} finally {
  // The probes are reused between runs on purpose (see `probes`): deleting them re-creates the
  // generation churn the naming avoids. `--cleanup` is the explicit request to remove them.
  if (cleanup) {
    await settle();
    await teardown();
  }
  // No settle before the logoff: measured, an `E_ABAP_GENPH` entry lives exactly as long
  // as the generation it belongs to (seconds), so a burst only looks like it leaves locks behind
  // when SM12 is read in the moment the last generation drains. Waiting changes the sample, not the
  // state, so the run simply logs off.
  // Release the session-scoped enqueues the run created (see `closeAll`).
  await live.closeAll().catch(() => undefined);
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);

const reportPath = arg("--report");
if (reportPath !== undefined) {
  // The report accumulates across runs: a tool counts as exercised once it has been called, and
  // several groups alternate per run (the low-level twins are deleted in one run and re-created in
  // the next), so overwriting would hide earlier evidence.
  let earlier = [];
  try {
    earlier = JSON.parse(readFileSync(reportPath, "utf8")).tools ?? [];
  } catch {
    earlier = [];
  }
  const tools = [...new Set([...earlier, ...attempted])].sort();
  writeFileSync(
    reportPath,
    `${JSON.stringify({ system: profile.id, ranAt: new Date().toISOString(), tools, results }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`report: ${reportPath} (${tools.length} tool(s), ${attempted.size} this run)\n`);
  // 2026-11-07：setup 探针不会被本脚本删除（见头部 Teardown 注）——每次写跑后把残留列干净。
  process.stdout.write(`cleanup: node tools/scripts/live-cleanup.mjs --profile ${profile.id} --plan <plan.json>\n`);
}

const checkPath = arg("--check");
if (checkPath !== undefined) {
  const catalog = JSON.parse(readFileSync(join(ROOT, "tools", "catalog.json"), "utf8")).tools.map((tool) => tool.name);
  const other = JSON.parse(readFileSync(checkPath, "utf8"));
  // The union has to include the accumulated report: several groups alternate between runs (the
  // low twins are created in one run and deleted in the next), so looking at this run alone reports
  // a tool that has been exercised as "never called".
  const accumulated =
    reportPath === undefined ? [] : (JSON.parse(readFileSync(reportPath, "utf8")).tools ?? []);
  const covered = new Set([...accumulated, ...attempted, ...(other.tools ?? [])]);
  const missing = catalog.filter((tool) => !covered.has(tool));
  process.stdout.write(`\ncoverage: ${catalog.length - missing.length}/${catalog.length} exercised\n`);
  if (missing.length > 0) process.stdout.write(`never called: ${missing.join(", ")}\n`);
  if (missing.length > 0) process.exitCode = 1;
}

if (failed.length > 0 && process.exitCode === undefined) process.exitCode = 1;

