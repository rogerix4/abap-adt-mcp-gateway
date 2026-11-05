/**
 * Route probe: tells which of the table-driven routes the system recognises.
 *
 * It does not check payloads — it checks that the path and the media type are
 * right, which is the part that was guessed. The classification is what matters:
 *
 *   200/201/204  route exists and answered
 *   400/405      route exists, the arguments were synthetic (still a pass)
 *   401/403      route exists, this logon may not use it (still a pass)
 *   404          either the path has no URI mapping, or the path is right and the
 *                sample object does not exist. SAP repeats the path in both cases, so
 *                the probe asks `/discovery` which collections exist: a path an
 *                advertised collection could serve means the object was missing, a
 *                path no collection covers is a wrong route ("no suitable resource found" /
 *                "No URI-Mapping defined" is that same answer, spelled out).
 *                A path that is only partly covered cannot be decided with a
 *                synthetic object and is reported as such.
 *   415          wrong media type
 *   other        needs a look
 *
 * Usage: node tools/scripts/probe-routes.mjs --profile <env> [--filter <substring>]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const profileArg = arg("--profile");
if (profileArg === undefined) {
  process.stderr.write("probe-routes: --profile <system-id|env-file> is required\n");
  process.exit(2);
}
// Same source of truth as the server: a system id from adt-mcp.config.jsonc (credentials
// resolved through the keychain), or the path of a .env file.
const { loadProfile } = await import(pathToFileURL(join(ROOT, "tools", "scripts", "profile.mjs")).href);
const profile = await loadProfile(profileArg, ROOT);
const filter = arg("--filter", undefined);
/**
 * The route table is one third of the catalog. `--families` adds the verbs the
 * families implement (Create/Update/Delete/Lock/…), which no probe reached before
 * — a wrong path there means one whole object type cannot be created.
 */
const includeFamilies = process.argv.includes("--families");
/** Builds every request without sending one: the paths are the point, not SAP. */
const dryRun = process.argv.includes("--dry-run");

const load = (relative) => import(pathToFileURL(join(ROOT, "dist", relative)).href);
const { createRegistry } = await load("engine/create-registry.js");
const { registerFamilies } = await load("families/index.js");
const { routeToolNames, bridgedRouteToolNames } = await load("tools/routes.js");
const { BRIDGE_TOOL_NAMES } = await load("tools/bridges.js");
const { GatewayRuntime } = await load("runtime.js");
const { AdtSession } = await load("adt/session.js");

const system = {
  id: "probe",
  tier: "dev",
  endpoint: {
    url: profile.url,
    client: profile.client,
    language: profile.language || "EN",
    systemType: "onprem",
  },
  auth: { type: "basic", username: profile.username, password: profile.password },
  rfcBackend: "soap",
  env: {},
};
const requests = [];
/** In a dry run nothing leaves the process; the URL it would have asked for is the finding. */
const recordingFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  requests.push({ method: init?.method ?? "GET", url });
  const body = String(url).includes("_action=LOCK")
    ? '<asx:abap><asx:values><DATA><LOCK_HANDLE>DRYRUN0000</LOCK_HANDLE><CORRNR>DRYRUN1</CORRNR><IS_LOCAL>X</IS_LOCAL></DATA></asx:values></asx:abap>'
    : "<ok/>";
  return new Response(body, { status: 200, headers: { "x-csrf-token": "dry" } });
};

const makeRuntime = (fetchImpl) =>
  new GatewayRuntime(
    [system],
    (s) =>
      new AdtSession({
        url: s.endpoint.url,
        client: s.endpoint.client,
        language: s.endpoint.language,
        username: profile.username,
        password: profile.password,
        timeoutMs: 60_000,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      }),
  );
const makeRegistry = (fetchImpl) => {
  const registry = createRegistry();
  registerFamilies(registry, makeRuntime(fetchImpl));
  return registry;
};
/** Reads go to the system; writes are only checked for the path they build. */
const registry = makeRegistry();
const dryRegistry = makeRegistry(recordingFetch);

// Synthetic arguments: they only have to be non-empty so the path can be filled.
const synthetic = {
  program_name: "ZZ_PROBE_ROUTE",
  class_name: "ZCL_PROBE_ROUTE",
  object_name: "ZZ_PROBE_ROUTE",
  objecttype: "PROG/P",
  object_uri: "/sap/bc/adt/programs/programs/zz_probe_route",
  package_name: "$TMP",
  parent_type: "DEVC/K",
  parent_name: "$TMP",
  parent_tech_name: "$TMP",
  node_id: "000000",
  screen_number: "0100",
  status_name: "STATUS_0100",
  transaction_name: "SE38",
  type_name: "MANDT",
  handler_name: "ZZ_PROBE_HANDLER",
  dump_id: "00000000000000000000000000000000",
  trace_id: "00000000000000000000000000000000",
  trace_id_or_uri: "00000000000000000000000000000000",
  run_id: "0",
  transport_number: "S4HK000000",
  table_name: "T000",
  max_rows: "1",
  max_results: "1",
  form_name: "ZZ_PROBE_FORM",
  enhancement_spot: "ZZ_PROBE_SPOT",
  enhancement_name: "ZZ_PROBE_IMPL",
  badi_name: "ZZ_PROBE_BADI",
  name: "ZZ_PROBE_ROUTE",
  objectname: "ZZ_PROBE_ROUTE",  object_type: "PROG/P",
  type: "PROG/P",
  tech_name: "ZZ_PROBE_ROUTE",
  lock_handle: "0000000000000000000000000000000000000000",
  tests: [{ container_class: "CL_ABAP_TYPEDESCR", test_class: "LTCL_PROBE" }],
  run_id: "0",
  text_elements:
    '<?xml version="1.0" encoding="utf-8"?><rept:textElement xmlns:rept="http://www.sap.com/adt/textelements">' +
    '<rept:symbols><rept:entry key="001" maxLength="10">probe</rept:entry></rept:symbols></rept:textElement>',
};

const buckets = {
  ok: [],
  badPath: [],
  missingObject: [],
  ambiguous: [],
  badMedia: [],
  declared: [],
  other: [],
  bridged: [],
  dryChecked: [],
  skipped: [],
};

// Ask the system which collections exist. A 404 that echoes a path is only proof of a
// wrong route when no advertised collection could have served it.
let collections = [];
try {
  const discovery = await new AdtSession({
    url: system.endpoint.url,
    client: system.endpoint.client,
    language: system.endpoint.language,
    username: profile.username,
    password: profile.password,
    timeoutMs: 60_000,
    ...(dryRun ? { fetchImpl: recordingFetch } : {}),
  }).request({ path: "/sap/bc/adt/discovery", accept: "application/atomsvc+xml", timeoutMs: 60_000, absolute: true });
  collections = [...discovery.body.matchAll(/<app:collection href="([^"]+)"/g)]
    .map((match) => match[1].split("{")[0].replace(/\/$/, ""))
    .filter((href) => href !== "");
} catch {
  collections = [];
}

/** True when an advertised collection could serve this path (it is a prefix of it). */
const collectionCovers = (path) =>
  collections.some((href) => path === href || path.startsWith(`${href}/`));
const bridged = new Set(bridgedRouteToolNames());
/**
 * Verbs that change the system. The probe fires every tool it can reach, so these are
 * sent to the recording fetch instead: a path is what the probe is after, and a real
 * write leaves an object behind in whatever system it ran against.
 */
const isWriteVerb = (name) =>
  /^(Create|Update|Delete|Activate|Lock|Unlock|Patch|Publish|Set|Reset|Move|Import)/.test(name) ||
  /^Handler(Create|Update|Delete|Activate|Lock|Unlock|Patch|TransportCreate)/.test(name);

/** Family verbs take the same name arguments; one set covers every family. */
const familyArgs = {
  ...synthetic,
  interface_name: "ZIF_PROBE_ROUTE",
  table_name: "ZZPROBETABLE",
  structure_name: "ZZS_PROBE_ROUTE",
  domain_name: "ZZD_PROBE_ROUTE",
  data_element_name: "ZZE_PROBE_ROUTE",
  table_type_name: "ZZTT_PROBE_ROUTE",
  view_name: "ZZV_PROBE_ROUTE",
  function_group_name: "ZFG_PROBE_ROUTE",
  function_module_name: "Z_PROBE_ROUTE_FM",
  behavior_definition_name: "ZBD_PROBE_ROUTE",
  metadata_extension_name: "ZME_PROBE_ROUTE",
  service_definition_name: "ZSD_PROBE_ROUTE",
  service_binding_name: "ZSB_PROBE_ROUTE",
  include_name: "ZZ_PROBE_INCLUDE",
  main_program: "ZZ_PROBE_ROUTE",
  description: "probe",
  language: "EN",
  source_code: "REPORT zz_probe_route.\n",
  definitions_code: "TYPES ty_probe TYPE i.\n",
  macros_code: "DEFINE m_probe.\nEND-OF-DEFINITION.\n",
  types_code: "TYPES ty_probe TYPE i.\n",
  test_class_code: "CLASS ltc_probe DEFINITION FOR TESTING.\nENDCLASS.\n",
  test_class_source: "CLASS ltc_probe DEFINITION FOR TESTING.\nENDCLASS.\n",
  body: "<probe/>",
  tests: [{ container_class: "CL_ABAP_TYPEDESCR", test_class: "LTCL_PROBE" }],
  run_id: "0",
  sql_query: "SELECT MANDT FROM T000",
  ddl_source:
    "@AccessControl.authorizationCheck: #NOT_REQUIRED\n" +
    "@EndUserText.label: 'probe'\n" +
    "define view entity ZI_PROBE_ROUTE as select from t000 { key mandt }",
  dynpro_data: '{"screen":{"number":"0100"}}',
  cua_data: '{"ADM":{},"STA":[]}',
  super_package: "$TMP",
  pattern: "ZZ_PROBE*",
  search_term: "ZZ_PROBE_ROUTE",
};

const familyToolNames = includeFamilies
  ? (JSON.parse(readFileSync(join(ROOT, "tools/catalog.json"), "utf8")).tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => !routeToolNames().includes(name) && !BRIDGE_TOOL_NAMES.has(name))
  : [];

const names = [...routeToolNames(), ...familyToolNames].filter(
  (name) => filter === undefined || name.includes(filter),
);
process.stdout.write(
  `probe-routes: ${names.length} tool(s) — ${routeToolNames().length} route, ` +
    `${familyToolNames.length} family/bridge${dryRun ? " (dry run, nothing is sent)" : ""}\n`,
);

/** SAP echoes the request path when the resource has no URI mapping at all. */
const echoesRequestPath = (message) =>
  // SAP pads the echo with an extra space ("Resource  /sap/bc/adt/...") on some releases.
  /Resource\s+\/sap\/bc\/adt\//.test(message) ||
  // SAP answers in the logon language, so the Chinese wording is matched as well.
  /未找到合适资源|No suitable resource found|No URI-Mapping defined/i.test(message);

for (const name of names) {
  // Bridged tools write through a function module; the probe must not fire them.
  if (bridged.has(name)) {
    buckets.bridged.push(name);
    continue;
  }
  const args = familyToolNames.includes(name) ? { ...familyArgs } : { ...synthetic };
  // Writes build their request against the recording fetch: the path is still checked,
  // nothing is created, locked or deleted in the system under test.
  const target = dryRun || isWriteVerb(name) ? dryRegistry : registry;
  const before = requests.length;
  try {
    await target.call(name, args, { system: "probe" });
    const built = requests.slice(before).map((entry) => entry.url.replace(/^https?:\/\/[^/]+/, ""));
    if (target === dryRegistry) {
      // The CSRF token fetch is a request of its own; the tool's actual call is the last one.
      const last = built[built.length - 1] ?? "(no request)";
      const broken = built.filter((url) => /\{[a-z_]+\}/.test(url) || url.includes("undefined"));
      if (broken.length > 0) buckets.badPath.push(`${name} built a broken URL: ${broken[0]}`);
      else buckets.dryChecked.push(`${name} ${last}`);
    } else {
      buckets.ok.push(`${name} 200`);
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    // A tool the table deliberately declares unavailable is an answer, not a gap.
    if (String(error?.code ?? "") === "NOT_IMPLEMENTED") {
      buckets.declared.push(`${name} ${message.replace(/\s+/g, " ").slice(0, 110)}`);
      continue;
    }
    // A guard that only rejects the synthetic argument says nothing about the route.
    if (/is not a customer object name/.test(message)) {
      buckets.skipped.push(`${name} ${message.replace(/\s+/g, " ").slice(0, 90)}`);
      continue;
    }
    // A path that cannot be filled is a gap in the probe or in the tool, not in SAP.
    const missing = /Missing "([^"]+)"\.?/.exec(message)?.[1];
    if (missing !== undefined) {
      buckets.other.push(`${name} needs "${missing}" — the probe has no value for it`);
      continue;
    }
    /**
     * SAP answers some resources with a 500 when the object behind the request does not
     * exist: ADT cannot map the URI, or the handler raises on the missing row. Those are
     * the same finding as a 404 with a typed name — the route is fine, the object is not.
     */
    const objectlessServerError =
      /URI-Mapping cannot be performed|wrong input data for processing|出现异常/.test(message);
    // SAP phrases some answers without a status line ("Not found: <no suitable resource>").
    const status =
      /HTTP (\d{3})/.exec(message)?.[1] ??
      (/Not found|未找到/.test(message)
        ? "404"
        : /media type|媒体类型/.test(message)
          ? "415"
          : // The resource resolved and then refused the synthetic lock handle.
            /lock handle was not accepted/i.test(message)
            ? "400"
            : objectlessServerError
              ? "500"
              : "?");
    const line = `${name} ${status} ${message.replace(/\s+/g, " ").slice(0, 90)}`;
    if (status === "404") {
      const echoed = /Resource\s+(\/sap\/bc\/adt\/[^\s"']+)/.exec(message)?.[1];
      if (echoed !== undefined && collections.length > 0) {
        // The path repeated back is not an answer on its own: decide by whether a
        // collection could have served it.
        if (collectionCovers(echoed)) buckets.missingObject.push(line);
        else buckets.ambiguous.push(line);
      } else if (echoesRequestPath(message)) buckets.badPath.push(line);
      else buckets.missingObject.push(line);
    } else if (status === "415" || status === "406") buckets.badMedia.push(line);
    else if (status === "500" && objectlessServerError) buckets.missingObject.push(line);
    else if (["200", "201", "204", "400", "401", "403", "405"].includes(status)) buckets.ok.push(line);
    else buckets.other.push(line);
  }
}

const report = (label, lines) => {
  process.stdout.write(`\n### ${label}: ${lines.length}\n`);
  for (const line of lines) process.stdout.write(`  ${line}\n`);
};
report("recognised (route is right)", buckets.ok);
report("wrong path (no URI mapping, 404)", buckets.badPath);
report("route is right, sample object missing (404)", buckets.missingObject);
report("cannot tell: path echoed, needs a real object (404)", buckets.ambiguous);
report("wrong media type (415/406)", buckets.badMedia);
report("declared unavailable on purpose (no endpoint here)", buckets.declared);
report("needs a look", buckets.other);
report("routed over the RFC bridge (not probed here)", buckets.bridged);
report("write verbs — path built, nothing sent", buckets.dryChecked);
report("skipped: local guard rejects the synthetic argument", buckets.skipped);

if (dryRun) {
  // The point of a dry run: which paths were actually built, and were any left broken.
  const distinct = new Set(requests.map((entry) => entry.url));
  process.stdout.write(`\ndry run: ${requests.length} request(s), ${distinct.size} distinct URL(s)\n`);
  const broken = [...distinct].filter((url) => /\{[a-z_]+\}/.test(url) || url.includes("undefined"));
  process.stdout.write(`broken URLs: ${broken.length}\n`);
  for (const url of broken.slice(0, 20)) process.stdout.write(`  ${url}\n`);
}
