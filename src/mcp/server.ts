import type { Browser } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listArtifacts } from "../artifact/store.js";
import { replayArtifact, type ReplayParams } from "../replay/engine.js";
import { createEvidenceLogger } from "../evidence/logger.js";
import { buildToolInputShape } from "./paramSchema.js";

// The brief's "agent-invocable capability" framing (section 2/3.2) made
// literal: every saved artifact becomes one MCP tool, discoverable and
// callable by name with typed args by any MCP-speaking agent -- not just
// this repo's own CLI. The tool's input schema is generated from the same
// `CapabilityArtifact.inputs` the replay engine itself validates against
// (mcp/paramSchema.ts), so there's no second contract to keep in sync.
//
// Each call replays deterministically through the exact same
// `replayArtifact` the CLI uses -- an MCP tool call is just another caller
// of that function, not a parallel execution path.

export function buildMcpServer(browser: Browser): McpServer {
  const server = new McpServer({ name: "computer-use-automation-system", version: "0.1.0" });

  const artifacts = listArtifacts();
  for (const artifact of artifacts) {
    const inputShape = buildToolInputShape(artifact);

    server.registerTool(
      artifact.id,
      {
        title: artifact.name,
        description:
          `${artifact.description} (target: ${artifact.target.appId}, v${artifact.version})` +
          (artifact.risk.hasIrreversibleSteps
            ? " -- contains an irreversible step; the call is blocked pending approval unless you pass approveSteps."
            : ""),
        inputSchema: inputShape,
      },
      async (args): Promise<CallToolResult> => {
        const { approveSteps, ...rest } = args as Record<string, unknown> & { approveSteps?: string[] };
        const params = rest as ReplayParams;

        const context = await browser.newContext();
        const page = await context.newPage();
        const evidence = createEvidenceLogger("replay", artifact.id);

        try {
          const result = await replayArtifact(artifact, params, {
            page,
            evidence,
            approvedStepIds: new Set(approveSteps ?? []),
          });

          // success and business_outcome are both legitimate completions of the call (the whole
          // point of the taxonomy in replay/errorTaxonomy.ts is that "no such member" is not a
          // crash) -- only blocked_pending_approval and failure are reported as tool errors, since
          // those are cases the calling agent actually needs to react to, not just relay.
          const isError = result.status === "blocked_pending_approval" || result.status === "failure";
          return {
            isError,
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          };
        } finally {
          await evidence.close();
          await context.close();
        }
      }
    );
  }

  return server;
}
