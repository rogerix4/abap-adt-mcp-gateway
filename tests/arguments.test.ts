/**
 * Argument discipline.
 *
 * Measured bug (2026-11-04): `CreateProgram` was called with a `source_code` its
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
