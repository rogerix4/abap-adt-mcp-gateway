/**
 * Domain (`DOMA/DD`): a DDIC type with length, decimals and fixed values.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { lockObject, unlockObject, writeSource } from "../../adt/lifecycle.js";
import { patchAttribute, patchBlock, patchElement } from "../../adt/xml-patch.js";
import { elementSpan } from "../../adt/xml-scan.js";
import { propertyValues } from "../spec/properties.js";
import { escapeXml, lower, type CreateContext, type ObjectFamily } from "../types.js";

export function domainFamily(): ObjectFamily {
 const media = "application/vnd.sap.adt.domains.v2+xml";

 const build = (context: CreateContext, withFixedValues: boolean): string => {
 // Numbers are part of this tool's contract (`length`, `decimals`), and a caller
 // that passes 10 instead of "10" must not silently get the default 40.
 const arg = (key: string): string | undefined => {
 const value = context.args[key];
 if (typeof value === "number" && Number.isFinite(value)) return String(value);
 return typeof value === "string" && value.length > 0 ? value: undefined;
 };
 const datatype = arg("datatype") ?? "CHAR";
 const length = (arg("length") ?? "40").padStart(6, "0");
 const decimals = (arg("decimals") ?? "0").padStart(6, "0");
 const valueTable = arg("value_table");
 const fixedValues = Array.isArray(context.args["fixed_values"]) ? (context.args["fixed_values"] as unknown[]): [];

 const fixValuesXml = withFixedValues
 ? fixedValues
.map((entry) => {
 const item = (typeof entry === "string" ? { low: entry }: entry) as Record<string, unknown>;
 const low = typeof item["low"] === "string" ? item["low"]: "";
 const high = typeof item["high"] === "string" ? item["high"]: "";
 const description = typeof item["description"] === "string" ? item["description"]: low;
 const text = typeof item["text"] === "string" ? item["text"]: description;
 // Measured: the fixed-value text element is `doma:text`. `doma:description`
 // is accepted and then dropped — the value keeps an empty text.
 return `<doma:fixValue><doma:low>${escapeXml(low)}</doma:low><doma:high>${escapeXml(high)}</doma:high><doma:text>${escapeXml(text.slice(0, 60))}</doma:text></doma:fixValue>`;
 })
.join("")
: "";

 return (
 '<?xml version="1.0" encoding="UTF-8"?>' +
 '<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core" ' +
 `adtcore:description="${escapeXml(context.description.slice(0, 60))}" adtcore:language="${escapeXml(context.language)}" ` +
 `adtcore:name="${escapeXml(context.name)}" adtcore:type="DOMA/DD" adtcore:masterLanguage="${escapeXml(context.language)}">` +
 `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
 "<doma:content>" +
 "<doma:typeInformation>" +
 `<doma:datatype>${escapeXml(datatype)}</doma:datatype>` +
 `<doma:length>${escapeXml(length)}</doma:length>` +
 `<doma:decimals>${escapeXml(decimals)}</doma:decimals>` +
 "</doma:typeInformation>" +
 "<doma:outputInformation>" +
 `<doma:length>${escapeXml(length)}</doma:length>` +
 "<doma:style>00</doma:style>" +
 `<doma:conversionExit>${escapeXml(arg("conversion_exit") ?? "")}</doma:conversionExit>` +
 `<doma:signExists>${context.args["sign_exists"] === true}</doma:signExists>` +
 `<doma:lowercase>${context.args["lowercase"] === true}</doma:lowercase>` +
 "<doma:ampmFormat>false</doma:ampmFormat>" +
 "</doma:outputInformation>" +
 "<doma:valueInformation>" +
 (valueTable === undefined ? "": `<doma:valueTableRef adtcore:type="TABL/DT" adtcore:name="${escapeXml(valueTable)}"/>`) +
 "<doma:appendExists>false</doma:appendExists>" +
 (fixValuesXml.length === 0 ? "<doma:fixValues/>": `<doma:fixValues>${fixValuesXml}</doma:fixValues>`) +
 "</doma:valueInformation>" +
 "</doma:content></doma:domain>"
);
 };

 return {
 id: "Domain",
 nameParam: "domain_name",
 adtType: "DOMA/DD",
 objectPath: (name) => `/ddic/domains/${lower(name)}`,
 collectionPath: "/ddic/domains",
 media: { accept: media, contentType: media },
 // Measured: fixed values in the create body answer
 // "400 internal error while writing"; the same payload through a later update
 // stores them.
 createBody: (context) => build(context, false),
 afterCreate: async (session, context, objectPath) => {
 const fixedValues = context.args["fixed_values"];
 if (!Array.isArray(fixedValues) || fixedValues.length === 0) return;

 const lock = await lockObject(session, objectPath);
 try {
 await writeSource(session, objectPath, build(context, true), {
 lockHandle: lock.lockHandle,
 accept: media,
 contentType: media,
 });
 } finally {
 await unlockObject(session, objectPath, lock.lockHandle);
 }
 },
 update: {
 kind: "patch",
 contentType: media,
 patch: (current, context) => {
 // The contract puts the payload in `properties`, and this patch used to read the flat
 const values = propertyValues(context.args);
 const arg = (key: string): string | undefined => values[key];
 let xml = current;
 if (arg("description") !== undefined) {
 xml = patchAttribute(xml, "adtcore:description", context.description.slice(0, 60));
 }
 const datatype = arg("datatype");
 if (datatype !== undefined) xml = patchElement(xml, "doma:datatype", datatype);
 const length = arg("length");
 if (length !== undefined) {
 const padded = length.padStart(6, "0");
 xml = patchElement(xml, "doma:length", padded);
 // A domain carries its length twice: the type length and the output (screen)
 // length. `patchElement` rewrites the first match only, so the second one is
 // addressed inside its own block — otherwise a 10 -> 20 change left the
 // output length at 10. The block is located by the scanner, not by a regex:
 // a regex would stop at a same-name child and silently keep the old value.
 const output = elementSpan(xml, "doma:outputInformation");
 if (output !== undefined) {
 const block = xml.slice(output.start, output.end);
 const updated = patchElement(block, "doma:length", padded);
 if (updated !== block) xml = patchBlock(xml, "doma:outputInformation", updated);
 }
 }
 const decimals = arg("decimals");
 if (decimals !== undefined) xml = patchElement(xml, "doma:decimals", decimals.padStart(6, "0"));
 if (values["conversion_exit"] !== undefined) {
 xml = patchElement(xml, "doma:conversionExit", arg("conversion_exit") ?? "");
 }
 if (values["sign_exists"] !== undefined) {
 xml = patchElement(xml, "doma:signExists", String(values["sign_exists"] === "true"));
 }
 if (values["lowercase"] !== undefined) {
 xml = patchElement(xml, "doma:lowercase", String(values["lowercase"] === "true"));
 }

 const valueTable = arg("value_table");
 if (valueTable !== undefined) {
 xml = patchBlock(
 xml,
 "doma:valueTableRef",
 `<doma:valueTableRef adtcore:uri="/sap/bc/adt/ddic/tables/${lower(valueTable)}" adtcore:type="TABL/DT" adtcore:name="${escapeXml(valueTable)}"/>`,
);
 }

 const fixedValues = Array.isArray(context.args["fixed_values"]) ? (context.args["fixed_values"] as unknown[]): undefined;
 if (fixedValues !== undefined) {
 // Measured: the fixed-value text element is `doma:text`; using
 // `high`/`description` answers "internal error while writing".
 const items = fixedValues
.map((entry) => {
 const item = (typeof entry === "string" ? { low: entry }: entry) as Record<string, unknown>;
 const lowValue = typeof item["low"] === "string" ? item["low"]: "";
 const text = typeof item["text"] === "string" ? item["text"]: typeof item["description"] === "string" ? item["description"]: lowValue;
 return `<doma:fixValue><doma:low>${escapeXml(lowValue)}</doma:low><doma:text>${escapeXml(text.slice(0, 60))}</doma:text></doma:fixValue>`;
 })
.join("");
 xml = patchBlock(xml, "doma:fixValues", items.length === 0 ? "<doma:fixValues/>": `<doma:fixValues>${items}</doma:fixValues>`);
 }
 return xml;
 },
 },
 updateTarget: "object",
 verification: "readable",
 };
}
