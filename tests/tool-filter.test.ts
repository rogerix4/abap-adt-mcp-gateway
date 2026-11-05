/**
 * Tool visibility filter.
 *
 * The contract stays at 335; what a client advertises to a model is a subset. Getting
 * this wrong is quiet in both directions: too wide and the model silently loses tools
 * the client refused to pass on, too narrow and the agent cannot see the tool at all.
 */

import { describe, expect, it } from "vitest";

import { compileToolFilter, isPermissive } from "../src/engine/tool-filter.ts";

describe("tool filter", () => {
  const shape = (name: string) => ({ effect: /^(Create|Update|Delete|Activate|Release|Patch)/.test(name) ? ("write" as const) : ("read" as const) });

  it("lets everything through when unset", () => {
    const visible = compileToolFilter({}, shape);
    expect(visible("GetProgram")).toBe(true);
    expect(visible("DeleteClass")).toBe(true);
    expect(visible("UpdateClassLow")).toBe(true);
    expect(isPermissive({})).toBe(true);
  });

  it("keeps only what `allow` matches, case-insensitively", () => {
    const visible = compileToolFilter({ allow: ["Get*", "ReadProgram"] }, shape);
    expect(visible("GetProgram")).toBe(true);
    expect(visible("getclass")).toBe(true);
    expect(visible("ReadProgram")).toBe(true);
    expect(visible("UpdateProgram")).toBe(false);
    expect(visible("GetProgramLow")).toBe(true);
  });

  it("removes what `deny` matches, after `allow`", () => {
    const visible = compileToolFilter({ allow: ["*Program*"], deny: ["*Low"] }, shape);
    expect(visible("GetProgram")).toBe(true);
    expect(visible("GetProgFullCode")).toBe(false);
    expect(visible("UpdateProgramLow")).toBe(false);
  });

  it("drops write tools when the write layer is off", () => {
    const visible = compileToolFilter({ layers: ["readonly"] }, shape);
    expect(visible("GetProgram")).toBe(true);
    expect(visible("ReadClass")).toBe(true);
    expect(visible("UpdateClass")).toBe(false);
    expect(visible("DeleteProgram")).toBe(false);
  });

  it("drops read tools when only the write layer is on", () => {
    const visible = compileToolFilter({ layers: ["write"] }, shape);
    expect(visible("UpdateClass")).toBe(true);
    expect(visible("GetProgram")).toBe(false);
  });

  it("drops `*Low` unless the low layer is on", () => {
    const visible = compileToolFilter({ layers: ["readonly", "write"] }, shape);
    expect(visible("GetProgram")).toBe(true);
    expect(visible("GetProgramLow")).toBe(false);
    expect(visible("UpdateProgramLow")).toBe(false);
  });

  it("treats a wildcard as any run of characters, not as a regex", () => {
    const visible = compileToolFilter({ allow: ["Get*"] }, shape);
    expect(visible("GetProgram")).toBe(true);
    expect(visible("SetProgram")).toBe(false);
    expect(compileToolFilter({ allow: ["Get("] }, shape)("Get(")).toBe(true);
  });

  it("reports a deny-only filter as non-permissive", () => {
    expect(isPermissive({ deny: ["*Low"] })).toBe(false);
    expect(isPermissive({ layers: ["readonly"] })).toBe(false);
  });
});
