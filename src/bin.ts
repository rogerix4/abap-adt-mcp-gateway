#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * stdout carries the MCP protocol and nothing else — every diagnostic goes to
 * stderr. A stray `console.log` here corrupts the stream and clients report it
 * as "server sent invalid JSON".
 */

import { ConfigError, loadConfig, type CliOverrides } from "./config/load.js";
import { resolveSystemSecrets } from "./config/secrets.js";
import { createRegistry } from "./engine/create-registry.js";
import { compileToolFilter } from "./engine/tool-filter.js";
import { registerFamilies } from "./families/index.js";
import { serveStdio } from "./mcp/server.js";
import { GatewayRuntime } from "./runtime.js";
import { NAME, VERSION } from "./version.js";

type Mode = "serve" | "coverage" | "version" | "help";

interface CliOptions {
  readonly mode: Mode;
  readonly overrides: CliOverrides;
}

const HELP = `${NAME} ${VERSION}

Usage:
  abap-adt-mcp                 start the MCP server on stdio
  abap-adt-mcp --coverage      print tool implementation coverage and exit
  abap-adt-mcp --version       print version and exit
  abap-adt-mcp --help          show this help

Options:
  --config <path>              read an extra configuration layer last
  --system <id>                default system for this run
  --log-level <level>          error | warn | info | debug

The tool contract is fixed at 335 tools (see tools/catalog.json).
Configuration is validated at startup; with no configuration the gateway
starts with no systems connected.`;

function readOption(argv: readonly string[], name: string): string | undefined {
  const withEquals = argv.find((argument) => argument.startsWith(`${name}=`));
  if (withEquals !== undefined) return withEquals.slice(name.length + 1);

  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function parseArgs(argv: readonly string[]): CliOptions {
  const mode: Mode =
    argv.includes("--version") || argv.includes("-v")
      ? "version"
      : argv.includes("--help") || argv.includes("-h")
        ? "help"
        : argv.includes("--coverage")
          ? "coverage"
          : "serve";

  const overrides: {
    configPath?: string;
    system?: string;
    logLevel?: string;
  } = {};

  const configPath = readOption(argv, "--config");
  if (configPath !== undefined) overrides.configPath = configPath;

  const system = readOption(argv, "--system");
  if (system !== undefined) overrides.system = system;

  const logLevel = readOption(argv, "--log-level");
  if (logLevel !== undefined) overrides.logLevel = logLevel;

  return { mode, overrides };
}

function describeSystems(config: ReturnType<typeof loadConfig>): string {
  if (config.systems.length === 0) return "no systems configured";
  const list = config.systems.map((system) => `${system.id}(${system.tier})`).join(", ");
  return `${config.systems.length} system(s): ${list}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  switch (options.mode) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;

    case "help":
      process.stdout.write(`${HELP}\n`);
      return;

    case "coverage": {
      // Handlers are registered before counting: without them the report would
      // always say 0/335 and read like nothing is implemented.
      const registry = createRegistry();
      registerFamilies(registry, new GatewayRuntime([]));
      const report = registry.coverage();
      process.stdout.write(`${report.implemented}/${report.total} tools implemented\n`);
      if (report.missing.length > 0) {
        process.stdout.write(`missing: ${report.missing.join(", ")}\n`);
      }
      return;
    }

    case "serve": {
      let config;
      try {
        config = loadConfig({ cli: options.overrides });
      } catch (error) {
        const message = error instanceof ConfigError ? error.message : String(error);
        process.stderr.write(`[${NAME}] configuration error: ${message}\n`);
        process.exitCode = 1;
        return;
      }

      const registry = createRegistry();

      let runtime = new GatewayRuntime([]);
      try {
        runtime = new GatewayRuntime(await resolveSystemSecrets(config), undefined, {
          timeoutMs: config.toolPolicy.timeoutMs,
        });
      } catch (error) {
        // Refusing to start would make an unreachable keychain look like a broken
        // gateway. The tools answer "no system is configured" instead, which is
        // actionable — but they still have to be registered to answer anything.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[${NAME}] credentials could not be resolved: ${message}\n`);
      }

      registerFamilies(registry, runtime);

      // `ReloadProfile` re-reads the configuration this process was started with. Installing
      // the loader here keeps the runtime free of config knowledge, and a config that no
      // longer parses leaves the working sessions untouched (the runtime loads first, swaps
      // after).
      runtime.setReloader(async () => resolveSystemSecrets(loadConfig({ cli: options.overrides })));

      const report = registry.coverage();
      process.stderr.write(`[${NAME}] ${report.implemented}/${report.total} tools implemented\n`);
      process.stderr.write(`[${NAME}] ${describeSystems(config)}\n`);

      const toolFilter = {
        layers: config.toolPolicy.layers,
        allow: config.toolPolicy.allow,
        deny: config.toolPolicy.deny,
      };
      const visible = compileToolFilter(toolFilter, (name) => {
        const meta = registry.get(name)?.meta;
        return meta === undefined ? undefined : { effect: meta.effect === "write" ? "write" : "read" };
      });
      const exposed = registry.list().filter((entry) => visible(entry.definition.name)).length;
      const facade = config.toolPolicy.gateway ? 3 : 0;
      process.stderr.write(
        exposed === report.total && facade === 0
          ? `[${NAME}] exposing all ${exposed} tools; a client that caps the tool budget will drop the rest\n`
          : `[${NAME}] exposing ${exposed + facade} of ${report.total} tools ` +
              `(layers: ${config.toolPolicy.layers.join("+") || "none"}${facade > 0 ? ", gateway tools" : ""})\n`,
      );

      await serveStdio({
        registry,
        info: {
          name: NAME,
          version: VERSION,
          systems: config.systems.map((system) => system.id),
          ...(config.defaultSystem === undefined ? {} : { defaultSystem: config.defaultSystem }),
          toolFilter,
          gateway: config.toolPolicy.gateway,
        },
      });
      return;
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${NAME} failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
