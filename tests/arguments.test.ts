/**
 * Argument discipline.
 *
 * Measured bug: `CreateProgram` was called with a `source_code` its
 * schema never declared. Every argument was accepted, nothing was written, and the
 * result read like success — SAP had created the object with its own template. The
 * same silence hid a wrong parameter name in `UpdateTable` / `UpdateStructure`
 * (`ddl_code` in the contract, `source_code` in the code).
 *
 * So: an undeclared argument must be an error that names what is accepted, and the
 * declared name is the one that must work.
 */

import { describe, expect, it } from "vitest";

import { createRegistry } from "../src/engine/create-registry.ts";

/** A registry with one real contract tool wired to a handler that records its args. */
function probe(tool: string) {
  const registry = createRegistry();
  const calls: Record<string, unknown>[] = [];
  registry.register(tool, async (args) => {
    calls.push(args);
    return { ok: true };
  });
  return { registry, calls };
}

const ctx = { system: "probe" };

describe("undeclared arguments", () => {
  it("rejects an argument the schema does not declare, and says what is accepted", async () => {
    const { registry, calls } = probe("CreateProgram");
    await expect(
      registry.call(
        "CreateProgram",
        { program_name: "ZFOO", package_name: "$TMP", source_code: "REPORT zfoo.\n" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({
        unknown: "source_code",
        accepted: expect.stringContaining("program_name"),
      }),
    });
    // The handler must not run: a call that is wrong is not a call to half-execute.
    expect(calls).toHaveLength(0);
  });

  it("names every stray argument, not only the first", async () => {
    const { registry } = probe("CreateProgram");
    await expect(
      registry.call(
        "CreateProgram",
        { program_name: "ZFOO", package_name: "$TMP", source_code: "x", ddl_code: "y" },
        ctx,
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ unknown: "source_code, ddl_code" }),
    });
  });

  it("lets the transport argument through: every tool receives `system`, none declares it", async () => {
    const { registry, calls } = probe("CreateProgram");
    await registry.call("CreateProgram", { program_name: "ZFOO", package_name: "$TMP", system: "probe" }, ctx);
    expect(calls).toHaveLength(1);
  });

  it("passes a call that only uses declared arguments", async () => {
    const { registry, calls } = probe("CreateProgram");
    await expect(registry.call("CreateProgram", { program_name: "ZFOO", package_name: "$TMP" }, ctx)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(1);
  });
});

/**
 * Measured: `CreateProgram {program_type: "report"}` answered `success: true`
 * and created the program with the **default** type — the word "report" was dropped,
 * because nothing read the schema's `enum`. A closed set is a promise to the caller, so
 * a value outside it has to be an error naming the whole set.
 */
describe("arguments outside their enum", () => {
  it("rejects a program_type the schema does not list, and names the allowed set", async () => {
    const { registry, calls } = probe("CreateProgram");
    await expect(
      registry.call("CreateProgram", { program_name: "ZFOO", package_name: "$TMP", program_type: "report" }, ctx),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({
        argument: "program_type",
        value: "report",
        allowed: expect.arrayContaining(["executable", "include", "module_pool"]),
      }),
    });
    // Nothing may reach SAP: an ignored word is how "report" became a silent default.
    expect(calls).toHaveLength(0);
  });

  it("accepts a value from the enum", async () => {
    const { registry, calls } = probe("CreateProgram");
    await expect(
      registry.call("CreateProgram", { program_name: "ZFOO", package_name: "$TMP", program_type: "include" }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("leaves fields without an enum alone, including boolean and number switches", async () => {
    const { registry, calls } = probe("CreateClass");
    await expect(
      registry.call("CreateClass", { class_name: "ZCL_FOO", package_name: "$TMP", final: true, abstract: false }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("keeps the case tolerance the families already had", async () => {
    const { registry, calls } = probe("CreateServiceBinding");
    await expect(
      registry.call(
        "CreateServiceBinding",
        {
          service_binding_name: "ZUI_FOO",
          service_definition_name: "ZSD_FOO",
          package_name: "$TMP",
          binding_type: "odatav2",
        },
        ctx,
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("does not preempt a resolver that accepts aliases of object_type", async () => {
    // `FUGR` is an alias of `FUNCTION_GROUP`; the route table maps it and refuses the
    // values it does not know with its own message, so the enum must not answer first.
    const { registry, calls } = probe("LockObjectLow");
    await expect(
      registry.call("LockObjectLow", { object_type: "FUGR", object_name: "ZFG_FOO" }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});

/**
 * Measured: `CreateProgram {program_name}` created the object in `$TMP` although
 * the schema requires `package_name`, and `CreateProgramLow {program_name, package_name}`
 * defaulted the missing `description` to the object name. Both arguments were listed under
 * `required` and enforced nowhere.
 */
describe("required arguments", () => {
  it("rejects a call that omits one and names it", async () => {
    const { registry, calls } = probe("CreateProgramLow");
    await expect(
      registry.call("CreateProgramLow", { program_name: "ZFOO", package_name: "$TMP" }, ctx),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ missing: "description" }),
    });
    expect(calls).toHaveLength(0);
  });

  it("names every missing argument, not only the first", async () => {
    const { registry } = probe("CreateProgramLow");
    await expect(registry.call("CreateProgramLow", {}, ctx)).rejects.toMatchObject({
      details: expect.objectContaining({ missing: "program_name, description, package_name" }),
    });
  });

  it("keeps the stray-argument message for a wrong spelling", async () => {
    // `{table_name, source_code}` forgot nothing — it used the wrong name, and saying
    // "missing ddl_code" would hide that.
    const { registry } = probe("UpdateTable");
    await expect(registry.call("UpdateTable", { table_name: "ZTFOO", source_code: "x" }, ctx)).rejects.toMatchObject({
      details: expect.objectContaining({ unknown: "source_code" }),
    });
  });
});

describe("DDL argument name", () => {
  it("UpdateTable declares ddl_code and refuses source_code", async () => {
    const { registry } = probe("UpdateTable");
    await expect(
      registry.call("UpdateTable", { table_name: "ZTFOO", source_code: "define table ztfoo { }" }, ctx),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: expect.objectContaining({ unknown: "source_code" }) });
    await expect(
      registry.call("UpdateTable", { table_name: "ZTFOO", ddl_code: "define table ztfoo { }" }, ctx),
    ).resolves.toEqual({ ok: true });
  });

  it("UpdateStructure declares ddl_code and refuses source_code", async () => {
    const { registry } = probe("UpdateStructure");
    await expect(
      registry.call("UpdateStructure", { structure_name: "ZSTFOO", source_code: "define structure zstfoo { }" }, ctx),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: expect.objectContaining({ unknown: "source_code" }) });
    await expect(
      registry.call("UpdateStructure", { structure_name: "ZSTFOO", ddl_code: "define structure zstfoo { }" }, ctx),
    ).resolves.toEqual({ ok: true });
  });
});
