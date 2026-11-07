/**
 * `GetObjectStructureLow` has to expand the category nodes itself.
 *
 * Measured live on DS4/100: the root call
 * (`node_id=000000`) answered `TREE_CONTENT` **empty** for `CLAS/OC CL_SALV_TABLE` and for
 * `PROG/P ZTEST_WTX3`, carrying only the category list (属性 / 方法 / 子例程 / 文本元素 …). The
 * members live one level down, under the category `NODE_ID`s, so the tool's "compact JSON tree"
 * was always empty for the two most common object types.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdtSession } from "../src/adt/session.js";
import { createRegistry } from "../src/engine/create-registry.js";
import { GatewayRuntime } from "../src/runtime.js";
import { registerReadTools } from "../src/tools/read.js";

process.env["ABAP_ADT_MCP_LOCK_JOURNAL"] = join(tmpdir(), `locks-structure-${process.pid}.json`);

const system = {
  id: "probe",
  tier: "dev",
  endpoint: { url: "https://sap.example.com:44300", client: "400", language: "ZH", systemType: "onprem" },
  auth: { type: "basic", username: "u", password: "p" },
  rfcBackend: "soap",
  env: {},
} as never;

const CATEGORY = (type: string, label: string, nodeId: string): string =>
  `<SEU_ADT_OBJECT_TYPE_INFO><OBJECT_TYPE>${type}</OBJECT_TYPE><CATEGORY_TAG>source_library</CATEGORY_TAG>` +
  `<OBJECT_TYPE_LABEL>${label}</OBJECT_TYPE_LABEL><NODE_ID>${nodeId}</NODE_ID></SEU_ADT_OBJECT_TYPE_INFO>`;

const NODE = (type: string, name: string, techName: string): string =>
  `<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>${type}</OBJECT_TYPE><OBJECT_NAME>${name}</OBJECT_NAME>` +
  `<TECH_NAME>${techName}</TECH_NAME><OBJECT_URI/><EXPANDABLE/><NODE_ID/><DESCRIPTION/></SEU_ADT_REPOSITORY_OBJ_NODE>`;

/** Root answers no nodes; each category node answers its own members. */
function structureFor(nodeId: string): string {
  const content =
    nodeId === "000014"
      ? NODE("CLAS/OM", "CLASS_CONSTRUCTOR", "CL_SALV_TABLE=================CM020") +
        NODE("CLAS/OM", "CONSTRUCTOR", "CL_SALV_TABLE=================CM001")
      : nodeId === "000062"
        ? NODE("CLAS/OL", "LCL_HELPER", "CL_SALV_TABLE=================CCIMP")
        : "";
  return (
    '<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">' +
    `<asx:values><DATA><TREE_CONTENT>${content}</TREE_CONTENT><CATEGORIES/>` +
    `<OBJECT_TYPES>${CATEGORY("CLAS/OM", "方法", "000014")}${CATEGORY("CLAS/OL", "局部类", "000062")}` +
    `${CATEGORY("CLAS/OA", "属性", "000007")}</OBJECT_TYPES></DATA></asx:values></asx:abap>`
  );
}

function harness() {
  const requests: Array<{ path: string; nodeId: string }> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({ path: url.pathname, nodeId: url.searchParams.get("node_id") ?? "" });
    const nodeId = url.searchParams.get("node_id") ?? "000000";
    return new Response(structureFor(nodeId), { status: 200, headers: { "content-type": "application/xml" } });
  }) as typeof fetch;
  const runtime = new GatewayRuntime([system], (target) =>
    new AdtSession({
      url: target.endpoint.url,
      client: target.endpoint.client,
      language: target.endpoint.language,
      username: "u",
      password: "p",
      fetchImpl,
    }),
  );
  const registry = createRegistry();
  registerReadTools(registry, runtime);
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await registry.call(tool, args, { system: "probe" } as never)) as Record<string, unknown>;
  return { call, requests };
}

describe("GetObjectStructureLow", () => {
  it("expands every category node and labels each member with its category", async () => {
    const { call, requests } = harness();
    const answer = await call("GetObjectStructureLow", {
      object_type: "CLAS/OC",
      object_name: "CL_SALV_TABLE",
    });

    expect(answer["count"]).toBe(3);
    const nodes = answer["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node["name"])).toEqual(["CLASS_CONSTRUCTOR", "CONSTRUCTOR", "LCL_HELPER"]);
    expect(nodes[0]).toMatchObject({ category: "方法", category_type: "CLAS/OM" });
    expect(nodes[2]).toMatchObject({ category: "局部类", category_type: "CLAS/OL" });
    // One root read plus one read per category — including the category that answered nothing.
    const reads = requests.filter((entry) => entry.path.endsWith("/repository/nodestructure"));
    expect(reads.map((entry) => entry.nodeId)).toEqual(["000000", "000014", "000062", "000007"]);
    const types = answer["object_types"] as Array<Record<string, unknown>>;
    expect(types.map((entry) => entry["count"])).toEqual([2, 1, 0]);
  });

  it("refuses a call without object_type / object_name", async () => {
    const { call } = harness();
    await expect(call("GetObjectStructureLow", { object_type: "CLAS/OC" })).rejects.toThrow(/object_name/);
  });
});
