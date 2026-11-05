#!/usr/bin/env node
/**
 * Generates docs/TOOLS.md from tools/catalog.json.
 *
 * The tool surface is a contract, so its reference page must not be hand-written: a
 * hand-written list drifts the first time a name changes and nobody notices. Run with
 * `--check` to fail when the committed page is out of date (that is what `npm run
 * verify` does).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TARGET = join(ROOT, "docs", "TOOLS.md");

const catalog = JSON.parse(readFileSync(join(ROOT, "tools", "catalog.json"), "utf8"));

/** `Get*` / `Read*` / `Create*` … — the verb a tool name starts with. */
const VERBS = [
  "Activate",
  "Check",
  "Create",
  "Delete",
  "Describe",
  "Get",
  "List",
  "Lock",
  "Patch",
  "Read",
  "Release",
  "Run",
  "Search",
  "Unlock",
  "Update",
  "Validate",
];

const verbOf = (name) => VERBS.find((verb) => name.startsWith(verb)) ?? "Other";

/** Multi-tool families: the noun left after the verb, e.g. `Program`, `GuiStatus`. */
const subjectOf = (name) => {
  const verb = verbOf(name);
  return verb === "Other" ? name : name.slice(verb.length).replace(/^Low$/, "Low");
};

const groups = new Map();
for (const tool of catalog.tools) {
  const verb = verbOf(tool.name);
  const list = groups.get(verb) ?? [];
  list.push(tool);
  groups.set(verb, list);
}

const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
const lowLevel = catalog.tools.filter((tool) => /Low$/.test(tool.name)).length;
const nonObject = catalog.tools.filter((tool) => tool.inputSchema?.type !== "object").length;

const lines = [
  "# Tool reference",
  "",
  `Generated from \`tools/catalog.json\` — **${catalog.count} tools**, frozen.`,
  "Do not edit this page by hand: run `node tools/scripts/gen-tools-doc.mjs`.",
  "",
  "Every tool also accepts one argument the contract does not declare: `system`,",
  "which selects the SAP system (see [USAGE.md](./USAGE.md#which-system-a-call-goes-to)).",
  "",
  "## Shape",
  "",
  "| | |",
  "|---|---|",
  `| Tools | ${catalog.count} |`,
  `| Low-level (\`*Low\`) | ${lowLevel} |`,
  `| Verbs | ${rows.length} |`,
  `| Non-object input schemas | ${nonObject} |`,
  "",
  "`Low` in a name means \"low-level call sequence\", not \"twin of the tool next to it\":",
  "89 of these have no high-level sibling, so pick by what the tool needs, not by name.",
  "",
  "## By verb",
  "",
  "| Verb | Tools |",
  "|---|---|",
  ...rows.map(([verb, list]) => `| ${verb} | ${list.length} |`),
  "",
];

for (const [verb, list] of rows) {
  lines.push(`## ${verb} (${list.length})`, "");
  lines.push("| Tool | What it does |", "|---|---|");
  for (const tool of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
    const description = String(tool.description ?? "")
      .replace(/\s+/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
    const short = description.length > 180 ? `${description.slice(0, 177)}…` : description;
    lines.push(`| \`${tool.name}\` | ${short} |`);
  }
  lines.push("");
}

const text = `${lines.join("\n").trimEnd()}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(TARGET, "utf8");
  } catch {
    current = "";
  }
  if (current !== text) {
    process.stderr.write("gen-tools-doc: docs/TOOLS.md is out of date, regenerate it\n");
    process.exit(1);
  }
  process.stdout.write(`gen-tools-doc: docs/TOOLS.md up to date (${catalog.count} tools)\n`);
} else {
  writeFileSync(TARGET, text);
  process.stdout.write(`gen-tools-doc: wrote ${TARGET} (${catalog.count} tools)\n`);
}
