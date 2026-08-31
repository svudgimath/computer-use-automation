import { loadDotEnv } from "../config/env.js";
loadDotEnv();

import { chromium } from "playwright";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "../mcp/server.js";

// Runs the capability catalog as a stdio MCP server -- start it with
// `npm run mcp-server`, or have an MCP-speaking host (Claude Code, Claude
// Desktop, etc.) launch `node dist/cli/mcpServer.js` directly. See
// mcp/server.ts for what "one tool per saved artifact" actually means, and
// test/mcpClientDemo.ts for a client that connects and invokes one.

async function main() {
  const headed = process.env.HEADED === "1";
  const browser = await chromium.launch({ headless: !headed });

  const server = buildMcpServer(browser);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
