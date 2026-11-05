/**
 * ABAP Unit run requests.
 *
 * The tools document `tests: [{ container_class, test_class }]` plus scope / risk /
 * duration, but a route row can only forward a ready-made body — so the arguments
 * were ignored and the caller had to hand-write XML that the schema never mentions.
 * This module turns the documented arguments into the request, and knows both
 * formats ADT answers to:
 *
 *   - `aunit:run`            -> POST /abapunit/runs     (current releases)
 *   - `aunit:runConfiguration` -> POST /abapunit/testruns (older ones; the run is
 *     executed synchronously and the result comes back in the same answer)
 *
 * Both are copied from the archived implementation, which had a legacy path for
 * exactly this reason.
 */

import { GatewayError } from "../engine/errors.js";

type Args = Record<string, unknown>;

const CONTAINER_PATH: Readonly<Record<string, string>> = {  CLAS: "/oo/classes",
  PROG: "/programs/programs",
  FUGR: "/functions/groups",
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface UnitTest {
  readonly containerClass: string;
  readonly containerType: string;
  readonly testClass: string;
}

/** Container URI as the legacy request wants it: ADT path, lower-cased name. */
function containerUri(test: UnitTest): string {
  const prefix = CONTAINER_PATH[test.containerType] ?? CONTAINER_PATH.CLAS;
  return `/sap/bc/adt${prefix}/${encodeURIComponent(test.containerClass.toLowerCase())}`;
}

function tests(args: Args): UnitTest[] {
  const list = Array.isArray(args.tests) ? args.tests : [];
  const parsed = list.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const containerClass = typeof row.container_class === "string" ? row.container_class.toUpperCase() : "";
    const testClass = typeof row.test_class === "string" ? row.test_class : "";
    const containerType = typeof row.container_type === "string" ? row.container_type.toUpperCase() : "CLAS";
    return { containerClass, containerType, testClass };
  });
  return parsed.filter((test) => test.containerClass !== "");
}

const flag = (group: Record<string, unknown> | undefined, key: string, fallback: boolean): string => {
  const value = group?.[key];
  return (typeof value === "boolean" ? value : fallback) ? "true" : "false";
};

const group = (args: Args, key: string): Record<string, unknown> | undefined =>
  typeof args[key] === "object" && args[key] !== null ? (args[key] as Record<string, unknown>) : undefined;

const text = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" && (args[key] as string).length > 0 ? (args[key] as string) : undefined;

/**
 * The `aunit:run` body current releases take.
 */
export function modernUnitTestBody(args: Args): string {
  const rows = requireTests(args);
  const scope = group(args, "scope");
  const risk = group(args, "risk_level");
  const duration = group(args, "duration");
  const testsXml = rows
    .map(
      (test) =>
        `<aunit:test containerClass="${escapeXml(test.containerClass)}" class="${escapeXml(test.testClass)}"/>`,
    )
    .join("");
  const title = text(args, "title") ?? rows[0]?.testClass ?? "ABAP Unit";
  const context = text(args, "context") ?? "MCP ABAP ADT Gateway";
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<aunit:run xmlns:aunit="http://www.sap.com/adt/api/aunit" title="${escapeXml(title)}" context="${escapeXml(context)}">` +
    "<aunit:options>" +
    `<aunit:scope ownTests="${flag(scope, "own_tests", true)}" foreignTests="${flag(scope, "foreign_tests", false)}" ` +
    `addForeignTestsAsPreview="${flag(scope, "add_foreign_tests_as_preview", true)}"/>` +
    `<aunit:riskLevel harmless="${flag(risk, "harmless", true)}" dangerous="${flag(risk, "dangerous", true)}" ` +
    `critical="${flag(risk, "critical", true)}"/>` +
    `<aunit:duration short="${flag(duration, "short", true)}" medium="${flag(duration, "medium", true)}" ` +
    `long="${flag(duration, "long", true)}"/>` +
    "</aunit:options>" +
    `<aunit:tests>${testsXml}</aunit:tests>` +
    "</aunit:run>"
  );
}

/**
 * The `aunit:runConfiguration` body older releases take. The run is object-scoped
 * there: every test class of the container runs, so the containers are deduplicated
 * and `test_class` has no effect.
 */
export function legacyUnitTestBody(args: Args): string {
  const rows = requireTests(args);
  const seen = new Set<string>();
  const references: string[] = [];
  for (const test of rows) {
    const uri = containerUri(test);
    if (seen.has(uri)) continue;
    seen.add(uri);
    references.push(`<adtcore:objectReference adtcore:uri="${escapeXml(uri)}"/>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">' +
    '<external><coverage active="false"/></external>' +
    '<adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive">' +
    `<adtcore:objectReferences>${references.join("")}</adtcore:objectReferences>` +
    "</objectSet></adtcore:objectSets></aunit:runConfiguration>"
  );
}

/** The tools refuse an empty run: there is nothing to execute without a container. */
function requireTests(args: Args): UnitTest[] {
  const rows = tests(args);
  if (rows.length === 0) {
    throw new GatewayError(
      "INVALID_ARGUMENT",
      'An ABAP Unit run needs at least one container: pass tests: [{ container_class, test_class }].',
      { argument: "tests" },
    );
  }
  return rows;
}
