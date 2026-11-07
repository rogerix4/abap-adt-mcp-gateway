import { describe, expect, it } from "vitest";

import { dataElementFamily, domainFamily, includeFamily } from "../src/families/descriptors.ts";
import { buildUpdatePayload, requestShape } from "../src/families/update/payloads.ts";
import type { AdtSession } from "../src/adt/session.ts";
import type { CreateContext } from "../src/families/types.ts";

/**
 * The three write shapes, tested where they now live.
 *
 * This is the payoff of moving them out of `handlers.update`: "does a patch read the current
 * document first" used to be observable only through a whole tool call with a scripted HTTP journal.
 */
const sessionOf = (body: string) => {
 const calls: string[] = [];
 const session = {
 requestAcceptingAny: async ({ path }: { path: string }) => {
 calls.push(path);
 return { status: 200, body };
 },
 } as unknown as AdtSession;
 return { session, calls };
};

const contextOf = (args: Record<string, unknown>) => ({
 args,
 family: dataElementFamily(),
 language: "EN",
 username: "TESTER",
 verb: "Update",
 description: "",
 }) as unknown as CreateContext;

describe("buildUpdatePayload", () => {
 it("sends the source as it is and reads nothing", async () => {
 const { session, calls } = sessionOf("");
 const payload = await buildUpdatePayload({
 family: includeFamily(),
 source: "WRITE / 'x'.",
 context: () => contextOf({}),
 session,
 objectPath: "/programs/includes/zmmr_mcp_inc",
 });
 expect(payload).toBe("WRITE / 'x'.");
 expect(calls).toEqual([]);
 });

 it("reads the current document before patching it", async () => {
 const current =
 '<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core" ' +
 'adtcore:name="ZMMR_MCP_INC" adtcore:type="DOMA/DD" adtcore:description="old">' +
 "<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype>" +
 "<doma:length>000010</doma:length></doma:typeInformation></doma:content></doma:domain>";
 const { session, calls } = sessionOf(current);
 const family = domainFamily();
 const payload = await buildUpdatePayload({
 family,
 source: undefined,
 context: () => contextOf({ properties: { length: 20 } }),
 session,
 objectPath: "/ddic/domains/zmmr_mcp_inc",
 });
 expect(calls).toEqual(["/ddic/domains/zmmr_mcp_inc"]);
 // The family's builder is covered value by value in `families.test.ts`; here the question is
 // only that the patch read the current document and built a body from it.
 expect(payload).toContain('adtcore:description="old"');
 });
});

describe("requestShape", () => {
 it("keeps a source update on the source path with text/plain", () => {
 const family = includeFamily();
 const shape = requestShape(family, "/programs/includes/zmmr_mcp_inc", "/programs/includes/zmmr_mcp_inc/source/main");
 expect(shape.target).toBe("/programs/includes/zmmr_mcp_inc/source/main");
 expect(shape.accept).toBe("text/plain");
 expect(shape.contentType).toContain("text/plain");
 });

 it("puts a document update on the object URI and accepts its own media type", () => {
 const family = {...dataElementFamily(), updateTarget: "object" as const };
 const shape = requestShape(family, "/ddic/dataelements/zmmr_mcp_inc", "/ddic/dataelements/zmmr_mcp_inc");
 expect(shape.target).toBe("/ddic/dataelements/zmmr_mcp_inc");
 expect(shape.accept).toBe(family.media.accept);
 expect(shape.contentType).toBe(family.media.accept);
 });
});
