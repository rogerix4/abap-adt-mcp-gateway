#!/usr/bin/env node
/**
 * Scans everything that would be committed for private information.
 *
 * Two sources of truth, neither hard-coded in this file:
 *  - what to scan: `git ls-files --others --cached --exclude-standard`, i.e. the
 *    files that would actually be published. Without git (a downloaded ZIP, or a checkout
 *    whose `.git` was removed) it walks the tree instead and skips the usual build output.
 *  - what counts as sensitive: the machine's own config file, if present. Its
 *    system ids, host names and paths must never leak into the repository.
 *
 * Exit codes: 0 clean, 1 findings that must be fixed, 2 usage problems.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const CONFIG_CANDIDATES = ["adt-mcp.config.jsonc", "adt-mcp.config.local.jsonc"];

const MAX_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = new Set([
  ".md", ".txt", ".json", ".jsonc", ".ts", ".mts", ".js", ".mjs", ".cjs",
  ".yaml", ".yml", ".toml", ".ini", ".example", ".gitignore", ".properties",
]);

/** Patterns that must never appear in a published repository. */
const FAIL_RULES = [
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{24,}/ },
  { id: "credential-literal", re: /\b(password|passwd|pwd|secret|token)\s*[:=]\s*["'](?!env:|file:|keychain:)[^"'<>$\s]{8,}["']/i },
  { id: "absolute-user-path", re: /[A-Za-z]:[\\/]{1,2}(Users|Documents and Settings)[\\/]{1,2}[^\\/\s"']+/ },
  { id: "sap-url-with-host", re: /https?:\/\/[a-z0-9][a-z0-9.-]*\.(corp|local|internal|intranet|lcl)\b/i },
  { id: "private-ipv4", re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
];

/** Patterns worth a look but that can be legitimate. */
const WARN_RULES = [
  { id: "email-address", re: /[\w.+-]+@(?!example\.(com|org|net))[\w-]+\.[a-z]{2,}/i },
  { id: "placeholder-owner", re: /github\.com\/OWNER\// },
];

function runGitLsFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "--others", "--cached", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\u0000").filter((entry) => entry.length > 0);
}

/** Without git: walk the tree, honouring `.gitignore` (the local config must stay local). */
const BASE_SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".vscode-test"]);

/** Turns a `.gitignore` line into a predicate over a repo-relative path. */
function ignoreMatcher() {
  const patterns = [];
  let lines = [];
  try {
    lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
  } catch {
    return () => false;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const anchored = line.startsWith("/");
    const body = (anchored ? line.slice(1) : line).replace(/\/$/, "");
    const regex = new RegExp(
      `^${(anchored ? "" : "(?:.*/)?")}${body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`,
    );
    patterns.push(regex);
  }
  return (relPath) => patterns.some((regex) => regex.test(relPath));
}

function walkFiles(dir = ROOT, found = [], ignored = ignoreMatcher()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full).split(sep).join("/");
    if (entry.isDirectory()) {
      if (BASE_SKIP_DIRS.has(entry.name) || ignored(rel)) continue;
      walkFiles(full, found, ignored);
      continue;
    }
    if (entry.isFile() && !ignored(rel)) found.push(rel);
  }
  return found;
}

function listFiles() {
  try {
    return runGitLsFiles();
  } catch {
    return walkFiles();
  }
}

function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Collects machine-specific identifiers from the local config.
 * Whatever is in there must not show up in a committed file.
 */
function localSensitiveTerms() {
  const terms = new Set();
  for (const candidate of CONFIG_CANDIDATES) {
    const path = join(ROOT, candidate);
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(stripJsonc(raw));
    } catch {
      continue;
    }
    for (const system of parsed.systems ?? []) {
      for (const key of ["id", "host", "url", "client"]) {
        const value = system?.[key];
        if (typeof value === "string" && value.length >= 3) terms.add(value);
      }
    }
    if (typeof parsed.defaultSystem === "string" && parsed.defaultSystem.length >= 3) {
      terms.add(parsed.defaultSystem);
    }
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

function isTextFile(path) {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (ext === "") {
    return ["LICENSE", "NOTICE", "AUTHORS", "CHANGELOG"].includes(path.toUpperCase());
  }
  return false;
}

function main() {
  const files = listFiles();

  const terms = localSensitiveTerms();
  const findings = [];

  for (const rel of files) {
    if (!isTextFile(rel)) continue;
    const abs = join(ROOT, rel);
    let info;
    try {
      info = statSync(abs);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_BYTES) continue;

    const text = readFileSync(abs, "utf8");
    const lines = text.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      for (const rule of FAIL_RULES) {
        if (rule.re.test(line)) {
          findings.push({ level: "fail", rule: rule.id, file: rel, line: index + 1, text: line.trim() });
        }
      }
      for (const rule of WARN_RULES) {
        if (rule.re.test(line)) {
          findings.push({ level: "warn", rule: rule.id, file: rel, line: index + 1, text: line.trim() });
        }
      }
      for (const term of terms) {
        if (line.includes(term)) {
          findings.push({ level: "fail", rule: "local-identifier", file: rel, line: index + 1, text: line.trim() });
        }
      }
    }
  }

  const fails = findings.filter((f) => f.level === "fail");
  const warns = findings.filter((f) => f.level === "warn");

  for (const finding of findings) {
    const label = finding.level === "fail" ? "FAIL" : "WARN";
    process.stdout.write(`${label} ${finding.rule} ${finding.file}:${finding.line}\n      ${finding.text}\n`);
  }

  const scannedNote =
    terms.length > 0
      ? `${terms.length} local identifier(s) from config`
      : "no local config found, pattern rules only";
  process.stdout.write(`\nscan-private: ${files.length} files, ${scannedNote}, ${fails.length} fail, ${warns.length} warn\n`);

  return fails.length > 0 ? 1 : 0;
}

process.exitCode = main();
