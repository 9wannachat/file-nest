#!/usr/bin/env node
/** FileNest MCP server over stdio. Logs go to stderr only (stdout is the protocol). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileNestClient } from "./client.js";
import { loadConfig } from "./config.js";
import { Workdir } from "./sandbox.js";
import { createServer } from "./server.js";

async function main() {
  const cfg = await loadConfig();
  for (const w of cfg.warnings) console.error(`[filenest-mcp] warning: ${w}`);
  const workdir = await Workdir.open(cfg.workdir);
  const server = createServer(new FileNestClient(cfg.url, cfg.token), workdir);
  await server.connect(new StdioServerTransport());
  console.error(`[filenest-mcp] connected to ${cfg.url}; working folder ${workdir.root}`);
}

main().catch((e) => {
  console.error(`[filenest-mcp] ${(e as Error).message}`);
  process.exit(1);
});
