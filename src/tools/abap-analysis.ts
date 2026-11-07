/**
 * ABAP source analysis: AST, semantic analysis and system-symbol resolution.
 *
 * All three tools take ABAP *source text*, not an object name, so they cannot be an ADT
 * route: ADT has no endpoint that returns a syntax tree. The upstream server solves this
 * with hand-written regular expressions (its own comment calls the AST a "placeholder
 * implementation until ANTLR is properly configured"), which is why it reports structures
 * it never really parsed.
 *
 * This gateway parses instead: `@abaplint/core` is a real ABAP parser (MIT), and its
 * object model already carries the semantic information ADT keeps to itself — classes,
 * interfaces, forms, methods, parameters, attributes, constants. The tree is abaplint's
 * statement tree; `GetAbapSystemSymbols` then resolves the names it finds against the
 * connected system, which is the only part that needs the network.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MemoryFile, Registry } from "@abaplint/core";

import type { ToolRegistry, ToolContext } from "../engine/registry.js";
import type { GatewayRuntime } from "../runtime.js";
import { GatewayError } from "../engine/errors.js";

type Args = Record<string, unknown>;

const arg = (args: Args, name: string): string | undefined => {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** A node of the statement tree, as this gateway reports it. */
interface AstNode {
  readonly type: string;
  readonly text: string;
  readonly from: { readonly row: number; readonly column: number };
  readonly to: { readonly row: number; readonly column: number };
  readonly children: readonly AstNode[];
}

/** The parts of the abaplint API used here (its typings are not all exported). */
interface Token {
  getStr(): string;
  getStart(): { getRow(): number; getCol(): number };
  getEnd(): { getRow(): number; getCol(): number };
}

interface StatementLike {
  get(): { constructor: { name: string } };
  concatTokens(): string;
  getFirstToken(): Token;
  getLastToken(): Token;
  getChildren(): StatementLike[];
}

interface AbapFileLike {
  getStatements(): StatementLike[];
  getTokens(): Token[];
  getInfo(): { parsed?: Record<string, unknown> };
}

interface ParsedObject {
  parse(): void;
  getParsingIssues?(): { getMessage?(): string }[];
  getABAPFiles(): AbapFileLike[];
}

interface Parsed {
  readonly ast: readonly AstNode[];
  readonly statementCount: number;
  readonly truncated: boolean;
  /** The abaplint object model: classes / interfaces / forms / implementations. */
  readonly model: Record<string, unknown>;
  readonly issues: readonly string[];
  readonly tokens: readonly string[];
}

/** abaplint picks the parser by file name, so the name has to match the source. */
function fileNameFor(code: string): string {
  const upper = code.toUpperCase();
  if (/\bFUNCTION-POOL\b/.test(upper)) return "zmcp_source.fugr.abap";
  if (/\bINTERFACE\s+\w+\s+(LOAD|PUBLIC)/.test(upper) && !/\bCLASS\b/.test(upper)) return "zmcp_source.intf.abap";
  if (/\bCLASS\s+\w+\s+DEFINITION\b/.test(upper) || /\bCLASS\s+\w+\s+IMPLEMENTATION\b/.test(upper)) {
    return "zmcp_source.clas.abap";
  }
  return "zmcp_source.prog.abap";
}

const MAX_NODES = 20_000;
const MAX_TEXT = 200;

/** Parses once; every tool below works from this. */
function parse(code: string): Parsed {
  const registry = new Registry();
  registry.addFile(new MemoryFile(fileNameFor(code), code));

  const objects = [...registry.getObjects()] as unknown as ParsedObject[];
  if (objects.length === 0) {
    throw new GatewayError("INVALID_ARGUMENT", "The code did not parse into an ABAP object.");
  }
  const object = objects[0]!;
  object.parse();

  const issues = (object.getParsingIssues?.() ?? []).map((issue) => String(issue?.getMessage?.() ?? issue));
  const files = object.getABAPFiles();
  const file = files[0];
  if (file === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", "The code did not parse into an ABAP file.");
  }

  let count = 0;
  let truncated = false;
  const tokens = file.getTokens().map((token) => token.getStr());

  const convert = (statement: StatementLike): AstNode => {
    const node = statement.get();
    const first = statement.getFirstToken();
    const last = statement.getLastToken();
    count += 1;
    if (count > MAX_NODES) truncated = true;
    const text = String(statement.concatTokens()).trim();
    return {
      type: node.constructor.name,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
      from: { row: first.getStart().getRow(), column: first.getStart().getCol() },
      to: { row: last.getEnd().getRow(), column: last.getEnd().getCol() },
      children: truncated ? [] : statement.getChildren().map(convert),
    };
  };

  const ast: AstNode[] = [];
  for (const statement of file.getStatements()) {
    if (truncated) break;
    ast.push(convert(statement));
  }

  return {
    ast,
    statementCount: file.getStatements().length,
    truncated,
    model: (file.getInfo()?.parsed ?? {}) as Record<string, unknown>,
    issues,
    tokens,
  };
}

/** `from` / `to` of an abaplint identifier, flattened for the answer. */
const positionOf = (value: unknown): { row: number; column: number } | undefined => {
  const identifier = value as { token?: { row?: number; col?: number } } | undefined;
  const row = identifier?.token?.row;
  const col = identifier?.token?.col;
  return row === undefined || col === undefined ? undefined : { row, column: col };
};

interface SymbolEntry {
  readonly name: string;
  readonly kind: string;
  readonly scope?: string;
  readonly direction?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly at?: { readonly row: number; readonly column: number };
}

/** Classes / interfaces / forms / methods / parameters / attributes of the model. */
function collectSymbols(model: Record<string, unknown>): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const push = (name: unknown, kind: string, scope: string, extra: Readonly<Record<string, unknown>> = {}, at?: { readonly row: number; readonly column: number }): void => {
    if (typeof name !== "string" || name === "") return;
    symbols.push({ name, kind, scope, ...(Object.keys(extra).length === 0 ? {} : { extra }), ...(at === undefined ? {} : { at }) });
  };

  const asList = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);

  for (const item of asList(model["classes"])) {
    const name = String(item["name"] ?? "");
    push(name, "class", "global", {
      ...(item["isForTesting"] === true ? { isForTesting: true } : {}),
      ...(item["isAbstract"] === true ? { isAbstract: true } : {}),
      ...(typeof item["superClassName"] === "string" && item["superClassName"] !== "" ? { superClass: item["superClassName"] } : {}),
    }, positionOf(item["identifier"]));
    for (const method of asList(item["methods"])) {
      const methodName = String(method["name"] ?? "");
      push(methodName, "method", name, {
        ...(method["isRedefinition"] === true ? { isRedefinition: true } : {}),
        ...(method["isForTesting"] === true ? { isForTesting: true } : {}),
      }, positionOf(method["identifier"]));
      for (const parameter of asList(method["parameters"])) {
        push(String(parameter["name"] ?? ""), "parameter", `${name}=>${methodName}`, {
          ...(typeof parameter["direction"] === "string" ? { direction: parameter["direction"] } : {}),
        }, positionOf(parameter["identifier"]));
      }
    }
    for (const attribute of [...asList(item["attributes"]), ...asList(item["constants"])]) {
      push(String(attribute["name"] ?? ""), "attribute", name, {
        ...(typeof attribute["level"] === "string" ? { level: attribute["level"] } : {}),
        ...(attribute["readOnly"] === true ? { readOnly: true } : {}),
      }, positionOf(attribute["identifier"]));
    }
  }

  for (const item of asList(model["interfaces"])) {
    const name = String(item["name"] ?? "");
    push(name, "interface", "global", {}, positionOf(item["identifier"]));
    for (const method of asList(item["methods"])) {
      push(String(method["name"] ?? ""), "method", name, {}, positionOf(method["identifier"]));
    }
  }

  for (const item of asList(model["forms"])) {
    push(String(item["name"] ?? ""), "form", "global", {}, positionOf(item["identifier"]));
  }

  return symbols;
}

/** Names the statements mention: `CALL FUNCTION 'x'`, `PERFORM y`, `TYPE z`, `sy-*`. */
interface Reference {
  readonly name: string;
  readonly kind: "function_module" | "type" | "system_field" | "class" | "form";
}

const DECLARATION_KINDS: Readonly<Record<string, string>> = {
  DATA: "variable",
  "CLASS-DATA": "variable",
  STATICS: "variable",
  CONSTANTS: "constant",
  TYPES: "type",
  PARAMETERS: "parameter",
  "SELECT-OPTIONS": "select_option",
  "FIELD-SYMBOLS": "field_symbol",
  RANGES: "range",
};

/** Words that follow a declaration keyword but are not the declared name. */
const NOT_A_NAME = new Set([
  "BEGIN",
  "END",
  "OF",
  "TYPE",
  "LIKE",
  "VALUE",
  "LENGTH",
  "DECIMALS",
  "OCCURS",
  "WITH",
  "HEADER",
  "LINE",
  "TABLE",
  "RANGE",
  "DEFAULT",
  "REF",
  "TO",
  "FOR",
  "IS",
  "INITIAL",
]);

/**
 * Declarations written inside the source itself.
 *
 * Measured live: `GetAbapSemanticAnalysis` on a report with `DATA: lv_x TYPE i.` answered
 * `symbol_count: 0`, because only the class / interface / form model was read — the local
 * `DATA` / `CONSTANTS` / `TYPES` / `PARAMETERS` names were invisible. Token scanning is the only
 * source for them: abaplint's model does not carry report-level declarations.
 */
function collectLocalSymbols(tokens: readonly string[]): SymbolEntry[] {
  const found: SymbolEntry[] = [];
  const seen = new Set<string>();
  const push = (raw: string, kind: string): void => {
    const name = raw.replace(/^</, "").replace(/>$/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    const upper = name.toUpperCase();
    if (NOT_A_NAME.has(upper) || seen.has(upper)) return;
    seen.add(upper);
    found.push({ name: upper, kind, scope: "procedure" });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = (tokens[index] ?? "").toUpperCase();
    const kind = DECLARATION_KINDS[keyword];
    if (kind === undefined) continue;
    // Inline declaration: `DATA(lv_x) = …`.
    if ((tokens[index + 1] ?? "") === "(") {
      push(tokens[index + 2] ?? "", kind);
      continue;
    }
    let cursor = index + 1;
    if ((tokens[cursor] ?? "") === ":") cursor += 1;
    // `FIELD-SYMBOLS <fs>` arrives as `<` `fs` `>` on this parser.
    if ((tokens[cursor] ?? "") === "<") cursor += 1;
    while (cursor < tokens.length) {
      const token = tokens[cursor] ?? "";
      const upperToken = token.toUpperCase();
      // `END OF itab` closes a `BEGIN OF` group; it declares nothing.
      if (upperToken === "." || upperToken === "END") break;
      push(token, kind);
      // Walk to the end of this entry: `DATA: a TYPE i, b TYPE i.`
      while (cursor < tokens.length && tokens[cursor] !== "," && tokens[cursor] !== ".") cursor += 1;
      if (tokens[cursor] !== ",") break;
      cursor += 1;
    }
  }
  return found;
}

function collectReferences(tokens: readonly string[]): Reference[] {
  const found = new Map<string, Reference>();
  const add = (name: string, kind: Reference["kind"]): void => {
    const key = `${kind}:${name.toUpperCase()}`;
    if (!found.has(key)) found.set(key, { name, kind });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const upper = token.toUpperCase();
    if (upper === "FUNCTION" && (tokens[index - 1] ?? "").toUpperCase() === "CALL") {
      const name = (tokens[index + 1] ?? "").replace(/^'|'$/g, "");
      if (/^[A-Za-z0-9_/]+$/.test(name)) add(name.toUpperCase(), "function_module");
      continue;
    }
    // `PERFORM name` / `PERFORM name USING …`; a dynamic `PERFORM (var)` is not a name.
    if (upper === "PERFORM") {
      const name = tokens[index + 1] ?? "";
      if (/^[A-Za-z0-9_/]+$/.test(name)) add(name.toUpperCase(), "form");
      continue;
    }
    if (upper === "TYPE") {
      const next = tokens[index + 1] ?? "";
      const target = next.toUpperCase() === "REF" ? (tokens[index + 2] ?? "").toUpperCase() === "TO" ? tokens[index + 3] ?? "" : "" : next;
      const clean = target.replace(/[^A-Za-z0-9_/]/g, "");
      if (clean !== "" && !/^(I|C|N|D|T|X|STRING|XSTRING|ANY|DATA|TABLE|STANDARD|SORTED|HASHED|LINE|OF|BEGIN|END|REF)$/i.test(clean)) {
        add(clean.toUpperCase(), /^(Z|Y)/i.test(clean) ? "type" : "type");
      }
      continue;
    }
    // abaplint splits `sy-subrc` into three tokens: "sy" "-" "subrc".
    if (upper === "SY" && tokens[index + 1] === "-") {
      const fieldName = tokens[index + 2] ?? "";
      if (/^[A-Za-z0-9_]+$/.test(fieldName)) add(`SY-${fieldName.toUpperCase()}`, "system_field");
      continue;
    }
    const systemField = /^SY-([A-Za-z0-9_]+)$/i.exec(token);
    if (systemField !== null) add(`SY-${systemField[1]!.toUpperCase()}`, "system_field");
  }
  return [...found.values()];
}

/** Writes the answer next to `filePath` when the caller asked for a file. */
function writeWhenAsked(filePath: string | undefined, payload: unknown): string | undefined {
  if (filePath === undefined) return undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    throw new GatewayError("INVALID_ARGUMENT", `cannot write "${filePath}": ${String((error as Error).message ?? error)}.`);
  }
}

function source(args: Args, tool: string): string {
  const code = arg(args, "code");
  if (code === undefined) {
    throw new GatewayError("INVALID_ARGUMENT", `${tool}: missing "code" (the ABAP source text to analyse).`);
  }
  return code;
}

function getAst(args: Args): unknown {
  const tool = "GetAbapAST";
  const parsed = parse(source(args, tool));
  const answer = {
    success: true,
    parser: "@abaplint/core",
    statement_count: parsed.statementCount,
    truncated: parsed.truncated,
    parsing_issues: parsed.issues,
    ast: parsed.ast,
  };
  const file = writeWhenAsked(arg(args, "filePath"), answer);
  return file === undefined ? answer : { ...answer, file };
}

function getSemanticAnalysis(args: Args): unknown {
  const tool = "GetAbapSemanticAnalysis";
  const parsed = parse(source(args, tool));
  const symbols = [...collectSymbols(parsed.model), ...collectLocalSymbols(parsed.tokens)];
  const references = collectReferences(parsed.tokens);

  const answer = {
    success: true,
    parser: "@abaplint/core",
    analysis_level: "parse",
    statement_count: parsed.statementCount,
    parsing_issues: parsed.issues,
    // The object model the parser built: the same information SE80 shows per class.
    model: parsed.model,
    symbol_count: symbols.length,
    symbols,
    reference_count: references.length,
    references,
    scope_count: new Set(symbols.map((symbol) => symbol.scope ?? "")).size,
    note:
      "Parse level: this reads declarations, the class/interface/form model and the names the code " +
      "mentions. It does not type-check — an assignment of 'ABC' to an integer field is not reported " +
      "here. Use Check*Low / Activate on a real object for the compiler's verdict.",
  };
  const file = writeWhenAsked(arg(args, "filePath"), answer);
  return file === undefined ? answer : { ...answer, file };
}

const MAX_RESOLVED = 40;

async function getSystemSymbols(args: Args, ctx: ToolContext, registry: ToolRegistry): Promise<unknown> {
  const tool = "GetAbapSystemSymbols";
  const parsed = parse(source(args, tool));
  const references = collectReferences(parsed.tokens);
  const symbols = collectSymbols(parsed.model);

  // Names worth asking the system about: what the code calls and what it refers to.
  const candidates = [
    ...symbols.filter((symbol) => symbol.kind === "class" || symbol.kind === "interface").map((symbol) => ({ name: symbol.name, kind: symbol.kind })),
    ...references.filter((reference) => reference.kind !== "system_field").map((reference) => ({ name: reference.name, kind: reference.kind })),
  ];
  const unique = [...new Map(candidates.map((candidate) => [`${candidate.kind}:${candidate.name.toUpperCase()}`, candidate])).values()];
  const lookup = unique.slice(0, MAX_RESOLVED);

  const resolved: Record<string, unknown>[] = [];
  for (const candidate of lookup) {
    let answer: Record<string, unknown> | undefined;
    try {
      answer = (await registry.call("SearchObject", { object_name: candidate.name, maxResults: 3 }, ctx)) as Record<string, unknown>;
    } catch {
      answer = undefined;
    }
    const objects = Array.isArray(answer?.["objects"]) ? (answer?.["objects"] as Record<string, unknown>[]) : [];
    const hit = objects.find((object) => String(object["name"] ?? "").toUpperCase() === candidate.name.toUpperCase());
    resolved.push({
      name: candidate.name.toUpperCase(),
      kind: candidate.kind,
      resolved: hit !== undefined,
      ...(hit === undefined
        ? {}
        : {
            object_type: hit["type"],
            package_name: hit["package_name"],
            description: hit["description"],
          }),
    });
  }

  const systemFields = references.filter((reference) => reference.kind === "system_field").map((reference) => reference.name.toUpperCase());

  const answer = {
    success: true,
    parser: "@abaplint/core",
    // `SY-*` are one structure in the DDIC (SYST) and carry no description of their own
    // here, so they are listed without a lookup instead of being guessed.
    system_fields: [...new Set(systemFields)],
    system_field_source: "SYST (SE11)",
    resolved_count: resolved.filter((entry) => entry["resolved"] === true).length,
    unresolved_count: resolved.filter((entry) => entry["resolved"] === false).length,
    truncated: unique.length > lookup.length,
    symbols: resolved,
  };
  const file = writeWhenAsked(arg(args, "filePath"), answer);
  return file === undefined ? answer : { ...answer, file };
}

export function registerAbapAnalysisTools(registry: ToolRegistry, runtime: GatewayRuntime): void {
  const register = (name: string, handler: (args: Args, ctx: ToolContext) => Promise<unknown>): void => {
    if (registry.has(name)) registry.register(name, handler);
  };
  register("GetAbapAST", async (args) => getAst(args));
  register("GetAbapSemanticAnalysis", async (args) => getSemanticAnalysis(args));
  register("GetAbapSystemSymbols", (args, ctx) => getSystemSymbols(args, ctx, registry));
  // `runtime` is only needed for tools that contact a system themselves; the symbol
  // resolver goes through the registry, so keep the reference for the signature.
  void runtime;
}
