/**
 * One description of a document family's properties, used for all three things that used to be
 * written by hand and drifted apart:
 *
 *   1. which keys the caller may send (`properties` on the tool, flat arguments also accepted),
 *   2. what markup proves that a value landed in the document,
 *   3. the read-back check after a write.
 *
 * Measured: `properties: { length: 50 }` was accepted by the schema, dropped by the patch
 * (it read the flat arguments) and dropped again as a JSON number — the call answered
 * `written: true` while the domain kept `000040`, and the same defect was copied into the data
 * element. One spec cannot drift from itself.
 */

/** How one property becomes text for SAP, and the markup that proves it is stored. */
export interface PropertyRule {
  /** Converts what the caller sent into the text SAP stores; `undefined` means "not usable". */
  readonly text: (value: unknown) => string | undefined;
  /** The markup the stored document must contain when the property was applied. */
  readonly markup: (text: string) => string;
}

export type PropertySpec = Readonly<Record<string, PropertyRule>>;

/** A numeric argument is as valid as a string one (`length: 50` is JSON's natural shape). */
const scalar = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
};

const padded = (size: number) => (text: string) => text.padStart(size, "0");

/**
 * The values a call carries, as text.
 *
 * `properties` is the documented payload; the flat arguments are accepted too and stay supported.
 * `properties` wins where both name the same key.
 */
export function propertyValues(args: Readonly<Record<string, unknown>>): Record<string, string> {
  const properties = args["properties"];
  const merged =
    properties !== null && typeof properties === "object"
      ? { ...args, ...(properties as Record<string, unknown>) }
      : args;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    const text = scalar(value);
    if (text !== undefined && key !== "properties") out[key] = text;
  }
  return out;
}

export const DOMAIN_PROPERTIES: PropertySpec = {
  description: { text: scalar, markup: (text) => `adtcore:description="${text}"` },
  datatype: { text: scalar, markup: (text) => `<doma:datatype>${text.toUpperCase()}</doma:datatype>` },
  length: { text: scalar, markup: (text) => `<doma:length>${text.padStart(6, "0")}</doma:length>` },
  decimals: { text: scalar, markup: (text) => `<doma:decimals>${text.padStart(6, "0")}</doma:decimals>` },
  conversion_exit: { text: scalar, markup: (text) => `<doma:conversionExit>${text}</doma:conversionExit>` },
  sign_exists: { text: scalar, markup: (text) => `<doma:signExists>${text}</doma:signExists>` },
  lowercase: { text: scalar, markup: (text) => `<doma:lowercase>${text}</doma:lowercase>` },
};

export const DATA_ELEMENT_PROPERTIES: PropertySpec = {
  description: { text: scalar, markup: (text) => `adtcore:description="${text}"` },
  type_kind: { text: scalar, markup: (text) => `<dtel:typeKind>${text}</dtel:typeKind>` },
  type_name: { text: scalar, markup: (text) => `<dtel:typeName>${text}</dtel:typeName>` },
  data_type: { text: scalar, markup: (text) => `<dtel:dataType>${text.toUpperCase()}</dtel:dataType>` },
  length: { text: scalar, markup: (text) => `<dtel:dataTypeLength>${text.padStart(6, "0")}</dtel:dataTypeLength>` },
  decimals: { text: scalar, markup: (text) => `<dtel:dataTypeDecimals>${text.padStart(6, "0")}</dtel:dataTypeDecimals>` },
  field_label_short: { text: scalar, markup: (text) => `<dtel:shortFieldLabel>${text}</dtel:shortFieldLabel>` },
  field_label_medium: { text: scalar, markup: (text) => `<dtel:mediumFieldLabel>${text}</dtel:mediumFieldLabel>` },
  field_label_long: { text: scalar, markup: (text) => `<dtel:longFieldLabel>${text}</dtel:longFieldLabel>` },
  field_label_heading: { text: scalar, markup: (text) => `<dtel:headingFieldLabel>${text}</dtel:headingFieldLabel>` },
};

const SPECS: Readonly<Record<string, PropertySpec>> = {
  Domain: DOMAIN_PROPERTIES,
  DataElement: DATA_ELEMENT_PROPERTIES,
};

/** The spec for a family, or `undefined` when its update is not a document patch. */
export function propertySpecOf(familyId: string): PropertySpec | undefined {
  return SPECS[familyId];
}

/**
 * Checks the properties a call carried against the stored document.
 *
 * Only keys the caller actually sent are checked, so SAP's own reformatting of everything else stays
 * out of the verdict. Returns a message when a sent property is missing from the document.
 */
export function missingProperty(
  spec: PropertySpec,
  args: Readonly<Record<string, unknown>>,
  document: string,
): string | undefined {
  const properties = args["properties"];
  if (properties === null || typeof properties !== "object") return undefined;
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    const rule = spec[key];
    if (rule === undefined) continue;
    const text = rule.text(raw);
    if (text === undefined) continue;
    const markup = rule.markup(text);
    if (!document.includes(markup)) {
      return `properties.${key} was sent as ${JSON.stringify(raw)} but the stored document has no ${markup}`;
    }
  }
  return undefined;
}

/** Only used to make the padding helper visible to the specs above without repeating it. */
export const padLength = padded;
