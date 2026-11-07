/**
 * Classes and interfaces: both are OO objects that share one envelope shape, so they
 * differ only in root element, namespace, path and the class-only attributes.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the bodies are unchanged.
 */
import { escapeXml, lower, renderCreateBody, type CreateContext, type ObjectFamily } from "../types.js";

const sourceOf = (objectPath: string) => `${objectPath}/source/main`;

/** Classes and interfaces share the OO shape; only root element and path differ. */
function ooFamily(config: {
  readonly id: string;
  readonly nameParam: string;
  readonly adtType: string;
  readonly collection: string;
  readonly root: string;
  readonly namespace: string;
  readonly media: string;
  readonly extraAttributes?: (args: Readonly<Record<string, unknown>>) => readonly (readonly [string, string])[];
  /** Elements that must be declared at creation, e.g. the includes to create. */
  readonly children?: (context: CreateContext) => string;
}): ObjectFamily {
  const envelope = {
    root: config.root,
    namespaces: [[config.root.split(":")[0] ?? "class", config.namespace] as const],
    ...(config.children === undefined ? {} : { children: config.children }),
    ...(config.extraAttributes === undefined
      ? {}
      : {
          attributes: (context: { readonly args: Readonly<Record<string, unknown>> }) =>
            config.extraAttributes!(context.args),
        }),
  };

  return {
    id: config.id,
    nameParam: config.nameParam,
    adtType: config.adtType,
    objectPath: (name) => `${config.collection}/${lower(name)}`,
    collectionPath: config.collection,
    sourcePath: sourceOf,
    media: { accept: config.media, contentType: config.media },
    envelope,
    createBody: (context) => renderCreateBody(envelope, context, config.adtType),
    update: { kind: "source" },
  };
}

export const classFamily = (): ObjectFamily =>
  ooFamily({
    id: "Class",
    nameParam: "class_name",
    adtType: "CLAS/OC",
    collection: "/oo/classes",
    root: "class:abapClass",
    namespace: "http://www.sap.com/adt/oo/classes",
    media: "application/vnd.sap.adt.oo.classes.v2+xml",
    extraAttributes: (args) => [
      ["class:final", args["final"] === true ? "true" : "false"],
      ["class:abstract", args["abstract"] === true ? "true" : "false"],
      ["class:visibility", args["create_protected"] === true ? "protected" : "public"],
      ["class:category", "generalObjectType"],
    ],
    // Declaring the include here is what makes the testclasses include exist: a PUT to
    // it later answers "<name>=CCAU does not have any inactive version" without this.
    children: (context) =>
      "<class:include adtcore:name=\"CLAS/OC\" adtcore:type=\"CLAS/OC\" class:includeType=\"testclasses\"/>" +
      (typeof context.args["superclass"] === "string" && context.args["superclass"].length > 0
        ? `<class:superClassRef adtcore:name="${escapeXml(context.args["superclass"] as string)}"/>`
        : ""),
  });

export const interfaceFamily = (): ObjectFamily =>
  ooFamily({
    id: "Interface",
    nameParam: "interface_name",
    adtType: "INTF/OI",
    collection: "/oo/interfaces",
    root: "intf:abapInterface",
    namespace: "http://www.sap.com/adt/oo/interfaces",
    media: "application/vnd.sap.adt.oo.interfaces.v2+xml",
  });
