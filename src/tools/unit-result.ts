/**
 * Reading an ABAP Unit result.
 *
 * Measured live: `GetClassUnitTestResultLow` on a **failing** test answered
 * `{success: true, raw_xml: "…<alert kind=\"failedAssertion\" severity=\"critical\">…"}`
 * — the failure was in the document, and every field a caller branches on said the run was
 * fine. A result tool whose `success` ignores the result is worse than no result tool.
 *
 * The alert kinds SAP uses: `failedAssertion`, `exception`, `warning`, `tolerable`,
 * `criticalAssertionError`. `severity="critical"` marks the ones that make the run red.
 */

import { attributeOf, childTextOf, findElements, parseXml } from "../adt/xml.js";

export interface UnitAlert {
  readonly kind: string;
  readonly severity: string;
  readonly title: string;
  readonly detail?: string;
  /** The test method the alert belongs to, when SAP says (it usually does). */
  readonly method?: string;
}

export interface UnitResultSummary {
  readonly success: boolean;
  readonly programs: number;
  readonly test_classes: number;
  readonly tests: number;
  /** Alerts whose severity is `critical` — the run is red when this is above zero. */
  readonly failures: number;
  readonly alerts: readonly UnitAlert[];
}

/**
 * `undefined` when the body is not an ABAP Unit result document.
 *
 * An empty `<aunit:runResult/>` **is** a result document: it means nothing ran (the test
 * include was still inactive, or the test class name was wrong). It is reported as a
 * summary with zero tests instead of being hidden, because "no tests ran" is exactly what
 * a caller must not mistake for "all tests passed".
 */
export function parseUnitResult(body: string): UnitResultSummary | undefined {
  const parsed = parseXml(body);
  if (parsed === undefined) return undefined;
  if (!/runResult/i.test(body)) return undefined;

  const methods = findElements(parsed, "testMethod");
  const alerts: UnitAlert[] = [];
  for (const method of methods) {
    // The parser keeps local names, so a prefixed attribute arrives as `name`, not
    // `adtcore:name`; ask for both rather than depending on which it was.
    const methodName = attributeOf(method, "name") ?? attributeOf(method, "adtcore:name") ?? "";
    for (const alert of findElements(method, "alert")) {
      const title = (childTextOf(alert, "title") ?? "").trim();
      const detail = (childTextOf(alert, "detail") ?? "").trim();
      alerts.push({
        kind: attributeOf(alert, "kind") ?? "",
        severity: attributeOf(alert, "severity") ?? "",
        title,
        ...(detail.length === 0 ? {} : { detail }),
        ...(methodName.length === 0 ? {} : { method: methodName }),
      });
    }
  }
  const failures = alerts.filter((alert) => alert.severity === "critical").length;

  return {
    success: failures === 0,
    programs: findElements(parsed, "program").length,
    test_classes: findElements(parsed, "testClass").length,
    tests: methods.length,
    failures,
    alerts,
  };
}

export interface UnitStatusSummary {
  readonly finished: boolean;
  readonly status: string;
  readonly percentage: number;
}

/** `{finished, status, percentage}` from a run-status document, or `undefined`. */
export function parseUnitStatus(body: string): UnitStatusSummary | undefined {
  const parsed = parseXml(body);
  if (parsed === undefined) return undefined;
  const progress = findElements(parsed, "progress")[0];
  if (progress === undefined) return undefined;
  const status = attributeOf(progress, "status") ?? "";
  const percentage = Number(attributeOf(progress, "percentage") ?? "0");
  return {
    finished: status.toUpperCase() === "FINISHED",
    status,
    percentage: Number.isFinite(percentage) ? percentage : 0,
  };
}
