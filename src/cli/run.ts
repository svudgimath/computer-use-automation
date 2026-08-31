import { loadDotEnv } from "../config/env.js";
loadDotEnv();

import { chromium } from "playwright";
import { parseArgs } from "./args.js";
import { createEvidenceLogger } from "../evidence/logger.js";
import { AgentLlmClient } from "../agent/llmClient.js";
import { runDiscovery } from "../agent/loop.js";
import { saveArtifact, nextVersion } from "../artifact/store.js";
import { communityCoreBankingErrorHandlers } from "../target-app/errorHandlers.js";
import fs from "node:fs";
import path from "node:path";

// Demo path (see README.md):
//   npm run agent -- --goal "Look up member 10001 and read their savings balance" --capability-id lookup-member-balance --name "Look up member balance" --description "Looks up a member by ID and reads their savings balance."
//   npm run agent -- --goal "Open a new Savings sub-account for member 10001 with a $250 initial deposit and reach the confirmation screen" --capability-id open-sub-account --name "Open sub-account" --description "Opens a new sub-account for a member and confirms it."

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const goal = required(flags, "goal");
  const capabilityId = required(flags, "capability-id");
  const name = flags["name"] ?? capabilityId;
  const description = flags["description"] ?? goal;
  const appId = flags["app-id"] ?? "community-core-banking";
  const baseUrl = process.env.TARGET_BASE_URL ?? "http://localhost:4000";
  const startUrl = flags["start-url"] ?? `${baseUrl}/members/search`;
  const maxSteps = Number(flags["max-steps"] ?? 20);
  const allowEscalation = flags["escalate"] === "true" || flags["escalate"] === undefined ? true : flags["escalate"] !== "false";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. The discovery run requires real model access -- see README.md.");
    process.exit(2);
  }
  const model = process.env.AGENT_MODEL ?? "claude-sonnet-5";
  const headed = process.env.HEADED === "1";

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  const evidence = createEvidenceLogger("discovery", capabilityId);
  const llm = new AgentLlmClient(apiKey, model);

  console.log(`[agent] evidence -> ${evidence.dir}`);
  console.log(`[agent] goal: ${goal}`);

  try {
    const result = await runDiscovery({
      goal,
      startUrl,
      appId,
      capabilityId,
      capabilityName: name,
      capabilityDescription: description,
      errorHandlers: communityCoreBankingErrorHandlers,
      page,
      evidence,
      llm,
      maxSteps,
      allowEscalation,
    });

    if (result.status === "success") {
      const version = nextVersion(capabilityId);
      const artifact = { ...result.artifact, version };
      const file = saveArtifact(artifact);
      fs.writeFileSync(path.join(evidence.dir, "artifact.json"), JSON.stringify(artifact, null, 2));
      console.log(`[agent] SUCCESS. Artifact saved to ${file}`);
      console.log(`[agent] Replay it with: npm run replay -- --capability-id ${capabilityId} --params '<json>'`);
    } else if (result.status === "gave_up") {
      console.error(`[agent] GAVE UP: ${result.reason}`);
      process.exitCode = 1;
    } else {
      console.error(`[agent] MAX STEPS EXCEEDED without reaching the goal.`);
      process.exitCode = 1;
    }
  } finally {
    await evidence.close();
    await browser.close();
  }
}

function required(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (!v) {
    console.error(`Missing required flag --${key}`);
    process.exit(2);
  }
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
