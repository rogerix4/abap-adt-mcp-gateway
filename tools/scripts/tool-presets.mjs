#!/usr/bin/env node
/**
 * Prints the exposure levels and the `toolPolicy` fragment for one of them.
 *
 * Clients hand the model a bounded tool list (some stop at 128), so a 335-tool server
 * costs the agent whatever did not fit. `toolPolicy.expose` takes one level; `allow` /
 * `deny` narrow it. The levels and their curation live in `src/engine/expose.ts` — this
 * script reads the *built* engine (`dist/engine/expose.js`), so the printed counts cannot
 * drift from what the server actually advertises.
 *
 * Usage:
 *   npm run build && node tools/scripts/tool-presets.mjs            list levels
 *   node tools/scripts/tool-presets.mjs --level core                fragment for toolPolicy
 *   node tools/scripts/tool-presets.mjs --level core --check        count what it advertises
 */

const load = async (path) => {
  try {
    return await import(new URL(path, import.meta.url).href);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    process.stderr.write(
      "tool-presets: dist/ is missing — run `npm run build` first (this script reads the built engine so the\n" +
        "counts match the server instead of a second copy of the level table).\n",
    );
    process.exit(2);
  }
};

const { createRegistry } = await load("../../dist/engine/create-registry.js");
const { advertisesFacade, compileExpose, EXPOSE_LEVELS } = await load("../../dist/engine/expose.js");

const registry = createRegistry();
const shapeOf = (name) => {
  const meta = registry.get(name)?.meta;
  return meta === undefined ? undefined : { effect: meta.effect === "write" ? "write" : "read" };
};

const count = (level) => {
  const visible = compileExpose({ level }, shapeOf);
  const named = registry.list().filter((entry) => visible(entry.definition.name));
  const facade = advertisesFacade(level) ? 3 : 0;
  return {
    named: named.length,
    facade,
    advertised: named.length + facade,
    // Counted by the same decision the server makes, not by a verb pattern.
    writes: named.filter((entry) => entry.meta.effect === "write").length,
    low: named.filter((entry) => entry.meta.layer === "low").length,
  };
};

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const level = arg("--level", arg("--preset", undefined));
const check = process.argv.includes("--check");

if (level === undefined) {
  console.log("exposure levels (toolPolicy.expose):");
  for (const name of EXPOSE_LEVELS) {
    const { named, facade, advertised } = count(name);
    let tail = "";
    if (name === "gateway") {
      // Not "0 tools": this is `full`, advertised as three tools instead of 335.
      tail = ` = full, as ${advertised} tools (all ${registry.list().length} reachable by name)`;
    } else if (facade > 0) {
      tail = ` = ${named} named + ${facade} gateway`;
    }
    console.log(`  ${String(name).padEnd(9)} ${String(advertised).padStart(3)} advertised${tail}`);
  }
  console.log("\nfits a 128-tool budget: core (127)");
  console.log("usage: --level <name> [--check]");
  process.exit(0);
}

if (!EXPOSE_LEVELS.includes(level)) {
  process.stderr.write(`tool-presets: unknown level "${level}" (have: ${EXPOSE_LEVELS.join(", ")})\n`);
  process.exit(2);
}

const totals = count(level);
if (check) {
  const contract = registry.list().length;
  console.log(`level ${level}: ${totals.advertised} tools advertised, ${contract} in the contract`);
  if (totals.named === 0 && totals.facade > 0) {
    console.log(`  all ${contract} tools reachable through the 3 Gateway* tools (this is "full", compressed)`);
  } else {
    console.log(`  named: ${totals.named}${totals.facade > 0 ? " + 3 facade tools (Gateway*)" : ""}`);
  }
  console.log(`  write tools: ${totals.writes}, low-level tools: ${totals.low}`);
  console.log(`  fits a 128-tool budget: ${totals.advertised <= 128}`);
} else {
  // Paste-ready: `allow` / `deny` keep their place next to the level.
  console.log(JSON.stringify({ expose: level, allow: [], deny: [] }, null, 2));
}
