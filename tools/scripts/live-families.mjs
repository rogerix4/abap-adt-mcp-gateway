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
 *   node tools/scripts/live-families.mjs --profile <path/to/system.env> [--only Program,Class]
 *
 * MetadataExtension has no payload of its own — it annotates an existing view —
 * so it creates a view first and cleans that up afterwards.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function loadProfile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    // Profiles carry trailing `#` hints; they are not part of the value.
    if (match) env[match[1]] = match[2].split(/\s+#/)[0].replace(/^["']|["']$/g, "").trim();
  }
  for (const key of ["SAP_URL", "SAP_CLIENT", "SAP_USERNAME", "SAP_PASSWORD"]) {
    if (env[key] === undefined || env[key].length === 0) {
      process.stderr.write(`live-families: profile is missing ${key}\n`);
      process.exit(2);
    }
  }
  return env;
}

const load = (relative) => import(pathToFileURL(join(ROOT, "dist", relative)).href);
const { createRegistry } = await load("engine/create-registry.js");
const { registerFamilies, implementedFamilies } = await load("families/index.js");
const { GatewayRuntime } = await load("runtime.js");
const { AdtSession } = await load("adt/session.js");

const profilePath = arg("--profile");
if (profilePath === undefined) {
  process.stderr.write("live-families: --profile <path> is required\n");
  process.exit(2);
}
const env = loadProfile(profilePath);
const only = arg("--only")?.split(",").map((value) => value.trim());
const tier = (env.SAP_TIER || "dev").toLowerCase();
const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
const name = (prefix) => `ZZ${prefix}${tag}`;

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

const call = (tool, args) => registry.call(tool, args, { system: "live" });

/** The DDL used for both the view family and the metadata-extension prerequisite. */
function viewDdl(name) {
  return (
    `@AbapCatalog.sqlViewName: 'ZZV${name.slice(-4)}'\n` +
    "@AccessControl.authorizationCheck: #NOT_REQUIRED\n" +
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
          source_code:
            "@AbapCatalog.tableCategory : #TRANSPARENT\n" +
            "@AbapCatalog.deliveryClass : #A\n" +
            "@AbapCatalog.dataMaintenance : #RESTRICTED\n" +
            `define table ${lower} {\n` +
            "  key mandt : mandt not null;\n" +
            "  key id    : abap.int4 not null;\n" +
            "  name      : abap.char(20);\n" +
            "}\n",
        },
        marker: "define table",
      };
    case "Structure":
      return {
        create: { fields: [{ name: "ID", data_type: "INT4" }, { name: "NAME", data_type: "CHAR", length: 20 }] },
        update: {
          source_code: `define structure ${lower} {\n  id   : abap.int4;\n  name : abap.char(20);\n}\n`,
        },
        marker: "define structure",
      };
    case "DataElement":
      return {
        create: { description: "live regression", data_type: "CHAR", length: "20" },
        update: { package_name: "$TMP", length: "30", field_label_short: "Live short" },
        marker: "dataElement",
      };
    case "Domain":
      return {
        create: { description: "live regression", datatype: "CHAR", length: "10" },
        update: {
          package_name: "$TMP",
          length: "12",
          fixed_values: [{ low: "A", text: "Alpha" }, { low: "B", text: "Bravo" }],
        },
        marker: "domain",
      };
    case "View":
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

/** Runs one family; returns nothing, pushes into `results`. */
async function runFamily(family) {
  const id = family.id;
  const holder = { name: name(id.slice(0, 2).toUpperCase()), group: undefined };
  // The contract is not uniform: MetadataExtension reads and deletes with
  // `metadata_extension_name` but creates with `name`.
  const argsFor = (verb, extra = {}) => ({
    [family.nameParamByVerb?.[verb] ?? family.nameParam]: holder.name,
    ...(holder.group === undefined ? {} : { function_group_name: holder.group }),
    ...extra,
  });
  let created = false;

  try {
    // A function module needs a group; a metadata extension needs a view.
    if (id === "FunctionModule") {
      holder.group = name("FG");
      await call("CreateFunctionGroup", { function_group_name: holder.group, package_name: "$TMP", description: "live parent" });
    }
    if (id === "MetadataExtension") {
      await call("CreateCdsView", { view_name: holder.name, package_name: "$TMP", ddl_source: viewDdl(holder.name) });
    }

    const fix = fixture(id, holder.name);

    if (registry.has(`Validate${id}Low`)) {
      const validate = await call(
        `Validate${id}Low`,
        argsFor("Validate", { description: "live regression", package_name: "$TMP" }),
      );
      record(id, "Validate", validate.available !== false, JSON.stringify(validate).slice(0, 90));
    }

    const created1 = await call(`Create${id}`, argsFor("Create", { package_name: "$TMP", ...fix.create }));
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
    record(
      id,
      "Update",
      updated.activated === true,
      `activated=${updated.activated} status=${String(updated.status ?? "").slice(0, 40)}${updated.mismatch === undefined ? "" : ` mismatch=${updated.mismatch}`}`,
    );

    if (registry.has(`Lock${id}Low`)) {
      const lock = await call(`Lock${id}Low`, argsFor("Lock"));
      const lockHandle = lock.lock_handle;
      record(id, "Lock", typeof lockHandle === "string" && lockHandle.length > 0, `transport=${lock.transport_request ?? "(none)"}`);

      if (registry.has(`Update${id}Low`)) {
        const lowUpdate = await call(`Update${id}Low`, argsFor("Update", { ...fix.update, lock_handle: lockHandle }));
        record(id, "UpdateLow", lowUpdate.success === true, "written, deliberately not activated");
      }

      const unlock = await call(`Unlock${id}Low`, argsFor("Unlock", { lock_handle: lockHandle, session_id: lock.session_id }));
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
    if (created) {
      await call(`Delete${id}`, argsFor("Delete")).catch(() => undefined);
    }
    if (id === "MetadataExtension") {
      await call("DeleteCdsView", { view_name: holder.name }).catch(() => undefined);
    }
    if (id === "FunctionModule" && holder.group !== undefined) {
      await call("DeleteFunctionGroup", { function_group_name: holder.group }).catch(() => undefined);
    }
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
if (failed.length > 0) {
  for (const entry of failed) process.stdout.write(`  ${entry.family} ${entry.verb}: ${entry.detail}\n`);
  // Set the code instead of calling process.exit(): exiting while the fetch
  // pool still holds sockets trips a libuv assertion on Windows.
  process.exitCode = 1;
}
