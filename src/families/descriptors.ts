/**
 * The two registration lists (`textFamilies`, `xmlFamilies`) and nothing else.
 *
 * S3 of `docs/ARCHITECTURE.md`: the descriptors live per domain now — `oo/`, `ddic/`,
 * `cds/`, `program/`, `rap/`, plus `program.ts` and `package.ts` — and are re-exported
 * from here so `registry.ts` keeps a single import.
 *
 * Every value in them was measured on the reference system (BASIS 754): the path by
 * reading a standard object, the media type from the discovery document, and the
 * root element from the body that read returned. Nothing is copied from memory.
 *
 * Note the type codes: a structure is `TABL/DS`, not `STRU/DT`; a data element is
 * `DTEL/DE`, a domain `DOMA/DD`.
 */

import type { ObjectFamily } from "./types.js";

/** Classes and interfaces share the OO shape, see `oo/oo.ts`. */
import { classFamily, interfaceFamily } from "./oo/oo.js";
export { classFamily, interfaceFamily };

/** Tables and structures: DDL bodies, see `ddic/ddl.ts`. */
import { structureFamily, tableFamily } from "./ddic/ddl.js";
export { structureFamily, tableFamily };

/**
 * Data elements, domains, views and metadata extensions need their own payload
 * shape (XML body instead of a DDL source) and are implemented in the route table
 * rather than here.
 */
export const textFamilies: readonly ObjectFamily[] = [
  classFamily(),
  interfaceFamily(),
  tableFamily(),
  structureFamily(),
];

/** Data element: XML body on the object URI, children measured from a read. */
import { dataElementFamily } from "./ddic/data-element.js";
export { dataElementFamily };


/** Domain: same shape as a data element, different content element. */
import { domainFamily } from "./ddic/domain.js";
export { domainFamily };


/**
 * CDS / DDLX / SRVD: text sources with an inline body on create, see `cds/cds.ts`.
 * Views and metadata extensions used to sit here; the service definition used to sit
 * further down between the include and package families, so it is re-exported from
 * `cds/cds.ts` with its siblings.
 */
import { metadataExtensionFamily, serviceDefinitionFamily, viewFamily } from "./cds/cds.js";
export { metadataExtensionFamily, serviceDefinitionFamily, viewFamily };

/**
 * Function group / function module / include: see `program/`.
 */
import { functionGroupFamily } from "./program/function-group.js";
import { functionModuleFamily } from "./program/function-module.js";
import { includeFamily } from "./program/include.js";
export { functionGroupFamily, functionModuleFamily, includeFamily };

/** Package (DEVC/K): see `package.ts`. */
import { packageFamily } from "./package.js";
export { packageFamily };

/**
 * Behaviour definition, behaviour implementation and service binding: see `rap/`.
 */
import { behaviorDefinitionFamily } from "./rap/behavior-definition.js";
import { behaviorImplementationFamily } from "./rap/behavior-implementation.js";
import { serviceBindingFamily } from "./rap/binding.js";
export { behaviorDefinitionFamily, behaviorImplementationFamily, serviceBindingFamily };

/** Families whose payload shape has been measured on the reference system. */
export const xmlFamilies: readonly ObjectFamily[] = [
  dataElementFamily(),
  domainFamily(),
  viewFamily(),
  metadataExtensionFamily(),
  functionGroupFamily(),
  functionModuleFamily(),
  includeFamily(),
  serviceDefinitionFamily(),
  packageFamily(),
  behaviorDefinitionFamily(),
  behaviorImplementationFamily(),
  serviceBindingFamily(),
];

