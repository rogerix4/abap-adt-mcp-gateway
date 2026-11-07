/**
 * `output: "file"` — answer a source read with a file instead of inlining it.
 *
 * Measured live: `GetProgram {output: "file"}` answered exactly like
 * `GetProgram {}`, with the whole source inline. The argument was declared in the
 * contract ("writes the source under the MCP output dir and returns path, line count and
 * an outline with line ranges") and read by nothing, so a caller that asked for a file to
 * keep a 5 000-line program out of its context got the program in its context.
 *
 * The outline is deliberately shallow: top-level blocks with the line range between the
 * open and the matching `END…` statement. It is a map of where things are, not a model of
 * what they mean — a deeper one would have to parse ABAP, and a wrong one is worse than a
 * coarse one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { outputDir } from "./output-dir.js";

export interface OutlineEntry {
  readonly kind: string;
  readonly name: string;
  readonly start_line: number;
  readonly end_line: number;
}

export interface SourceFileAnswer {
  readonly path: string;
  readonly line_count: number;
  readonly outline: readonly OutlineEntry[];
}

/** The block openers this outline understands, with the statement that closes each. */
const BLOCKS: readonly { readonly open: RegExp; readonly kind: string; readonly close: RegExp }[] = [
  {
    // `DEFINITION` and `IMPLEMENTATION` are two blocks with the same name; both are worth a line.
    open: /^\s*CLASS\s+([\w/]+)\s+(?:DEFINITION|IMPLEMENTATION)\b/i,
    kind: "class",
    close: /^\s*ENDCLASS\b/i,
  },
  { open: /^\s*INTERFACE\s+([\w/]+)\s*\./i, kind: "interface", close: /^\s*ENDINTERFACE\b/i },
  { open: /^\s*FORM\s+([\w/]+)\b/i, kind: "form", close: /^\s*ENDFORM\b/i },
  { open: /^\s*FUNCTION\s+([\w/]+)\s*\./i, kind: "function", close: /^\s*ENDFUNCTION\b/i },
  { open: /^\s*MODULE\s+([\w/]+)\b/i, kind: "module", close: /^\s*ENDMODULE\b/i },
];

export function outlineOfSource(source: string): readonly OutlineEntry[] {
  const lines = source.split(/\r?\n/);
  // A trailing newline is not a line: an unterminated block would otherwise claim an
  // empty line at the end as its range.
  const lastRealLine = lines.reduce((last, line, index) => (line.trim().length > 0 ? index + 1 : last), 0);
  const open: { kind: string; name: string; start_line: number; close: RegExp }[] = [];
  const found: OutlineEntry[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    // Close first: `ENDCLASS` cannot also open a block, and a body that mentions a FORM
    // name inside a comment must not push a block (comments are dropped below).
    const top = open.at(-1);
    if (top !== undefined && top.close.test(line)) {
      found.push({ kind: top.kind, name: top.name, start_line: top.start_line, end_line: lineNumber });
      open.pop();
      return;
    }
    if (/^\s*\*/.test(line) || /^\s*"/.test(line)) return;
    for (const block of BLOCKS) {
      const match = block.open.exec(line);
      if (match?.[1] !== undefined) {
        open.push({ kind: block.kind, name: match[1].toUpperCase(), start_line: lineNumber, close: block.close });
        return;
      }
    }
  });

  // An unterminated block still says where it starts: its last real line is the best end.
  for (const block of open) {
    found.push({ kind: block.kind, name: block.name, start_line: block.start_line, end_line: lastRealLine });
  }
  return found.sort((a, b) => a.start_line - b.start_line);
}

/** `<output dir>/<tool>/<name>[-<version>].abap`, created on demand. */
export function sourceFilePath(tool: string, name: string, version?: string): string {
  const safe = (value: string) => value.replace(/[^\w.-]+/g, "_");
  const file = `${safe(name)}${version === undefined ? "" : `-${safe(version)}`}.abap`;
  return join(outputDir(), "sources", safe(tool), file);
}

/** Writes the source and answers with what the caller can act on: a path and a map. */
export function sourceFileAnswer(
  source: string,
  options: { readonly tool: string; readonly name: string; readonly version?: string },
): SourceFileAnswer {
  const path = sourceFilePath(options.tool, options.name, options.version);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  return {
    path,
    line_count: source.split(/\r?\n/).length,
    outline: outlineOfSource(source),
  };
}
