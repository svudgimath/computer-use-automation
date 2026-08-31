import { loadDotEnv } from "../config/env.js";
loadDotEnv();

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Demonstrates the stretch-goal "agent-facing capability interface" (brief
// section 8) actually working: spawns the MCP server as a real subprocess,
// connects as a standalone MCP client would, lists the discovered tools,
// and invokes a capability by name with typed args -- across the happy
// path, a business outcome, the irreversible-step approval gate, and the
// approved happy path. This is not a description of the interface; it's a
// real client talking real MCP to a real server, both built in this repo.
//
// Run with: npm run mcp-demo (after `npm run agent` has produced at least
// the lookup-member-balance and open-sub-account artifacts, and
// `npm run target-app` is running).

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli/mcpServer.js"],
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  });

  const client = new Client({ name: "mcp-client-demo", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Discovered ${tools.length} capability tool(s):`);
  for (const tool of tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }

  await callAndPrint(client, "lookup-member-balance", { memberId: "10001" });
  await callAndPrint(client, "lookup-member-balance", { memberId: "55555" }); // business outcome: not found

  await callAndPrint(client, "open-sub-account", { memberId: "10001", initialDeposit: 260 }); // blocked pending approval
  await callAndPrint(client, "open-sub-account", { memberId: "10002", initialDeposit: 260, approveSteps: ["step-8"] }); // approved

  await client.close();
}

async function callAndPrint(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n> ${name}(${JSON.stringify(args)})`);
  const result = await client.callTool({ name, arguments: args });
  console.log(`  isError: ${result.isError ?? false}`);
  console.log(`  ${JSON.stringify(result.structuredContent)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
