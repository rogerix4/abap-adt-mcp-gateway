/**
 * Exposure levels.
 *
 * The contract stays at 335; what a client is shown is one level, narrowed by `allow`
 * and `deny`. Getting this wrong is quiet in both directions: too wide and the model
 * silently loses tools the client refused to pass on, too narrow and the agent cannot see
 * the tool at all. The counts asserted here are the documented table — if a level
 * silently changes size, the docs are wrong from that moment on.
 */

import { describe, expect, it } from "vitest";

import { createRegistry } from "../src/engine/create-registry.ts";
import {
  advertisesFacade,
  compileExpose,
  EXPOSE_LEVELS,
  kindOf,
  type ExposeLevel,
} from "../src/engine/expose.ts";

describe("exposure levels", () => {
  const registry = createRegistry();
  const shapeOf = (name: string) => {
    const meta = registry.get(name)?.meta;
    return meta === undefined ? undefined : { effect: meta.effect === "write" ? ("write" as const) : ("read" as const) };
  };
  const named = (level: ExposeLevel) => {
    const visible = compileExpose({ level }, shapeOf);
    return registry.list().filter((entry) => visible(entry.definition.name)).length;
  };

  it("partitions the contract into three kinds", () => {
    const counts = { readonly: 0, write: 0, low: 0 };
    for (const entry of registry.list()) {
      const kind = kindOf(entry.definition.name, shapeOf(entry.definition.name));
      expect(kind).toBeDefined();
      counts[kind as keyof typeof counts] += 1;
    }
    expect(counts.readonly + counts.write + counts.low).toBe(registry.list().length);
  });

  it("advertises the documented size for every level", () => {
    expect({
      none: named("none"),
      gateway: named("gateway"),
      readonly: named("readonly"),
      write: named("write"),
      low: named("low"),
      high: named("high"),
      full: named("full"),
      core: named("core"),
    }).toEqual({
      none: 0,
      gateway: 0,
      readonly: 115,
      write: 86,
      low: 134,
      high: 201,
      full: 335,
      core: 124,
    });
  });

  it("keeps the facade on the levels that narrow the list", () => {
    expect(EXPOSE_LEVELS.filter((level) => advertisesFacade(level))).toEqual(["gateway", "core"]);
  });

  it("treats `full` as everything, `none` as nothing", () => {
    const full = compileExpose({ level: "full" }, shapeOf);
    const none = compileExpose({ level: "none" }, shapeOf);
    for (const entry of registry.list()) {
      expect(full(entry.definition.name)).toBe(true);
      expect(none(entry.definition.name)).toBe(false);
    }
  });

  it("filters by kind, so `readonly` has no writes and no *Low", () => {
    const visible = compileExpose({ level: "readonly" }, shapeOf);
    expect(visible("GetProgram")).toBe(true);
    expect(visible("UpdateClass")).toBe(false);
    // `GetProgramLow` is a read whose kind is `low`, not `readonly`.
    expect(visible("GetProgramLow")).toBe(false);
  });

  it("lets `allow` narrow and `deny` remove afterwards", () => {
    const allow = compileExpose({ level: "full", allow: ["Get*", "ReadClass"] }, shapeOf);
    expect(allow("GetProgram")).toBe(true);
    expect(allow("ReadClass")).toBe(true);
    expect(allow("UpdateProgram")).toBe(false);

    const deny = compileExpose({ level: "full", allow: ["*Program*"], deny: ["*Low"] }, shapeOf);
    expect(deny("GetProgram")).toBe(true);
    expect(deny("GetProgFullCode")).toBe(false);
    expect(deny("UpdateProgramLow")).toBe(false);
  });

  it("can only narrow a level's own curation, never widen it", () => {
    const curated = compileExpose({ level: "core" }, shapeOf);
    expect(curated("CreateProgram")).toBe(true);
    // A handler tool is not an object view; `core` drops it.
    expect(curated("HandlerActivate")).toBe(false);

    const narrowed = compileExpose({ level: "core", allow: ["GetSqlQuery"] }, shapeOf);
    expect(narrowed("GetSqlQuery")).toBe(true);
    expect(narrowed("CreateProgram")).toBe(false);
  });

  it("treats a wildcard as any run of characters, not as a regex", () => {
    const visible = compileExpose({ level: "core", allow: ["Get*"] }, shapeOf);
    expect(visible("GetProgram")).toBe(true);
    expect(compileExpose({ level: "full", allow: ["Get("] }, shapeOf)("Get(")).toBe(true);
  });

  it("hides a tool it cannot classify when the level names no kind", () => {
    expect(compileExpose({ level: "none" }, () => undefined)("SomethingNew")).toBe(false);
    expect(compileExpose({ level: "full" }, () => undefined)("SomethingNew")).toBe(true);
  });
});
