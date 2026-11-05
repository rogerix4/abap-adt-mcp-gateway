// Offline analysis of the frozen tool contract (tools/catalog.json).
//
// Prints the shape of the contract: verb distribution, object-family matrix, and
// how many "Low" tools actually differ from a high-level sibling.
//
// Usage: node tools/scripts/analyze-catalog.mjs [--json <out>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(fs.readFileSync(path.resolve(here, "..", "catalog.json"), "utf8"));
const tools = doc.tools;

const VERBS = [
  "Get", "Delete", "Create", "Update", "Handler", "Read", "Lock", "Activate",
  "Unlock", "Validate", "Check", "Runtime", "List", "Run", "Describe", "Patch",
  "Reload", "Render", "Search", "Write",
];

function split(name) {
  const verb = VERBS.find((v) => name.startsWith(v)) || "";
  const rest = name.slice(verb.length);
  const low = /Low$/.test(rest);
  return { verb, subject: rest.replace(/Low$/, ""), low };
}

const rows = tools.map((t) => {
  const s = split(t.name);
  const props = Object.keys(t.inputSchema?.properties ?? {});
  return {
    name: t.name,
    verb: s.verb,
    subject: s.subject,
    low: s.low,
    hasLock: props.includes("lock_handle"),
    hasSession: props.includes("session_id") || props.includes("session_state"),
    params: props.length,
  };
});

const count = (keyFn) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

const byVerb = count((r) => r.verb);
const bySubject = count((r) => r.subject);
const lows = rows.filter((r) => r.low);
const lowNoSibling = lows.filter(
  (r) => !rows.some((o) => !o.low && o.verb === r.verb && o.subject === r.subject),
);
const lowNoSession = lows.filter((r) => !r.hasLock && !r.hasSession);
const noVerb = rows.filter((r) => !r.verb);
const badSchema = rows.filter(
  (r) => !tools.find((t) => t.name === r.name)?.inputSchema ||
    tools.find((t) => t.name === r.name).inputSchema.type !== "object",
);
const subjects = [...bySubject.entries()].sort((a, b) => b[1] - a[1]);

const pad = (n, w) => String(n).padStart(w);
const out = [];
out.push(`tools            : ${rows.length}`);
out.push(`distinct subjects: ${subjects.length}`);
out.push(`low-level tools  : ${lows.length}`);
out.push(`  low w/o high sibling : ${lowNoSibling.length}`);
out.push(`  low w/o lock/session : ${lowNoSession.length}`);
out.push(`non-object schema: ${badSchema.length}${badSchema.length ? " -> " + badSchema.map((r) => r.name).join(", ") : ""}`);
out.push(`no verb prefix   : ${noVerb.length}${noVerb.length ? " -> " + noVerb.map((r) => r.name).join(", ") : ""}`);
out.push("");
out.push("verbs:");
for (const [v, n] of [...byVerb.entries()].sort((a, b) => b[1] - a[1])) {
  out.push(`  ${pad(n, 3)}  ${v || "(none)"}`);
}
out.push("");
out.push("subjects with >= 3 tools (verb list, (L) = low-level variant):");
for (const [s, n] of subjects.filter((x) => x[1] >= 3)) {
  const verbs = rows
    .filter((r) => r.subject === s)
    .map((r) => `${r.verb}${r.low ? "(L)" : ""}`)
    .join(" ");
  out.push(`  ${pad(n, 3)}  ${s.padEnd(26)} ${verbs}`);
}
const singles = subjects.filter((x) => x[1] === 1).map((x) => x[0]);
out.push("");
out.push(`subjects with exactly 1 tool (${singles.length}):`);
out.push("  " + singles.join(", "));

console.log(out.join("\n"));

const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx > 0) {
  const target = process.argv[jsonIdx + 1];
  fs.writeFileSync(
    target,
    JSON.stringify({ byVerb: Object.fromEntries(byVerb), bySubject: Object.fromEntries(bySubject), rows }, null, 2),
  );
  console.log(`\nwrote ${target}`);
}
