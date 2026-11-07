#!/usr/bin/env node
/**
 * Live regression: walks every implemented family through its whole verb set
 * against a real system, through the registry (not around it).
 *
 * This is the check that a batch of families actually works — the offline tests
 * prove the request shapes, this proves SAP accepts them. Each family runs
 *
 *   Validate → Create → Read → Get → Update → Lock → UpdateLow → Unlock
 *            → Check → ActivateLow → Delete → Read again (must fail)
 *
 * and the last step is the point: a family is only done when the object is
 * really gone. Everything is created in `$TMP` from a `ZZ` prefix and deleted
 * again; nothing touches a business object.
 *
 * Usage:
 *   npm run build
 *   node tools/scripts/live-families.mjs --profile <system-id|path/to/system.env> [--only Program,Class]
 *                                       [--report families.json]
 *
 * `--report <path>` writes the `{ tools: [...] }` shape `live-tools --report` uses (accumulated
 * across runs), so `live-tools --check families.json` can union both sweeps into one "335 of 335
 * exercised" answer instead of a claim.
 *
 * MetadataExtension has no payload of its own — it annotates an existing view —
 * so it creates a view first and cleans that up afterwards.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { loadProfile } from "./profile.mjs";
import { schemaOf } from "./live-registry.mjs";

const ROOT = process.cwd();

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const load = (relative) => import(pathToFileURL(join(ROOT, "dist", relative)).href);
const { createRegistry } = await load("engine/create-registry.js");
const { registerFamilies, implementedFamilies } = await load("families/index.js");
const { GatewayRuntime } = await load("runtime.js");
const { AdtSession } = await load("adt/session.js");

const profilePath = arg("--profile");
if (profilePath === undefined) {
  process.stderr.write("live-families: --profile <system-id|env-file> is required\n");
  process.exit(2);
}
// 2026-11-07: resolve through `profile.mjs` like the server and `live-tools` do — a script that
// reads a .env file on its own can be pointed at a different host than the server it is testing.
// `loadProfile` accepts a system id from `adt-mcp.config.jsonc` or the path of a .env file.
const resolved = await loadProfile(profilePath, ROOT);
const env = {
  SAP_URL: resolved.url,
  SAP_CLIENT: resolved.client,
  SAP_LANGUAGE: resolved.language ?? "EN",
  SAP_USERNAME: resolved.username,
  SAP_PASSWORD: resolved.password,
  SAP_TIER: resolved.tier,
};
const only = arg("--only")?.split(",").map((value) => value.trim());
const tier = (env.SAP_TIER || "dev").toLowerCase();
const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
/**
 * Family id → the object-name prefix from `instructions/design/naming-objects.instructions.md`.
 * `$TMP` relaxes the *approval*, not the template: a probe that ignores the prefix table cannot be
 * reused as an example of a correctly named object.
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
  // 行为定义没有机判模板（`NAME_TEMPLATES` 里没有这一族），行为实现是类 ⇒ 必须 `ZCL_`，否则被拒。
  BehaviorDefinition: "ZMCP_MCP_",
  BehaviorImplementation: "ZCL_MCP_",
};
/** An include name carries its 2-digit type suffix, or the template check cannot recognise it. */
const name = (family) =>
  `${TYPE_PREFIX[family] ?? "ZMCP_MCP_"}${family.slice(0, 2).toUpperCase()}${tag}${family === "Include" ? "_I01" : ""}`;

const system = {
  id: "live",
  tier,
  endpoint: {
    url: env.SAP_URL,
    client: env.SAP_CLIENT,
    language: env.SAP_LANGUAGE || "EN",
    systemType: "onprem",
  },
  auth: { type: "basic", username: env.SAP_USERNAME, password: env.SAP_PASSWORD },
  rfcBackend: "soap",
  env: {},
};

const runtime = new GatewayRuntime([system], (s) =>
  new AdtSession({
    url: s.endpoint.url,
    client: s.endpoint.client,
    language: s.endpoint.language,
    username: env.SAP_USERNAME,
    password: env.SAP_PASSWORD,
    timeoutMs: 120_000,
  }),
);
const registry = createRegistry();
registerFamilies(registry, runtime);

/**
 * Arguments the sweep passed that the tool does not declare (2026-11-07).
 *
 * The registry rejects an undeclared argument outright (`INVALID_ARGUMENT`), so one stale fixture used
 * to turn a whole family red. Dropping the key keeps the sweep running, but the drop is **recorded** —
 * silently dropping arguments is how a fixture stays wrong for months.
 */
const unusedArgs = [];
/** Every tool this run really called — the same record `live-tools --report` keeps. */
const attempted = new Set();
const call = (tool, args = {}) => {
  attempted.add(tool);
  const props = schemaOf(registry, tool).properties ?? {};
  const kept = {};
  for (const [key, value] of Object.entries(args)) {
    if (props[key] === undefined) {
      unusedArgs.push(`${tool}.${key}`);
      continue;
    }
    kept[key] = value;
  }
  return registry.call(tool, kept, { system: "live" });
};

/** Adds `package_name` only for the tools that declare it (a function module lives in its group). */
const withPackage = (tool, args) => {
  const props = schemaOf(registry, tool).properties ?? {};
  return props.package_name === undefined ? args : { package_name: "$TMP", ...args };
};
/** The DDL used for both the view family and the metadata-extension prerequisite. */
function viewDdl(name) {
  return (
    `@AbapCatalog.sqlViewName: 'ZVMM_MCP_${name.slice(-4)}'\n` +
    "@AccessControl.authorizationCheck: #NOT_REQUIRED\n" +
    // A metadata extension cannot annotate a view that does not allow it: without this annotation
    // activation answers `Annotation 'Metadata.allowExtensions' missing in '<view>'` and the tool
    // restores the previous active source, so nothing changes (measured 2026-11-07).
    "@Metadata.allowExtensions: true\n" +
    "@EndUserText.label: 'live regression'\n" +
    `define view ${name} as select from t000\n` +
    "{\n" +
    "  key mandt as client,\n" +
    "      mtext as text\n" +
    "}\n" +
    "where mtext <> ''\n"
  );
}

/** Per-family fixtures: what to create, what to write, what must come back. */
function fixture(family, value) {
  const lower = value.toLowerCase();
  switch (family) {
    case "Program":
      return {
        create: { description: "live regression" },
        update: { source_code: `REPORT ${lower}.\n\nWRITE: / 'live regression'.\n` },
        marker: "live regression",
      };
    case "Class":
      return {
        create: {},
        update: {
          source_code:
            `CLASS ${lower} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n` +
            "  PUBLIC SECTION.\n" +
            "    METHODS run RETURNING VALUE(result) TYPE i.\n" +
            "ENDCLASS.\n" +
            `CLASS ${lower} IMPLEMENTATION.\n` +
            "  METHOD run.\n" +
            "    result = 1.\n" +
            "  ENDMETHOD.\n" +
            "ENDCLASS.\n",
        },
        marker: "METHOD run",
      };
    case "Interface":
      return {
        create: {},
        update: {
          source_code: `INTERFACE ${lower} PUBLIC.\n  METHODS run RETURNING VALUE(result) TYPE i.\nENDINTERFACE.\n`,
        },
        marker: "INTERFACE",
      };
    case "Table":
      return {
        create: {},
        update: {
          ddl_code:
            "@AbapCatalog.tableCategory : #TRANSPARENT\n" +
            "@AbapCatalog.deliveryClass : #A\n" +
            "@AbapCatalog.dataMaintenance : #RESTRICTED\n" +
            "@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n" +
            "@EndUserText.label : 'live regression'\n" +
            `define table ${lower} {\n` +
            "  key mandt : mandt not null;\n" +
            "  key id    : int4 not null;\n" +
            "      name  : char20;\n" +
            "}\n",
        },
        marker: "define table",
      };
    case "Structure":
      return {
        create: { fields: [{ name: "ID", data_element: "INT4" }, { name: "NAME", data_element: "CHAR20" }] },
        update: {
          ddl_code:
            "@EndUserText.label : 'live regression'\n" +
            "@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n" +
            `define structure ${lower} {\n` +
            "  id   : int4;\n" +
            "  name : char20;\n" +
            "}\n",
        },
        marker: "define structure",
      };
    case "DataElement":
      return {
        create: { description: "live regression", data_type: "CHAR", length: "20" },
        update: {
          package_name: "$TMP",
          description: "live regression v2",
          data_type: "CHAR",
          length: "30",
          field_label_short: "Live short",
        },
        // `UpdateDataElementLow` takes a `properties` blob whose shape is not in the declared schema —
        // the sweep cannot build it honestly, so the low update is skipped instead of guessing (2026-11-07).
        updateLow: null,
        marker: "dataElement",
      };
    case "Domain":
      return {
        create: { description: "live regression", datatype: "CHAR", length: "10" },
        update: {
          package_name: "$TMP",
          description: "live regression v2",
          datatype: "CHAR",
          length: "12",
          fixed_values: [{ low: "A", text: "Alpha" }, { low: "B", text: "Bravo" }],
        },
        updateLow: null,
        marker: "domain",
      };
    case "View":
    // 2026-11-07: the family is called `CdsView` in the registry; `View` (DDIC view) has no live
    // verbs at all, which is why the sweep used to stop with `no fixture for family "CdsView"`.
    case "CdsView":
      return {
        // `CreateCdsView` accepts the DDL, so the view exists with its definition
        // instead of being an empty shell until the first update.
        create: { ddl_source: viewDdl(value) },
        update: { ddl_source: viewDdl(value) },
        marker: "define view",
      };
    case "MetadataExtension":
      return {
        // Annotates the view created in `prepare`; a metadata extension has no
        // meaning on its own.
        create: {},
        update: {
          source_code:
            "@Metadata.layer: #CUSTOMER\n" +
            `annotate view ${value} with\n` +
            "{\n" +
            "  @EndUserText.label: 'live annotation'\n" +
            "  text;\n" +
            "}\n",
        },
        marker: "annotate view",
      };
    case "FunctionGroup":
      return {
        create: { description: "live regression group" },
        update: { description: "live regression group v2" },
        marker: "Include-files",
      };
    case "Include":
      return {
        create: { source_code: "* live regression include\nDATA gv_probe TYPE string.\n" },
        update: { source_code: "* live regression include\nDATA gv_probe TYPE i.\n" },
        marker: "live regression include",
      };
    case "FunctionModule":
      return {
        create: { description: "live regression module" },
        update: {
          source_code: `FUNCTION ${lower}\n  EXPORTING\n    VALUE(ev_result) TYPE i.\n  ev_result = 1.\nENDFUNCTION.\n`,
        },
        marker: "FUNCTION",
      };
    default:
      throw new Error(`no fixture for family "${family}"`);
  }
}

const results = [];

/**
 * Families that cannot be verified unattended, and why.
 *
 * A service definition only activates if it exposes a CDS entity that exists, so
 * it needs a real target; a package cannot be created at all without a
 * transportable super package and a transport request, and creating a request is
 * the user's decision.
 */
const NOT_LIVE = new Map([
  ["ServiceDefinition", "activation needs an existing CDS entity to expose — verify with a real target"],
  ["Package", "creation needs a transportable super package and a transport request"],
  ["BehaviorDefinition", "the logon user has no S_DEVELOP for BDEF: POST answers 403 (media type is accepted, authorisation is not)"],
  ["BehaviorImplementation", "same S_DEVELOP boundary as BDEF, and its body is a class include that needs a real BDEF behind it"],
  ["ServiceBinding", "needs a service definition that exposes a real CDS entity, and publication is a job, not a PUT"],
]);
const record = (family, verb, ok, detail) => {
  results.push({ family, verb, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${family.padEnd(18)} ${verb.padEnd(14)} ${detail}\n`);
};

/**
 * 404 / "not found" on a cleanup call is the good outcome: the object was already gone.
 * Anything else is a real failure and has to surface (2026-11-07).
 */
const alreadyGone = (error) => {
  const status = Number(error?.status ?? 0);
  if (status === 404) return true;
  const text = String(error?.message ?? error);
  return /already_gone|already gone|does not exist|not found|找不到|未能找到|不存在/i.test(text);
};

/** Runs one family; returns nothing, pushes into `results`. */
async function runFamily(family) {
  const id = family.id;
  const holder = { name: name(id), group: undefined };
  // The contract is not uniform: MetadataExtension reads and deletes with
  // `metadata_extension_name` but creates with `name`.
  const argsFor = (verb, extra = {}) => ({
    [family.nameParamByVerb?.[verb] ?? family.nameParam]: holder.name,
    ...(holder.group === undefined ? {} : { function_group_name: holder.group }),
    ...extra,
  });
  let created = false;

  // A metadata extension annotates a view: the view keeps the plain name, the extension is
  // `<view>_MD`. Giving both the same name creates and reads fine and only fails at activation.
  if (id === "MetadataExtension") {
    holder.target = holder.name;
    holder.name = `${holder.name}_MD`;
  }

  try {
    // A function module needs a group; a metadata extension needs a view.
    if (id === "FunctionModule") {
      holder.group = name("FunctionGroup");
      await call("CreateFunctionGroup", { function_group_name: holder.group, package_name: "$TMP", description: "live parent" });
    }
    if (id === "MetadataExtension") {
      await call("CreateCdsView", { view_name: holder.target, package_name: "$TMP", ddl_source: viewDdl(holder.target) });
    }

    const fix = fixture(id, holder.target ?? holder.name);

    if (registry.has(`Validate${id}Low`)) {
      const validate = await call(
        `Validate${id}Low`,
        argsFor("Validate", withPackage(`Validate${id}Low`, { description: "live regression" })),
      );
      record(id, "Validate", validate.available !== false, JSON.stringify(validate).slice(0, 90));
    }

    const created1 = await call(`Create${id}`, argsFor("Create", withPackage(`Create${id}`, { ...fix.create })));
    created = true;
    record(id, "Create", created1.success === true, `activated=${created1.activated}`);

    const read = registry.has(`Read${id}`) ? await call(`Read${id}`, argsFor("Read")) : undefined;
    if (read !== undefined) {
      record(id, "Read", read.success !== false, `${read.line_count ?? read.content_type ?? "content"}`);
    }

    const got = registry.has(`Get${id}`) ? await call(`Get${id}`, argsFor("Get")) : undefined;
    if (got !== undefined) {
      record(id, "Get", got.success !== false, `${String(got.source_code ?? got.content ?? "").length} chars`);
    }

    const updated = await call(`Update${id}`, argsFor("Update", fix.update));
    // 2026-11-07: `activated` is false when the tool's payload-vs-active comparison differs, even
    // though SAP normalises DDIC DDL (uppercase annotations, reordered) and the object *is* active —
    // `status: activated` is the signal that the verb worked. The mismatch itself stays in the detail.
    const updateOk = updated.activated === true || String(updated.status ?? "").toLowerCase() === "activated";
    record(
      id,
      "Update",
      updateOk,
      `activated=${updated.activated} status=${String(updated.status ?? "").slice(0, 40)}${updated.mismatch === undefined ? "" : ` mismatch=${updated.mismatch}`}`,
    );

    if (registry.has(`Lock${id}Low`)) {
      const lock = await call(`Lock${id}Low`, argsFor("Lock"));
      const lockHandle = lock.lock_handle;
      record(id, "Lock", typeof lockHandle === "string" && lockHandle.length > 0, `transport=${lock.transport_request ?? "(none)"}`);

      if (registry.has(`Update${id}Low`) && fix.updateLow !== null) {
        const lowUpdate = await call(`Update${id}Low`, argsFor("Update", { ...(fix.updateLow ?? fix.update), lock_handle: lockHandle }));
        record(id, "UpdateLow", lowUpdate.success === true, "written, deliberately not activated");
      } else if (fix.updateLow === null) {
        record(id, "UpdateLow", true, "skipped: the low verb takes an opaque `properties` blob");
      }

      // `session_id` is not uniform: most `Unlock*Low` verbs require it, `UnlockClassLow` does not
      // declare it at all (2026-11-07: passing it always → INVALID_ARGUMENT; never passing it →
      // `missing "session_id"` on the other ten). Ask the declared schema, do not guess.
      const unlockArgs = argsFor("Unlock", { lock_handle: lockHandle });
      if ((schemaOf(registry, `Unlock${id}Low`).properties ?? {}).session_id !== undefined) {
        unlockArgs.session_id = lock.session_id;
      }
      const unlock = await call(`Unlock${id}Low`, unlockArgs);
      record(id, "Unlock", unlock.success === true, "ok");
    }

    const check = registry.has(`Check${id}Low`) ? await call(`Check${id}Low`, argsFor("Check")) : undefined;
    if (check !== undefined) {
      record(id, "Check", check.errors === 0, `errors=${check.errors} warnings=${check.warnings}`);
    }

    const activate = registry.has(`Activate${id}Low`) ? await call(`Activate${id}Low`, argsFor("Activate")) : undefined;
    if (activate !== undefined) {
      record(id, "ActivateLow", activate.activated === true, String(activate.status ?? "").slice(0, 48));
    }

    const readBackTool = registry.has(`Read${id}`) ? `Read${id}` : `Get${id}`;
    if (registry.has(readBackTool)) {
      const readBack = await call(readBackTool, argsFor("Read"));
      record(id, "Read active", String(readBack.source_code ?? readBack.content ?? "").length > 0, "content present");
    }

    const goneProbeTool = registry.has(`Read${id}`) ? `Read${id}` : `Get${id}`;
    await call(`Delete${id}`, argsFor("Delete"));
    created = false;

    let gone = false;
    try {
      await call(goneProbeTool, argsFor("Read"));
    } catch {
      gone = true;
    }
    record(id, "Delete", gone, gone ? "object removed" : "STILL READABLE");
  } catch (error) {
    record(id, "ERROR", false, String(error.message ?? error).slice(0, 160));
  } finally {
    // 2026-11-07: the fallback delete used to be `.catch(() => undefined)` — a failure left no trace
    // at all, so a fully green run could still leave the object in the system (that is exactly how
    // `live-tools` accumulated 19 objects). A failed cleanup is now a FAIL entry, which feeds the
    // exit code and the leftover list at the end.
    const sweep = async (label, tool, args) => {
      try {
        await call(tool, args);
      } catch (error) {
        if (alreadyGone(error)) return;
        record(id, `cleanup:${label}`, false, `${tool} failed: ${String(error?.code ?? "error")} ${String(error?.message ?? error).slice(0, 120)}`);
      }
    };
    if (created) await sweep("object", `Delete${id}`, argsFor("Delete"));
    if (id === "MetadataExtension") await sweep("view", "DeleteCdsView", { view_name: holder.target });
    if (id === "FunctionModule" && holder.group !== undefined) await sweep("group", "DeleteFunctionGroup", { function_group_name: holder.group });
  }
}

const selected = implementedFamilies.filter(
  (family) => (only === undefined || only.includes(family.id)) && !NOT_LIVE.has(family.id),
);
for (const family of implementedFamilies) {
  if (NOT_LIVE.has(family.id) && (only === undefined || only.includes(family.id))) {
    process.stdout.write(`SKIP ${family.id.padEnd(18)} ${NOT_LIVE.get(family.id)}\n`);
  }
}
process.stdout.write(`live-families: ${selected.length} family/ies against ${env.SAP_URL.replace(/\/+$/, "")} client ${env.SAP_CLIENT} tier ${tier}\n`);

for (const family of selected) {
  await runFamily(family);
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
// 2026-11-07: 被丢弃的未声明参数必须点名 —— 它们就是「fixture 与契约漂移」的痕迹。
if (unusedArgs.length > 0) {
  const unique = [...new Set(unusedArgs)].sort();
  process.stdout.write(`unused arguments dropped (${unique.length}): ${unique.join(", ")}\n`);
}
// 2026-11-07: 末尾必须点名「可能还活着」的对象 —— 只报 checks passed 会让人以为系统是干净的。
const leftovers = results.filter((entry) => !entry.ok && (entry.verb === "Delete" || String(entry.verb).startsWith("cleanup:")));
if (leftovers.length > 0) {
  process.stdout.write(`leftovers: ${leftovers.length} object(s) may still exist — remove with tools/scripts/live-cleanup.mjs:\n`);
  for (const entry of leftovers) process.stdout.write(`  ${entry.family} ${entry.verb}: ${entry.detail}\n`);
}
// `--report <path>`: same shape as `live-tools --report` (`{ tools: [...] }`, accumulated across
// runs), so `live-tools --check` can union the two sweeps and answer "335 of 335 exercised".
const reportPath = arg("--report");
if (reportPath !== undefined) {
  let earlier = [];
  try {
    earlier = JSON.parse(readFileSync(reportPath, "utf8")).tools ?? [];
  } catch {
    earlier = [];
  }
  const tools = [...new Set([...earlier, ...attempted])].sort();
  writeFileSync(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), tools }, null, 2)}\n`);
  process.stdout.write(`report: ${reportPath} (${tools.length} tool(s), ${attempted.size} this run)\n`);
}
if (failed.length > 0) {
  for (const entry of failed) process.stdout.write(`  ${entry.family} ${entry.verb}: ${entry.detail}\n`);
  // Set the code instead of calling process.exit(): exiting while the fetch
  // pool still holds sockets trips a libuv assertion on Windows.
  process.exitCode = 1;
}
