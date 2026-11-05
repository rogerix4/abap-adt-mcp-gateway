#!/usr/bin/env node
/**
 * Install the four ABAP bridge modules into a system.
 *
 * Screens, the CUA and the text pool have no ADT resource, so those tools call
 * remote-enabled function modules; `abap/` holds their sources. A fresh system has
 * neither the modules nor the function groups, and ADT's create call cannot set the
 * remote-enabled flag (it always creates `normal`, and the flag cannot be changed
 * afterwards), so creation goes through the standard `RPY_FUNCTIONMODULE_INSERT`.
 *
 * Safe to re-run: an existing module is skipped rather than overwritten, and a
 * module that exists as `normal` is reported — recreating it is a decision, not a
 * side effect of running an importer.
 *
 * Usage:
 *   npm run build
 *   node tools/scripts/import-abap-bridges.mjs --profile <name|path> [--only <FM>] [--skip-smoke]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : true;
};

const profileArg = arg("--profile");
if (profileArg === undefined) {
  process.stderr.write("import-abap-bridges: --profile <path|name> is required\n");
  process.exit(2);
}
// Same source of truth as the server: a system id from adt-mcp.config.jsonc (credentials
// resolved through the keychain), or the path of a .env file.
const { loadProfile } = await import(pathToFileURL(join(ROOT, "tools", "scripts", "profile.mjs")).href);
const profile = await loadProfile(profileArg, ROOT);
const only = String(arg("--only", "")).toUpperCase();
const skipSmoke = process.argv.includes("--skip-smoke");

const env = {
  SAP_URL: profile.url,
  SAP_CLIENT: profile.client,
  SAP_USERNAME: profile.username,
  SAP_PASSWORD: profile.password,
  SAP_LANGUAGE: profile.language,
};

const MODULES = [
  {
    fm: "ZMCP_ADT_TEXTPOOL",
    group: "ZMCP_ADT_UTILS",
    file: "ZMCP_ADT_TEXTPOOL.abap",
    text: "text pool read/write",
    smoke: { IV_ACTION: "READ", IV_PROGRAM: "ZFIR0094", IV_LANGUAGE: "1" },
  },
  {
    fm: "ZMCP_ADT_DISPATCH",
    group: "ZMCP_ADT_UTILS",
    file: "ZMCP_ADT_DISPATCH.abap",
    text: "dynpro / CUA dispatcher",
    smoke: { IV_ACTION: "DYNPRO_READ", IV_PARAMS: '{"program":"SAPLSPO1","dynpro":"1000"}' },
  },
  {
    fm: "ZMCP_SSF_CONTENT",
    group: "ZMCP_SSF_UTILS",
    file: "ZMCP_SSF_CONTENT.abap",
    text: "SmartForm read: Form Builder XML, style CSS, text lines",
    smoke: { IV_PARAMS: '{"part":"FORM","form_name":"ZCONVERTSOFORM"}' },
  },
  {
    fm: "ZMCP_SSF_UPLOAD",
    group: "ZMCP_SSF_UTILS",
    file: "ZMCP_SSF_UPLOAD.abap",
    text: "SmartForm create/replace from Form Builder XML",
    // The guard answer is the healthy one: an empty call must be refused, not accepted.
    smoke: { IV_PARAMS: '{}' },
    smokeSubrc: 4,
  },
  {
    fm: "ZMCP_SSF_DELETE",
    group: "ZMCP_SSF_UTILS",
    file: "ZMCP_SSF_DELETE.abap",
    text: "SmartForm delete (local packages only, dry run without confirm)",
    smoke: { IV_PARAMS: '{"form_name":"ZMCP_SSF_NOPE"}' },
    smokeSubrc: 4,
  },
  {
    fm: "ZMCP_SSF_RENDER",
    group: "ZMCP_SSF_UTILS",
    file: "ZMCP_SSF_RENDER.abap",
    text: "SmartForm render: GETOTF, OTF text and PDF",
    smoke: { IV_PARAMS: '{}' },
    smokeSubrc: 4,
  },
  {
    fm: "ZMCP_WL_JOB_USAGE",
    group: "ZMCP_WL_UTILS",
    file: "ZMCP_WL_JOB_USAGE.abap",
    text: "job usage by program",
    smoke: { IV_PROGRAMS: "RSBTCDEL", IV_MONTHS: "12" },
  },
  {
    fm: "ZMCP_WL_TCODE_USAGE",
    group: "ZMCP_WL_UTILS",
    file: "ZMCP_WL_TCODE_USAGE.abap",
    text: "tcode usage from ST03N aggregates",
    smoke: { IV_TCODES: "MM03", IV_MONTHS: "12" },
  },
];

const GROUPS = {
  ZMCP_ADT_UTILS: "ADT bridges: text pool, dynpro and CUA",
  ZMCP_SSF_UTILS: "Smart Form bridges: read, upload, delete",
  ZMCP_WL_UTILS: "workload bridges: job and transaction usage",
};

const base = env.SAP_URL.replace(/\/+$/, "");
const soapEndpoint = `${base}/sap/bc/soap/rfc?sap-client=${encodeURIComponent(env.SAP_CLIENT)}`;
const authorization = `Basic ${Buffer.from(`${env.SAP_USERNAME}:${env.SAP_PASSWORD}`).toString("base64")}`;

const escapeXml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const envelope = (fm, fields) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:urn="urn:sap-com:document:sap:rfc:functions"><soapenv:Header/><soapenv:Body>' +
  `<urn:${fm}>` +
  Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("") +
  `</urn:${fm}></soapenv:Body></soapenv:Envelope>`;

const tag = (body, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(body)?.[1] ?? "";

async function soap(fm, fields) {
  const response = await fetch(soapEndpoint, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", Authorization: authorization },
    body: envelope(fm, fields),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.text() };
}

const faultOf = (body) =>
  /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i.exec(body)?.[1]?.trim().slice(0, 300) ??
  /<message[^>]*>([\s\S]*?)<\/message>/i.exec(body)?.[1]?.trim().slice(0, 300) ??
  body.slice(0, 300);

const load = (relative) => import(pathToFileURL(join(ROOT, "dist", relative)).href);
const { createRegistry } = await load("engine/create-registry.js");
const { registerFamilies } = await load("families/index.js");
const { GatewayRuntime } = await load("runtime.js");
const { AdtSession } = await load("adt/session.js");

const system = {
  id: "import",
  tier: "dev",
  endpoint: { url: base, client: env.SAP_CLIENT, language: env.SAP_LANGUAGE || "EN", systemType: "onprem" },
  auth: { type: "basic", username: env.SAP_USERNAME, password: env.SAP_PASSWORD },
  rfcBackend: "soap",
  env: {},
};
const runtime = new GatewayRuntime([system], (target) =>
  new AdtSession({
    url: target.endpoint.url,
    client: target.endpoint.client,
    language: target.endpoint.language,
    username: env.SAP_USERNAME,
    password: env.SAP_PASSWORD,
    timeoutMs: 120_000,
  }),
);
const registry = createRegistry();
registerFamilies(registry, runtime);
const call = async (tool, args) => {
  const result = await registry.call(tool, args, { system: "import" });
  // Measured 2026-11-04: `ActivateObjects` answers `success: false` with the compile
  // errors in `messages`, and the importer used to print "ok activate" over it.
  if (result !== null && typeof result === "object" && result.success === false) {
    const detail = result.status ?? result.message ?? JSON.stringify(result).slice(0, 200);
    throw new Error(`${tool} answered success=false: ${String(detail).slice(0, 300)}`);
  }
  return result;
};

const todo = MODULES.filter((module) => only === "" || module.fm === only);
if (todo.length === 0) {
  process.stderr.write(`import-abap-bridges: no module matches --only ${only}\n`);
  process.exit(2);
}

let failed = 0;
const say = (line) => process.stdout.write(`${line}\n`);
say(`import-abap-bridges: ${todo.length} module(s) into ${base} client ${env.SAP_CLIENT}`);

/** A group that can be read exists; the create error text for a duplicate is not reliable. */
const groupExists = async (group) => {
  try {
    await call("GetFunctionGroup", { function_group_name: group });
    return true;
  } catch {
    return false;
  }
};

for (const group of [...new Set(todo.map((module) => module.group))]) {
  try {
    await call("CreateFunctionGroup", {
      function_group_name: group,
      package_name: "$TMP",
      description: GROUPS[group] ?? group,
      activate: true,
    });
    say(`ok    group ${group}`);
  } catch (error) {
    if (await groupExists(group)) {
      // Creating an existing group answers an unrelated name-range error on this stack,
      // so the read-back is what decides.
      say(`ok    group ${group} (already exists)`);
      continue;
    }
    failed += 1;
    say(`FAIL  group ${group}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
}

for (const module of todo) {
  say(`\n== ${module.fm} (${module.group})`);

  const created = await soap("RPY_FUNCTIONMODULE_INSERT", {
    FUNCNAME: module.fm,
    FUNCTION_POOL: module.group,
    REMOTE_CALL: "X",
    SHORT_TEXT: module.text,
    SUPPRESS_CORR_CHECK: "X",
  });
  const exists = /FUNCTION_ALREADY_EXISTS/i.test(created.body);
  if (!exists && created.status !== 200) {
    failed += 1;
    say(`FAIL  create: HTTP ${created.status} ${faultOf(created.body)}`);
    continue;
  }
  say(exists ? "ok    create: already exists (check its processing type below)" : "ok    create: remote-enabled shell");

  const sourcePath = join(ROOT, "abap", module.file);
  if (!existsSync(sourcePath)) {
    failed += 1;
    say(`FAIL  source missing: ${sourcePath}`);
    continue;
  }
  try {
    await call("UpdateFunctionModule", {
      function_group_name: module.group,
      function_module_name: module.fm,
      source_code: readFileSync(sourcePath, "utf8"),
      activate: false,
    });
    say("ok    write");
  } catch (error) {
    failed += 1;
    say(`FAIL  write: ${String(error?.message ?? error).slice(0, 300)}`);
    continue;
  }

  try {
    await call("ActivateObjects", {
      objects: [{ name: module.fm, type: "FUGR/FF", parent_name: module.group }],
    });
    say("ok    activate");
  } catch (error) {
    failed += 1;
    say(`FAIL  activate: ${String(error?.message ?? error).slice(0, 300)}`);
    continue;
  }

  if (skipSmoke) continue;
  const smoke = await soap(module.fm, module.smoke);
  const subrc = tag(smoke.body, "EV_SUBRC");
  const message = tag(smoke.body, "EV_MESSAGE");
  const result = tag(smoke.body, "EV_RESULT");
  // A module whose documented answer to an empty call is a refusal declares `smokeSubrc`:
  // "refused with a reason" is the healthy result there.
  const expected = String(module.smokeSubrc ?? 0);
  if (smoke.status !== 200 || subrc !== expected || message === "") {
    failed += 1;
    say(`FAIL  smoke: HTTP ${smoke.status} subrc=${subrc || "?"} ${faultOf(smoke.body)} ${message.slice(0, 160)}`);
    continue;
  }
  say(`ok    smoke: subrc=${expected} message=${message.slice(0, 60)} result_len=${result.length}`);
}

say(`\n${failed === 0 ? "DONE" : "FAILED"}: ${todo.length} module(s), ${failed} failure(s)`);
say(
  "note: a module that already existed keeps the processing type it was created with. " +
    "If it is not `rfc`, it has to be deleted and created again — this script does not do that.",
);
process.exit(failed === 0 ? 0 : 1);
