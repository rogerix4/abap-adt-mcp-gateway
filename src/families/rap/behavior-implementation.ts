/**
 * Behaviour implementation (`BIMP`): not an object of its own — the implementation
 * text lives in the class include `/oo/classes/<name>/includes/implementations`.
 *
 * Moved out of `descriptors.ts` (S3 of `docs/ARCHITECTURE.md`); the body is unchanged.
 */
import { lockObject, unlockObject, writeSource } from "../../adt/lifecycle.js";
import { escapeXml, lower, type ObjectFamily } from "../types.js";

/**
 * The class text of a behaviour implementation.
 *
 * Measured against the upstream client: `source/main` holds the complete
 * class (definition plus an empty implementation section), while the implementations
 * include only carries method bodies. Sending the implementation section through the
 * include answers "The source code of this class is incomplete".
 */
function behaviourMainSource(className: string, behaviour: string): string {
  const name = lower(className);
  return (
    `CLASS ${name} DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF ${lower(behaviour)}.\n\n` +
    "ENDCLASS.\n\n" +
    `CLASS ${name} IMPLEMENTATION.\n\n` +
    "ENDCLASS."
  );
}

/**
 * Behaviour implementation (BIMP).
 *
 * Not an object of its own: the implementation text lives in a class include
 * (`/oo/classes/<name>/includes/implementations`), so this family writes a class
 * include rather than creating something new.
 */
export function behaviorImplementationFamily(): ObjectFamily {
  const media = "application/vnd.sap.adt.oo.classes.v2+xml";

  return {
    id: "BehaviorImplementation",
    nameParam: "behavior_implementation_name",
    // The contract names this argument `class_name` on every verb (measured:
    // `CreateBehaviorImplementation {class_name}` answered `Missing "name"`).
    nameParamByVerb: {
      Create: "class_name",
      Update: "class_name",
      Read: "class_name",
      Get: "class_name",
      Delete: "class_name",
      Lock: "class_name",
      Unlock: "class_name",
      Activate: "class_name",
      Check: "class_name",
      Validate: "class_name",
    },
    // `UpdateBehaviorImplementation` takes `implementation_code` — the body of the
    // implementations include, not the whole class source.
    sourceParam: "implementation_code",
    adtType: "CLAS/OC",
    objectPath: (name) => `/oo/classes/${lower(name)}`,
    collectionPath: "/oo/classes",
    // The implementation body is a class include, not `source/main`.
    sourcePath: (objectPath) => `${objectPath}/includes/implementations`,
    media: { accept: media, contentType: media },
    // A behaviour implementation is a class whose definition says which behaviour it
    // implements. The create payload cannot express that, so the main source is written
    // right after: without the `FOR BEHAVIOR OF` clause the definition that references
    // this class cannot be activated.
    afterCreate: async (session, context, objectPath) => {
      const behaviour = typeof context.args["behavior_definition"] === "string" ? context.args["behavior_definition"].trim() : "";
      if (behaviour.length === 0) return { behaviour_note: "behavior_definition missing: the class is a plain class" };
      const definition = behaviourMainSource(context.name, behaviour);
      // `source/main` carries the whole class text (definition **and** the empty
      // implementation section); the implementations include holds only the method
      // bodies — measured, sending the implementation section through the
      // include answered "The source code of this class is incomplete".
      const lock = await lockObject(session, objectPath);
      try {
        await writeSource(session, `${objectPath}/source/main`, definition, {
          lockHandle: lock.lockHandle,
          corrNr: lock.corrNr,
        });
      } finally {
        await unlockObject(session, objectPath, lock.lockHandle);
      }
      return { behaviour_implementation_for: behaviour };
    },
    // `UpdateBehaviorImplementation` carries the implementation body; the definition
    // clause that binds the class to its behaviour must already be in `source/main`
    // before activation, so it is written first.
    beforeUpdate: async (session, context, objectPath) => {
      const behaviour = typeof context.args["behavior_definition"] === "string" ? context.args["behavior_definition"].trim() : "";
      if (behaviour.length === 0) return;
      const mainSource = behaviourMainSource(context.name, behaviour);
      const lock = await lockObject(session, objectPath);
      try {
        await writeSource(session, `${objectPath}/source/main`, mainSource, {
          lockHandle: lock.lockHandle,
          corrNr: lock.corrNr,
        });
      } finally {
        await unlockObject(session, objectPath, lock.lockHandle);
      }
    },
    createBody: (context) =>
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:description="${escapeXml(context.description.slice(0, 60))}" ` +
      `adtcore:language="${escapeXml(context.language)}" ` +
      `adtcore:name="${escapeXml(context.name)}" ` +
      `adtcore:type="CLAS/OC" ` +
      `adtcore:masterLanguage="${escapeXml(context.language)}" ` +
      'class:final="false" class:abstract="false" class:visibility="public" class:category="generalObjectType">' +
      `<adtcore:packageRef adtcore:name="${escapeXml(context.packageName)}"/>` +
      "</class:abapClass>",
    update: { kind: "source" },
    verification: "normalized",
  };
}
