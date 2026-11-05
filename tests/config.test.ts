/**
 * Configuration tests.
 *
 * These cover the promises the docs make: layer order, merge semantics, the
 * "tier can only get stricter" rule, rejection of plain-text secrets, and a
 * readable error that names the offending layer.
 */

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config/load.ts";
import { parseJsonc, stripJsonc } from "../src/config/jsonc.ts";
import { mergeSystems, stricterTier } from "../src/config/merge.ts";
import { redactSystem, resolveSecret, resolveSystemSecrets, SecretError } from "../src/config/secrets.ts";

function files(entries: Record<string, string>) {
  const normalised = new Map(
    Object.entries(entries).map(([key, value]) => [key.replace(/\\/g, "/"), value]),
  );
  return (path: string): string | undefined => normalised.get(path.replace(/\\/g, "/"));
}

const USER_SYSTEM = {
  id: "erp-dev",
  label: "development",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: 400, language: "zh" },
  auth: { username: "env:ADT_USER", password: "keychain:abap-adt-mcp/erp-dev" },
};

const userConfig = JSON.stringify({ defaultSystem: "erp-dev", systems: [USER_SYSTEM] }, null, 2);

describe("JSONC", () => {
  it("drops line and block comments but keeps them inside strings", () => {
    const text = `{
      // a comment
      "url": "https://host/path", /* inline */
      "list": [1, 2,],
    }`;
    const parsed = parseJsonc(text, "test") as Record<string, unknown>;
    expect(parsed["url"]).toBe("https://host/path");
    expect(parsed["list"]).toEqual([1, 2]);
  });

  it("keeps a double slash that lives inside a string", () => {
    expect(stripJsonc(`{"a":"x//y"}`)).toBe(`{"a":"x//y"}`);
  });
});

describe("merge rules", () => {
  it("keeps the stricter tier whichever layer it came from", () => {
    expect(stricterTier("dev", "prd")).toBe("prd");
    expect(stricterTier("prd", "dev")).toBe("prd");
    expect(stricterTier("qa", "dev")).toBe("qa");
    expect(stricterTier(undefined, "dev")).toBe("dev");
  });

  it("merges systems by id without dropping unrelated fields", () => {
    const merged = mergeSystems(
      [{ id: "a", tier: "dev", label: "one" }],
      [{ id: "a", tier: "qa" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "a", tier: "qa", label: "one" });
  });

  it("appends systems it has not seen before", () => {
    const merged = mergeSystems([{ id: "a" }], [{ id: "b" }]);
    expect(merged.map((system) => system["id"])).toEqual(["a", "b"]);
  });
});

describe("loading layers", () => {
  const userPath = "C:/cfg/user.jsonc";
  const cwd = "C:/ws";

  it("works with no configuration at all", () => {
    const config = loadConfig({ cwd, env: {}, readFile: () => undefined, userPath });
    expect(config.systems).toEqual([]);
    expect(config.defaultSystem).toBeUndefined();
    expect(config.toolPolicy.timeoutMs).toBeGreaterThan(0);
    expect(config.toolPolicy.layers).toEqual(["readonly", "write", "low"]);
    // The three facade tools are on by default: they add reach, they hide nothing.
    expect(config.toolPolicy.gateway).toBe(true);
  });

  it("finds the configuration next to the package when the client picks another cwd", () => {
    // An MCP client spawns the server from the editor's workspace, so a config that only
    // exists in the package folder must still be found — otherwise the server reports no
    // systems and advertises the full tool list.
    const packageConfig = `${process.cwd().replace(/\\/g, "/")}/adt-mcp.config.jsonc`;
    const config = loadConfig({
      cwd,
      env: {},
      userPath,
      readFile: files({
        [packageConfig]: JSON.stringify({
          systems: [
            {
              id: "dev",
              endpoint: { url: "https://sap.example.com:44300", client: "100" },
              auth: { username: "env:ADT_USER", password: "env:ADT_PASSWORD" },
            },
          ],
        }),
      }),
    });
    expect(config.systems.map((system) => system.id)).toEqual(["dev"]);
  });

  it("fails safe: a system without a tier is treated as production", () => {
    const config = loadConfig({
      cwd,
      env: {},
      userPath,
      readFile: files({
        [userPath]: JSON.stringify({
          systems: [
            {
              id: "erp",
              endpoint: { url: "https://sap.example.com:44300", client: "400" },
              auth: { username: "env:U", password: "env:P" },
            },
          ],
        }),
      }),
    });
    expect(config.systems[0]?.tier).toBe("prd");
  });

  it("lets a workspace override one field of one system", () => {
    const config = loadConfig({
      cwd,
      env: {},
      userPath,
      readFile: files({
        [userPath]: userConfig,
        [`${cwd}/.adt-mcp/config.jsonc`]: JSON.stringify({ systems: [{ id: "erp-dev", tier: "qa" }] }),
      }),
    });
    expect(config.systems).toHaveLength(1);
    expect(config.systems[0]?.tier).toBe("qa");
    expect(config.systems[0]?.endpoint.url).toBe("https://sap.example.com:44300");
  });

  it("never lets a layer relax a tier", () => {
    const config = loadConfig({
      cwd,
      env: {},
      userPath,
      readFile: files({
        [userPath]: JSON.stringify({
          systems: [
            {
              id: "erp",
              tier: "prd",
              endpoint: { url: "https://sap.example.com:44300", client: "400" },
              auth: { username: "env:U", password: "env:P" },
            },
          ],
        }),
        [`${cwd}/.adt-mcp/config.jsonc`]: JSON.stringify({ systems: [{ id: "erp", tier: "dev" }] }),
      }),
    });
    expect(config.systems[0]?.tier).toBe("prd");
  });

  it("replaces arrays instead of concatenating them", () => {
    const config = loadConfig({
      cwd,
      env: {},
      userPath,
      readFile: files({
        [userPath]: JSON.stringify({ toolPolicy: { allow: ["Get*", "Read*"] } }),
        [`${cwd}/adt-mcp.config.jsonc`]: JSON.stringify({ toolPolicy: { allow: ["Check*"] } }),
      }),
    });
    expect(config.toolPolicy.allow).toEqual(["Check*"]);
  });

  it("names the layer and the field when a layer is invalid", () => {
    const error = (() => {
      try {
        loadConfig({
          cwd,
          env: {},
          userPath,
          readFile: files({ [userPath]: JSON.stringify({ systems: [{ id: "Bad Id" }] }) }),
        });
        return undefined;
      } catch (caught) {
        return caught as ConfigError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).toContain("user config");
    expect(error?.message).toContain("systems.0.id");
  });

  it("rejects plain-text credentials", () => {
    const error = (() => {
      try {
        loadConfig({
          cwd,
          env: {},
          userPath,
          readFile: files({
            [userPath]: JSON.stringify({
              systems: [
                {
                  id: "erp",
                  endpoint: { url: "https://sap.example.com:44300", client: "400" },
                  auth: { username: "env:U", password: "hunter2" },
                },
              ],
            }),
          }),
        });
        return undefined;
      } catch (caught) {
        return caught as ConfigError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).toMatch(/plain-text secrets are rejected/);
  });

  it("rejects a default system that is not configured", () => {
    expect(() =>
      loadConfig({
        cwd,
        env: {},
        userPath,
        readFile: files({ [userPath]: JSON.stringify({ defaultSystem: "nope" }) }),
      }),
    ).toThrow(/defaultSystem/);
  });

  it("orders environment below the command line", () => {
    const fromEnv = loadConfig({
      cwd,
      env: { ABAP_ADT_MCP_LOG_LEVEL: "debug" },
      readFile: () => undefined,
      userPath,
    });
    expect(fromEnv.server.logLevel).toBe("debug");

    const fromCli = loadConfig({
      cwd,
      env: { ABAP_ADT_MCP_LOG_LEVEL: "debug" },
      cli: { logLevel: "error" },
      readFile: () => undefined,
      userPath,
    });
    expect(fromCli.server.logLevel).toBe("error");
  });

  it("reads an explicit --config file last", () => {
    const explicit = "C:/cfg/explicit.jsonc";
    const config = loadConfig({
      cwd,
      env: { ABAP_ADT_MCP_LOG_LEVEL: "debug" },
      userPath,
      cli: { configPath: explicit },
      readFile: files({
        [userPath]: userConfig,
        [explicit]: JSON.stringify({ toolPolicy: { timeoutMs: 1234 } }),
      }),
    });
    expect(config.toolPolicy.timeoutMs).toBe(1234);
    expect(config.server.logLevel).toBe("debug");
  });

  it("keeps systems additive: an empty array does not remove them", () => {
    // Documented behaviour: systems merge by id, so dropping one requires
    // editing the layer that declares it.
    const config = loadConfig({
      cwd,
      env: {},
      userPath,
      readFile: files({
        [userPath]: userConfig,
        [`${cwd}/.adt-mcp/config.jsonc`]: JSON.stringify({ systems: [] }),
      }),
    });
    expect(config.systems).toHaveLength(1);
  });
});

describe("credentials", () => {
  it("resolves an environment reference", async () => {
    const resolved = await resolveSecret("env:ADT_PASSWORD", { env: { ADT_PASSWORD: "s3cret" } });
    expect(resolved).toEqual({ value: "s3cret", source: "env" });
  });

  it("reads the first line of a file and ignores the rest", async () => {
    const resolved = await resolveSecret("file:/secrets/dev", {
      readFile: () => "first\nsecond\n",
    });
    expect(resolved.value).toBe("first");
  });

  it("fails with an actionable message when a variable is missing", async () => {
    await expect(resolveSecret("env:NOPE", { env: {} })).rejects.toBeInstanceOf(SecretError);
    await expect(resolveSecret("env:NOPE", { env: {} })).rejects.toThrow(/not set/);
  });

  it("rejects a value that is not a reference", async () => {
    await expect(resolveSecret("hunter2", {})).rejects.toThrow(/not a reference/);
  });

  it("explains how to store a missing keychain entry", async () => {
    await expect(
      resolveSecret("keychain:svc/acct", { keychain: async () => undefined }),
    ).rejects.toThrow(/no keychain entry/);
  });

  it("names the system whose credentials failed", async () => {
    const config = loadConfig({
      cwd: "C:/ws",
      env: {},
      userPath: "C:/cfg/user.jsonc",
      readFile: files({ "C:/cfg/user.jsonc": userConfig }),
    });
    await expect(resolveSystemSecrets(config, { env: {} })).rejects.toThrow(/erp-dev/);
  });

  it("never leaks a value when redacting a system", () => {
    const redacted = JSON.stringify(
      redactSystem({
        id: "erp-dev",
        tier: "dev",
        endpoint: { url: "https://sap.example.com:44300", client: "400", language: "ZH", systemType: "onprem" },
        auth: { type: "basic", username: "env:ADT_USER", password: "keychain:svc/acct" },
        rfcBackend: "soap",
        env: {},
      }),
    );
    expect(redacted).toContain("env:***");
    expect(redacted).toContain("keychain:***");
    expect(redacted).not.toContain("ADT_USER");
  });
});
