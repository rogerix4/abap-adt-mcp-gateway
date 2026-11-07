#!/usr/bin/env node
/**
 * Documentation style gate.
 *
 * The rules, in one place because this file is the only copy that is published: one H1 per
 * file; no numbered headings (numbers belong in body lists); a language on every code fence;
 * relative links resolve; and on README.md the table of contents is exactly the H2 list, in
 * document order, with GitHub anchors.
 *
 * It exists because the README once mixed numbered and unnumbered headings in one table of
 * contents. A convention that is only written down drifts; these checks are cheap and catch
 * the drift at the moment it is introduced.
 *
 * Exit codes: 0 clean, 1 findings.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "_local"]);
const GENERATED = new Set(["docs/TOOLS.md"]);
const TOC_HEADING = "Table of Contents";

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (path.endsWith(".md")) acc.push(path);
  }
  return acc;
}

/** GitHub's anchor rule, as far as our headings need it. */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

/** Drops fenced blocks so a `# comment` inside ```text is not read as a heading. */
function splitFences(lines) {
  const prose = [];
  const fences = [];
  let inFence = false;
  let fenceOpen = null;
  for (const [index, line] of lines.entries()) {
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (!inFence && fence) {
      inFence = true;
      fenceOpen = { line: index + 1, marker: fence[1], info: fence[2].trim() };
      continue;
    }
    if (inFence && fence) {
      fences.push(fenceOpen);
      inFence = false;
      fenceOpen = null;
      continue;
    }
    if (inFence) continue;
    prose.push({ index: index + 1, text: line });
  }
  if (fenceOpen) fences.push({ ...fenceOpen, unclosed: true });
  return { prose, fences };
}

const problems = [];
const fail = (file, line, message) => problems.push(`${file}:${line} ${message}`);

const files = walk(ROOT)
  .map((path) => relative(ROOT, path).split(sep).join("/"))
  .filter((path) => !GENERATED.has(path))
  .sort();

for (const rel of files) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const { prose, fences } = splitFences(text.split(/\r?\n/));

  const h1 = prose.filter((line) => /^# \S/.test(line.text));
  if (h1.length !== 1) fail(rel, h1[0]?.index ?? 1, `expected exactly one H1, found ${h1.length}`);

  const headings = prose.filter((line) => /^#{2,3} \S/.test(line.text));
  for (const heading of headings) {
    const title = heading.text.replace(/^#{2,3}\s+/, "").trim();
    if (/^(?:step\s*)?\d+[.)]?\s/i.test(title)) {
      fail(rel, heading.index, `numbered heading: "${title}" (numbers belong in body lists)`);
    }
  }

  for (const fence of fences) {
    if (fence.unclosed) fail(rel, fence.line, "unclosed code fence");
    else if (fence.info === "") fail(rel, fence.line, "code fence without a language");
  }

  const lines = text.split(/\r?\n/);
  for (const line of prose) {
    if (/^\*\s+\S/.test(line.text)) fail(rel, line.index, "bullet marker \"*\" (use \"-\")");
    for (const match of line.text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#|<)/.test(target)) continue;
      const withoutAnchor = target.split("#")[0];
      if (withoutAnchor === "") continue;
      const resolved = resolve(dirname(join(ROOT, rel)), decodeURI(withoutAnchor));
      if (!existsSync(resolved)) fail(rel, line.index, `link target does not exist: ${target}`);
    }
  }

  if (rel === "README.md") checkToc(rel, lines, prose);
}

function checkToc(rel, lines, prose) {
  const start = prose.find((line) => /^##\s/.test(line.text) && line.text.includes(TOC_HEADING));
  if (start === undefined) {
    fail(rel, 1, `no "${TOC_HEADING}" section`);
    return;
  }
  const entries = [];
  for (let i = start.index; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (/^##\s/.test(line)) break;
    const entry = /^-\s+\[(.+?)\]\(#(.+?)\)$/.exec(line);
    if (entry) entries.push({ title: entry[1], anchor: entry[2] });
    else if (line === "---") break;
  }

  const expected = prose
    .filter((line) => /^##\s/.test(line.text))
    .map((line) => line.text.replace(/^##\s+/, "").trim())
    .filter((title) => title !== TOC_HEADING);

  if (entries.length !== expected.length) {
    fail(rel, start.index, `table of contents has ${entries.length} entries, the document has ${expected.length} sections`);
  }
  expected.forEach((title, index) => {
    const entry = entries[index];
    if (entry === undefined) return;
    if (entry.title !== title) {
      fail(rel, start.index, `TOC entry ${index + 1} is "${entry.title}", section is "${title}"`);
    }
    if (entry.anchor !== slug(title)) {
      fail(rel, start.index, `TOC anchor "${entry.anchor}" does not match "${slug(title)}"`);
    }
  });
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`FAIL ${problem}\n`);
  process.stderr.write(`verify-docs-style: ${files.length} file(s), ${problems.length} problem(s)\n`);
  process.exit(1);
}

process.stdout.write(`verify-docs-style: ${files.length} file(s), 0 problem(s)\n`);
