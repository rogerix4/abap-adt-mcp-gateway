/**
 * The RFC bridge.
 *
 * Some ABAP surfaces have no ADT resource at all — dynpros and CUA are the two
 * that matter — so they are reached through the remote-enabled dispatcher
 * function module `ZMCP_ADT_DISPATCH` over the system's own SOAP RFC endpoint
 * (`/sap/bc/soap/rfc`). That endpoint ships with the system; there is nothing to
 * install on the SAP side and nothing to configure beyond the logon already in
 * use.
 *
 * The function module takes an action name plus a JSON parameter string and
 * answers with a JSON result, so this module only has to be right about the
 * envelope and about reading a flat `EV_*` response back.
 */

import type { AdtSession } from "./session.js";
import { GatewayError } from "../engine/errors.js";

const SOAP_PATH = "/sap/bc/soap/rfc";
const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const URN_NS = "urn:sap-com:document:sap:rfc:functions";

/** The dispatcher function module every bridged action goes through. */
export const DISPATCH_FM = "ZMCP_ADT_DISPATCH";
/** The text-pool function module, used for the text-element subsources. */
export const TEXTPOOL_FM = "ZMCP_ADT_TEXTPOOL";

export interface RfcBridgeResult {
  /** `0` = done; anything else carries the reason in `message`. */
  readonly subrc: number;
  readonly message: string;
  readonly result: unknown;
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const unescapeXml = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");

/** SOAP envelope for one function-module call; parameters are flat strings. */
export function buildSoapEnvelope(fmName: string, params: Readonly<Record<string, string>>): string {
  const fields = Object.entries(params)
    .map(([name, value]) => `      <${name}>${escapeXml(value)}</${name}>`)
    .join("\n");
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<soap-env:Envelope xmlns:soap-env="${SOAP_NS}" xmlns:urn="${URN_NS}">\n` +
    "  <soap-env:Header/>\n" +
    "  <soap-env:Body>\n" +
    `    <urn:${fmName}>\n${fields}\n    </urn:${fmName}>\n` +
    "  </soap-env:Body>\n" +
    "</soap-env:Envelope>"
  );
}

/**
 * Reads the flat `EV_*` export parameters out of a SOAP response.
 *
 * Deliberately not a general XML parser: SAP answers this call with one shallow
 * `FM.Response` element whose children are single values.
 */
export function parseSoapResult(xml: string, fmName: string): Record<string, string> {
  const fault = /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i.exec(xml)?.[1];
  if (fault !== undefined) {
    throw new GatewayError("UPSTREAM_FAILED", `SOAP fault from ${fmName}: ${unescapeXml(fault).trim()}`);
  }
  const outgoing: Record<string, string> = {};
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?([A-Z][A-Z0-9_]*)>([\s\S]*?)<\/(?:[\w.-]+:)?\1>/g)) {
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;
    outgoing[key] = unescapeXml(value);
  }
  return outgoing;
}

export class RfcBridge {
  readonly #session: AdtSession;

  constructor(session: AdtSession) {
    this.#session = session;
  }

  /** Runs one dispatcher action and returns its decoded result. */
  async dispatch(action: string, params: Readonly<Record<string, unknown>> = {}): Promise<RfcBridgeResult> {
    return this.#call(DISPATCH_FM, {
      IV_ACTION: action,
      IV_PARAMS: JSON.stringify(params),
    });
  }

  /** Runs one text-pool action (`READ` / `WRITE`), whose parameters are flat. */
  async textpool(
    action: string,
    params: { program: string; language?: string; textpool_json?: string },
  ): Promise<RfcBridgeResult> {
    return this.#call(TEXTPOOL_FM, {
      IV_ACTION: action,
      IV_PROGRAM: params.program,
      IV_LANGUAGE: params.language ?? "",
      IV_TEXTPOOL_JSON: params.textpool_json ?? "",
    });
  }

  /**
   * Calls any remote-enabled function module with flat parameters.
   *
   * Used by the workload bridges (`ZMCP_WL_*`), whose parameters are their own
   * (`IV_PROGRAMS`, `IV_TCODES`, …) rather than the dispatcher's action-plus-JSON shape.
   */
  async call(fmName: string, params: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const response = await this.#session.request({
      method: "POST",
      path: SOAP_PATH,
      absolute: true,
      accept: "text/xml",
      contentType: "text/xml; charset=utf-8",
      headers: { SOAPAction: URN_NS },
      body: buildSoapEnvelope(fmName, params),
      timeoutMs: 120_000,
      retryOnSessionLoss: false,
    });
    return parseSoapResult(response.body, fmName);
  }

  async #call(fmName: string, params: Readonly<Record<string, string>>): Promise<RfcBridgeResult> {
    const response = await this.#session.request({
      method: "POST",
      path: SOAP_PATH,
      absolute: true,
      accept: "text/xml",
      contentType: "text/xml; charset=utf-8",
      headers: { SOAPAction: URN_NS },
      body: buildSoapEnvelope(fmName, params),
      timeoutMs: 120_000,
      retryOnSessionLoss: false,
    });

    const raw = parseSoapResult(response.body, fmName);
    const subrc = Number(raw.EV_SUBRC ?? raw.ev_subrc ?? 0);
    const message = String(raw.EV_MESSAGE ?? raw.ev_message ?? "");
    const payload = String(raw.EV_RESULT ?? raw.ev_result ?? "");

    let result: unknown = payload;
    try {
      result = payload === "" ? undefined : JSON.parse(payload);
    } catch {
      result = payload;
    }

    if (!Number.isFinite(subrc) || subrc !== 0) {
      // The reason lives in EV_MESSAGE, and for a refusal the detail table lives in
      // EV_RESULT (a SmartForm check error table, a dry-run summary, …). Both come back
      // so the caller can answer with the bridge's own words instead of a guess.
      throw new GatewayError(
        "UPSTREAM_FAILED",
        `${fmName} error (action=${String(params.IV_ACTION ?? "?")}, subrc=${subrc}): ${message || "no message"}`,
        {
          ...(result === undefined ? {} : { result }),
          // subrc=8 is the dispatcher's own "the action could not be run" — only then is
          // "is the bridge active?" the right question. A 4 is an ordinary refusal.
          ...(subrc === 8
            ? { nextAction: "the dispatcher could not run the action; check that its branch and the target function module are active" }
            : {}),
        },
      );
    }
    return { subrc, message, result };
  }
}
