#!/usr/bin/env node
/**
 * Fails when `src/` uses a TypeScript symbol marked `@deprecated`.
 *
 * `tsc` stays silent about these — they are *suggestions*, not errors — so an
 * editor shows the squiggle while CI stays green. That is exactly how a
 * deprecated SDK entry point survives for months. This script asks the compiler
 * for suggestion diagnostics (code 6385) and turns them into a gate.
 */

import { join, relative } from "node:path";

import ts from "typescript";

const ROOT = process.cwd();

function main() {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) {
    process.stderr.write("check-deprecated: no tsconfig.json found\n");
    return 2;
  }

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    process.stderr.write(`check-deprecated: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}\n`);
    return 2;
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });

  const findings = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    for (const diagnostic of program.getSuggestionDiagnostics(sourceFile)) {
      if (diagnostic.code !== 6385) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      findings.push({
        file: relative(ROOT, sourceFile.fileName).replace(/\\/g, "/"),
        line: line + 1,
        column: character + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      });
    }
  }

  for (const finding of findings) {
    process.stdout.write(`FAIL ${finding.file}:${finding.line}:${finding.column}\n      ${finding.message}\n`);
  }

  process.stdout.write(`\ncheck-deprecated: ${findings.length} deprecated symbol use(s)\n`);
  return findings.length === 0 ? 0 : 1;
}

process.exitCode = main();
