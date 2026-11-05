#!/usr/bin/env node
/**
 * Shows the gateway processes that are running and whether they match the build on disk.
 *
 * The server is a child of the MCP client that spawned it, so "restart" is the client's
 * job: it closes stdin (the server exits) and spawns again. When a process outlives its
 * client — a crashed window, a killed chat session — the next session can end up talking
 * to nothing while an old process still holds SAP sessions and lock handles. This prints
 * what is running, who owns it, and whether it predates the current `dist/`.
 *
 * Usage:
 *   node tools/scripts/mcp-status.mjs           list gateway processes
 *   node tools/scripts/mcp-status.mjs --kill    stop them (the client respawns on demand)
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BIN = join(ROOT, "dist", "bin.js");

let builtAt;
try {
  builtAt = statSync(BIN).mtime;
} catch {
  console.error(`mcp-status: ${BIN} is missing — run "npm run build" first`);
  process.exit(2);
}

/** Windows: CIM; elsewhere: ps. Both return pid, start time and command line. */
function listProcesses() {
  if (process.platform === "win32") {
    const script = `
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*dist\\bin.js*' } |
        ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; startedAt = $_.CreationDate.ToString('o'); command = $_.CommandLine } } |
        ConvertTo-Json -Compress
    `;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    if (out.length === 0) return [];
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: Number(entry.pid),
      parent: Number(entry.parent),
      startedAt: new Date(entry.startedAt),
      command: String(entry.command ?? ""),
    }));
  }

  const out = execFileSync("ps", ["-eo", "pid=,ppid=,lstart=,args="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line.includes("dist/bin.js"))
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
      if (match === null) return undefined;
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        startedAt: new Date(match[3]),
        command: match[4],
      };
    })
    .filter((entry) => entry !== undefined);
}

const processes = listProcesses();
if (process.argv.includes("--kill")) {
  for (const entry of processes) {
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(`killed ${entry.pid}`);
    } catch (error) {
      console.log(`could not kill ${entry.pid}: ${error.message}`);
    }
  }
  process.exit(0);
}

console.log(`build on disk: ${builtAt.toISOString()}`);
if (processes.length === 0) {
  console.log("no gateway process is running");
  console.log("the MCP client spawns one on demand: open a chat session, or restart the server in the client");
  process.exit(0);
}

for (const entry of processes) {
  const stale = entry.startedAt < builtAt;
  console.log(
    `pid ${entry.pid}  parent ${entry.parent}  started ${entry.startedAt.toISOString()}${stale ? "  STALE (older than dist/)" : ""}`,
  );
}
console.log(`${processes.length} process(es). A stale one keeps talking to the previous build; restart the client session.`);
