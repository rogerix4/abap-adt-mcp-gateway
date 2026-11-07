/**
 * Where the gateway writes files a caller asked for.
 *
 * One place, because two features now need it (SmartForm rendering, and `output: "file"`
 * on the six source-reading tools) and a second copy of the same default would drift.
 * `ABAP_ADT_MCP_OUTPUT_DIR` overrides it — the agent's temp directory is not where a
 * person looks for a rendered PDF or a 5 000-line program.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

export function outputDir(): string {
  const configured = process.env["ABAP_ADT_MCP_OUTPUT_DIR"];
  return configured !== undefined && configured.trim() !== "" ? configured : join(tmpdir(), "abap-adt-mcp");
}
