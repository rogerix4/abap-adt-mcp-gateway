// Derive tools/layer-map.json from tools/catalog.json.
//
// Why this exists: `Low` in a tool name is NOT a reliable indicator of anything
// (89 of 134 low-level tools have no high-level sibling, 18 have no lock or
// session parameter at all). Layer, prerequisites and side effects therefore
// live in data, not in the name -- names are a frozen contract we must not touch.
//
// Classification is deliberately explicit: a verb table handles the 13 standard
// verbs, and anything whose name does not decide its side effects is listed in
// OVERRIDES. A tool that falls in neither is an error, never a default.
//
//   node tools/scripts/gen-layer-map.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const catalogPath = path.join(root, "tools", "catalog.json");
const outPath = path.join(root, "tools", "layer-map.json");

/** Side effect of each standard verb. `null` = decide by name inspection. */
const VERB_EFFECT = {
  Activate: "write",
  Check: "read",
  Create: "write",
  Delete: "write",
  Describe: "read",
  Get: "read",
  List: "read",
  Lock: "write",
  Patch: "write",
  Read: "read",
  Search: "read",
  Unlock: "write",
  Update: "write",
  Validate: "read",
  Write: "write",
};

/** Names whose side effect is not decided by the leading verb alone. */
const OVERRIDES = {
  // Handler* dispatchers: the verb is in second position.
  HandlerActivate: "write",
  HandlerCdsUnitTestResult: "read",
  HandlerCdsUnitTestStatus: "read",
  HandlerCheckRun: "read",
  HandlerCreate: "write",
  HandlerDelete: "write",
  HandlerDumpList: "read",
  HandlerDumpView: "read",
  HandlerGet: "read",
  HandlerLock: "write",
  HandlerProfileList: "read",
  HandlerProfileRun: "execute",
  HandlerProfileView: "read",
  HandlerServiceBindingListTypes: "read",
  HandlerServiceBindingValidate: "read",
  HandlerTransportCreate: "write",
  HandlerUnitTestResult: "read",
  HandlerUnitTestRun: "execute",
  HandlerUnitTestStatus: "read",
  HandlerUnlock: "write",
  HandlerUpdate: "write",
  HandlerValidate: "read",

  // Runtime* / Run*: read diagnostics vs. run ABAP on the server.
  RuntimeAnalyzeDump: "read",
  RuntimeAnalyzeProfilerTrace: "read",
  RuntimeCreateProfilerTraceParameters: "write",
  RuntimeGetDumpById: "read",
  RuntimeGetGatewayErrorLog: "read",
  RuntimeGetProfilerTraceData: "read",
  RuntimeListDumps: "read",
  RuntimeListFeeds: "read",
  RuntimeListProfilerTraceFiles: "read",
  RuntimeListSystemMessages: "read",
  RuntimeRunClassWithProfiling: "execute",
  RuntimeRunProgramWithProfiling: "execute",
  RunClassUnitTestsLow: "execute",
  RunUnitTest: "execute",

  // Remaining singletons / verbs whose effect is not the obvious one.
  ReloadProfile: "read",
  RenderSmartForm: "read",
  TestClassClassesLow: "read",
};

/** Every leading token we recognise when splitting a tool name. Longest first. */
const SPLIT_VERBS = Object.keys({ ...VERB_EFFECT, Handler: 1, Reload: 1, Render: 1, Run: 1, Runtime: 1 }).sort(
  (a, b) => b.length - a.length,
);

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const problems = [];

const map = catalog.tools.map((tool) => {
  const { name, inputSchema } = tool;
  const props = Object.keys(inputSchema?.properties ?? {});
  const layer = name.endsWith("Low") ? "low" : "high";
  const base = layer === "low" ? name.slice(0, -3) : name;

  let verb = null;
  for (const candidate of SPLIT_VERBS) {
    if (base.startsWith(candidate) && base.length > candidate.length) {
      verb = candidate;
      break;
    }
  }

  let effect = OVERRIDES[name] ?? null;
  let effectSource = effect ? "override" : "verb";
  if (!effect && verb) effect = VERB_EFFECT[verb];
  // A `Low` variant of a VerbEffect-less name falls back to its base name.
  if (!effect && layer === "low") {
    effect = OVERRIDES[base] ?? (verb ? VERB_EFFECT[verb] : null);
    if (effect) effectSource = OVERRIDES[base] ? "override" : "verb";
  }

  if (!effect) {
    problems.push(`${name}: no side-effect classification`);
    effect = "unknown";
    effectSource = "unclassified";
  }
  if (!verb) {
    problems.push(`${name}: no recognised leading verb token`);
  }

  const subject = verb ? base.slice(verb.length) : base;
  const hasHighSibling = layer === "low" && catalog.tools.some((t) => t.name === base);

  return {
    name,
    verb,
    subject,
    family: subject,
    layer,
    hasHighSibling,
    requires: {
      lockHandle: props.includes("lock_handle"),
      session: props.includes("session_id") || props.includes("session_state"),
    },
    effect,
    effectSource,
  };
});

const duplicates = map.map((m) => m.name).filter((n, i, all) => all.indexOf(n) !== i);
if (duplicates.length) problems.push(`duplicate tool names: ${duplicates.join(", ")}`);

const by = (key) => {
  const counts = new Map();
  for (const entry of map) counts.set(entry[key], (counts.get(entry[key]) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
};

const summary = {
  total: map.length,
  effect: by("effect"),
  effectSource: by("effectSource"),
  layer: by("layer"),
  families: new Set(map.map((m) => m.subject)).size,
};

if (process.argv.includes("--check")) {
  const current = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const same = JSON.stringify(current.tools) === JSON.stringify(map);
  console.log(same ? "layer-map up to date" : "layer-map is stale -- run without --check");
  process.exit(same && problems.length === 0 ? 0 : 1);
}

fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedFrom: "tools/catalog.json", summary, problems, tools: map }, null, 2) + "\n",
  "utf8",
);

console.log(`tools      : ${summary.total}`);
console.log(`families   : ${summary.families}`);
console.log(`effects    : ${JSON.stringify(summary.effect)}`);
console.log(`classified : ${JSON.stringify(summary.effectSource)}`);
console.log(`problems   : ${problems.length}`);
for (const p of problems) console.log(`  ! ${p}`);
console.log(`wrote ${path.relative(root, outPath)}`);
