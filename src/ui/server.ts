import { loadDotEnv } from "../config/env.js";
loadDotEnv();

import express from "express";
import path from "node:path";
import fs from "node:fs";
import type { Browser } from "playwright";
import { chromium } from "playwright";

import { listArtifacts, loadArtifact, saveArtifact, nextVersion } from "../artifact/store.js";
import { replayArtifact, type ReplayParams } from "../replay/engine.js";
import { runDiscovery } from "../agent/loop.js";
import { AgentLlmClient } from "../agent/llmClient.js";
import { createEvidenceLogger } from "../evidence/logger.js";
import { communityCoreBankingErrorHandlers } from "../target-app/errorHandlers.js";
import { pauseForHuman } from "../escalation/handoff.js";
import { readControlState, writeControlState } from "../escalation/controlState.js";
import { registerRun, completeRun, failRun, listRunSummaries, readRunDetail } from "./runsRegistry.js";

// A local verification dashboard for the system in this repo -- not a
// published/hosted artifact, because it drives real Playwright browsers and
// reads the real filesystem, neither of which a sandboxed static page can
// do. Its job is to make "does this actually work" checkable by looking at
// it rather than reading JSON: trigger a replay or a discovery run, watch it
// progress, browse the resulting evidence (screenshots included), and --
// when a run escalates -- actually resume it from a button instead of a
// terminal. Every action here goes through the exact same replayArtifact /
// runDiscovery the CLI uses; this is a second caller, not a second engine.

const PORT = Number(process.env.UI_PORT ?? 4100);
const PUBLIC_DIR = path.resolve(process.cwd(), "src/ui/public");

async function main() {
  const headed = process.env.HEADED === "1";
  const browser: Browser = await chromium.launch({ headless: !headed });

  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/health", async (_req, res) => {
    const baseUrl = process.env.TARGET_BASE_URL ?? "http://localhost:4000";
    try {
      const r = await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(2000) });
      res.json({ targetAppReachable: r.status < 500, baseUrl, hasApiKey: !!process.env.ANTHROPIC_API_KEY });
    } catch {
      res.json({ targetAppReachable: false, baseUrl, hasApiKey: !!process.env.ANTHROPIC_API_KEY });
    }
  });

  app.get("/api/capabilities", (_req, res) => {
    res.json(listArtifacts());
  });

  app.get("/api/runs", (_req, res) => {
    res.json(listRunSummaries());
  });

  app.get("/api/runs/:runId", (req, res) => {
    const detail = readRunDetail(req.params.runId);
    if (!detail) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json(detail);
  });

  app.get("/api/runs/:runId/screenshots/:file", (req, res) => {
    const { runId, file } = req.params;
    if (!/^[\w.-]+$/.test(runId) || !/^[\w.-]+\.png$/.test(file)) {
      res.status(400).end();
      return;
    }
    const filePath = path.resolve(process.cwd(), "evidence", runId, "screenshots", file);
    if (!filePath.startsWith(path.resolve(process.cwd(), "evidence")) || !fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    res.sendFile(filePath);
  });

  app.post("/api/runs/:runId/resume", (req, res) => {
    const dir = path.resolve(process.cwd(), "evidence", req.params.runId);
    const state = readControlState(dir);
    if (!state || state.owner !== "human") {
      res.status(400).json({ error: "no pending intervention for this run" });
      return;
    }
    writeControlState(dir, { ...state, owner: "agent" });
    res.json({ ok: true });
  });

  app.post("/api/replay", async (req, res) => {
    const { capabilityId, params, approveSteps, interactive } = req.body as {
      capabilityId: string;
      params: ReplayParams;
      approveSteps?: string[];
      interactive?: boolean;
    };

    let artifact;
    try {
      artifact = loadArtifact(capabilityId);
    } catch (err) {
      res.status(404).json({ error: `no artifact for "${capabilityId}": ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    const evidence = createEvidenceLogger("replay", capabilityId);

    registerRun({ runId: evidence.runId, kind: "replay", capabilityId, status: "running", startedAt: new Date().toISOString(), evidenceDir: evidence.dir });
    res.json({ runId: evidence.runId });

    replayArtifact(artifact, params ?? {}, {
      page,
      evidence,
      approvedStepIds: new Set(approveSteps ?? []),
      onStuck: interactive
        ? async (ctx) => {
            await pauseForHuman(page, evidence, { reason: ctx.reason, goalOrCapability: `${artifact.id} v${artifact.version}`, stepContext: ctx.stepId });
            return "resume";
          }
        : undefined,
    })
      .then((result) => completeRun(evidence.runId, result))
      .catch((err) => failRun(evidence.runId, err instanceof Error ? err.message : String(err)))
      .finally(async () => {
        await evidence.close();
        await context.close();
      });
  });

  app.post("/api/discover", async (req, res) => {
    const { goal, capabilityId, name, description, maxSteps, interactive } = req.body as {
      goal: string;
      capabilityId: string;
      name: string;
      description: string;
      maxSteps?: number;
      interactive?: boolean;
    };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(400).json({ error: "ANTHROPIC_API_KEY is not set -- discovery needs real model access (see README.md)." });
      return;
    }
    if (!goal || !capabilityId) {
      res.status(400).json({ error: "goal and capabilityId are required" });
      return;
    }

    const baseUrl = process.env.TARGET_BASE_URL ?? "http://localhost:4000";
    const model = process.env.AGENT_MODEL ?? "claude-sonnet-5";

    const context = await browser.newContext();
    const page = await context.newPage();
    const evidence = createEvidenceLogger("discovery", capabilityId);

    registerRun({ runId: evidence.runId, kind: "discovery", capabilityId, status: "running", startedAt: new Date().toISOString(), evidenceDir: evidence.dir });
    res.json({ runId: evidence.runId });

    runDiscovery({
      goal,
      startUrl: `${baseUrl}/members/search`,
      appId: "community-core-banking",
      capabilityId,
      capabilityName: name || capabilityId,
      capabilityDescription: description || goal,
      errorHandlers: communityCoreBankingErrorHandlers,
      page,
      evidence,
      llm: new AgentLlmClient(apiKey, model),
      maxSteps: maxSteps ?? 20,
      allowEscalation: interactive ?? true,
    })
      .then((result) => {
        if (result.status === "success") {
          const version = nextVersion(capabilityId);
          saveArtifact({ ...result.artifact, version });
        }
        completeRun(evidence.runId, result);
      })
      .catch((err) => failRun(evidence.runId, err instanceof Error ? err.message : String(err)))
      .finally(async () => {
        await evidence.close();
        await context.close();
      });
  });

  app.listen(PORT, () => {
    console.log(`[ui] dashboard listening on http://localhost:${PORT}`);
  });

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
