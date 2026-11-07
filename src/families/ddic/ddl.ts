/**
 * Tables and structures: the two DDIC objects whose content is a DDL body posted
 * to the object URI.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the bodies are
 * unchanged. The factory lives here rather than in a third module because two
 * families are its only callers — splitting it out would make a one-caller wrapper.
 */
import { lockObject, unlockObject, writeSource } from "../../adt/lifecycle.js";
import { GatewayError } from "../../engine/errors.js";
import { escapeXml, lower, renderCreateBody, type CreateContext, type ObjectFamily } from "../types.js";

const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

/** One entry of `CreateStructure.fields`, as the caller may spell it. */
interface FieldSpec {
  readonly name?: unknown;
  readonly data_type?: unknown;
  readonly length?: unknown;
  readonly decimals?: unknown;
  readonly domain?: unknown;
  readonly data_element?: unknown;
}

/** `abap.char(10)` / `abap.dec(15,2)` / `abap.int4`, or the referenced element/domain name. */
function fieldType(field: FieldSpec): string {
  const reference = (value: unknown): string =>
    typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : "";
  // A data element or a domain *is* the type; a predefined type carries its own identity.
  const dataElement = reference(field.data_element);
  if (dataElement.length > 0) return dataElement;
  const domain = reference(field.domain);
  if (domain.length > 0) return domain;

  const type = reference(field.data_type) || "char";
  const length = Number(field.length);
  const decimals = Number(field.decimals);
  if (type === "string") return `abap.string(${Number.isFinite(length) ? Math.max(0, Math.trunc(length)) : 0})`;
  if (!Number.isFinite(length) || length <= 0) return `abap.${type}`;
  const scale = Number.isFinite(decimals) && decimals > 0 ? `,${Math.trunc(decimals)}` : "";
  return `abap.${type}(${Math.trunc(length)}${scale})`;
}

/**
 * The DDL for the fields `CreateStructure` was given.
 *
 * Measured live: the contract marks `fields` **required** and the description says
 * "create … with fields and type references", but the tool created SAP's skeleton
 * (`define structure … { component_to_be_changed : abap.string(0); }`) and ignored the array —
 * `fields` reached nothing. The annotations below are the ones SAP itself seeds into a new
 * structure (read back with `GetStructure`), so the written DDL keeps the same shape.
 */
function structureDdl(context: CreateContext): string | undefined {
  const fields = Array.isArray(context.args["fields"]) ? (context.args["fields"] as FieldSpec[]) : [];
  const includes = Array.isArray(context.args["includes"]) ? (context.args["includes"] as { name?: unknown }[]) : [];
  if (includes.length > 0) {
    throw new GatewayError("NOT_IMPLEMENTED", "CreateStructure does not write `includes` yet: only `fields` is composed into the DDL.", {
      nextAction: "Pass the included structure's fields explicitly, or add the include with UpdateStructure after the create.",
    });
  }
  if (fields.length === 0) return undefined;

  const components = fields.map((field) => {
    const name = String(field.name ?? "").trim().toLowerCase();
    if (name.length === 0) {
      throw new GatewayError("INVALID_ARGUMENT", "CreateStructure: every field needs a name.", {
        nextAction: 'Send fields as [{name: "ID", data_type: "CHAR", length: 10}, …].',
      });
    }
    return `  ${name} : ${fieldType(field)};`;
  });

  return (
    `@EndUserText.label : '${escapeXml(context.description.slice(0, 60))}'\n` +
    "@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n" +
    `define structure ${lower(context.name)} {\n\n` +
    `${components.join("\n")}\n\n` +
    "}"
  );
}

/** Writes the composed DDL right after the POST; the create flow activates it afterwards. */
async function writeStructureFields(
  session: Parameters<NonNullable<ObjectFamily["afterCreate"]>>[0],
  context: CreateContext,
  objectPath: string,
): Promise<Record<string, unknown>> {
  const ddl = structureDdl(context);
  if (ddl === undefined) return {};
  const lock = await lockObject(session, objectPath);
  try {
    await writeSource(session, sourceOf(objectPath), ddl, { lockHandle: lock.lockHandle, corrNr: lock.corrNr });
  } finally {
    await unlockObject(session, objectPath, lock.lockHandle);
  }
  return { fields_written: Array.isArray(context.args["fields"]) ? (context.args["fields"] as unknown[]).length : 0 };
}

/** DDIC objects whose content is a DDL body on the object URI (tables, structures). */
function ddlFamily(config: {
  readonly id: string;
  readonly nameParam: string;
  readonly adtType: string;
  readonly collection: string;
  /** Measured per collection: tables and structures advertise different types. */
  readonly media: string;
  readonly afterCreate?: ObjectFamily["afterCreate"];
}): ObjectFamily {
  const envelope = {
    root: "blue:blueSource",
    namespaces: [["blue", "http://www.sap.com/wbobj/blue"] as const],
  };

  return {
    id: config.id,
    nameParam: config.nameParam,
    // The contract spells the DDL argument `ddl_code` for tables and structures.
    // Reading `source_code` here answered `Missing "source_code"` to a caller that
    // sent exactly what the schema told it to send.
    sourceParam: "ddl_code",
    adtType: config.adtType,
    objectPath: (name) => `${config.collection}/${lower(name)}`,
    collectionPath: config.collection,
    sourcePath: sourceOf,
    media: { accept: config.media, contentType: config.media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, config.adtType),
    ...(config.afterCreate === undefined ? {} : { afterCreate: config.afterCreate }),
    // Measured: the DDL travels to `source/main` as `text/plain`.
    // The object document of a table has no content element at all (reading T000
    // returns `blue:blueSource` metadata plus a packageRef and nothing else), so the
    // earlier base64 `blue:content` body was accepted with **200 and then ignored**:
    // the table kept its generated skeleton while the call reported success.
    update: { kind: "source" },
    // SAP re-formats the DDL it stored (blank lines between the field blocks), so
    // byte equality can never hold — but ignoring blank lines must.
    verification: "normalized",
  };
}

export const tableFamily = (): ObjectFamily =>
  ddlFamily({
    id: "Table",
    nameParam: "table_name",
    adtType: "TABL/DT",
    collection: "/ddic/tables",
    media: "application/vnd.sap.adt.tables.v2+xml",
  });

export const structureFamily = (): ObjectFamily =>
  ddlFamily({
    id: "Structure",
    nameParam: "structure_name",
    // Measured: a structure reports TABL/DS, not STRU/DT.
    adtType: "TABL/DS",
    collection: "/ddic/structures",
    // Measured: posting a structure with the tables media type answers 415.
    media: "application/vnd.sap.adt.structures.v2+xml",
    // `CreateStructure` declares `fields` as required and used to ignore it entirely.
    afterCreate: writeStructureFields,
  });
