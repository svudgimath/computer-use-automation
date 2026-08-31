import type { Page } from "playwright";
import { observePage, type PageObservation } from "./perception.js";
import { AgentLlmClient, type AgentAction, type HistoryEntry } from "./llmClient.js";
import { executeAgentAction, UnknownRefError } from "./actions.js";
import { LocatorResolutionError } from "../replay/locator.js";
import { buildArtifact, type RecordedStep } from "./recorder.js";
import { checkAction, defaultPolicy, type AllowlistPolicy } from "../safety/allowlist.js";
import { redactForLog } from "../safety/redaction.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { pauseForHuman } from "../escalation/handoff.js";
import type { CapabilityArtifact, ErrorHandler } from "../artifact/schema.js";

export interface DiscoveryOptions {
  goal: string;
  startUrl: string;
  appId: string;
  capabilityId: string;
  capabilityName: string;
  capabilityDescription: string;
  errorHandlers: ErrorHandler[];
  page: Page;
  evidence: EvidenceLogger;
  llm: AgentLlmClient;
  policy?: AllowlistPolicy;
  maxSteps?: number;
  /** If true, a "stuck" condition pauses for a human via the terminal instead of just failing the run. */
  allowEscalation?: boolean;
}

export type DiscoveryResult =
  | { status: "success"; artifact: CapabilityArtifact }
  | { status: "gave_up"; reason: string }
  | { status: "max_steps_exceeded" };

const REPEATED_FAILURE_ESCALATION_THRESHOLD = 2;

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const { page, evidence, llm } = opts;
  const policy = opts.policy ?? defaultPolicy();
  const maxSteps = opts.maxSteps ?? 20;

  await page.goto(opts.startUrl, { waitUntil: "load" });
  await evidence.logStep({ stepId: "step-0", action: "navigate", description: `Navigate to entry point`, url: opts.startUrl });
  await evidence.saveScreenshot(page, "step-0-start");

  const history: HistoryEntry[] = [];
  const recordedSteps: RecordedStep[] = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < maxSteps; i++) {
    const allowCheck = checkAction(policy, { type: "navigate", url: page.url() });
    if (!allowCheck.allowed) {
      await evidence.logStep({ stepId: `step-${i + 1}`, action: "allowlist_violation", description: allowCheck.reason ?? "" });
      if (opts.allowEscalation) {
        await pauseForHuman(page, evidence, { reason: `Allowlist violation: ${allowCheck.reason}`, goalOrCapability: opts.goal, stepContext: `after ${i} steps` });
        continue;
      }
      return { status: "gave_up", reason: `Left the allowed origin: ${allowCheck.reason}` };
    }

    const observation = await observePage(page);
    const urlBefore = page.url();

    const { action, rawText } = await llm.decide({
      goal: opts.goal,
      observation,
      history,
      allowlistNote: `Stay within ${policy.allowedOrigins.join(", ")}. Only use the actions provided.`,
    });

    await evidence.logStep({
      stepId: `step-${i + 1}`,
      action: `model:${action.tool}`,
      modelReasoning: redactForLog(rawText ?? summarizeAction(action)),
      decision: redactForLog(action),
      url: urlBefore,
    });
    await evidence.saveScreenshot(page, `step-${i + 1}-${action.tool}`);

    if (action.tool === "finish") {
      const artifact = buildArtifact({
        capabilityId: opts.capabilityId,
        version: 1,
        name: opts.capabilityName,
        description: opts.capabilityDescription,
        goal: opts.goal,
        startUrl: opts.startUrl,
        appId: opts.appId,
        baseUrl: new URL(opts.startUrl).origin,
        discoveryRunId: evidence.runId,
        model: llm.modelId,
        steps: recordedSteps,
        finish: action,
        errorHandlers: opts.errorHandlers,
      });
      await evidence.logStep({ stepId: "(final)", action: "discovery_success", summary: action.summary, outputCount: recordedSteps.filter((s) => s.action.tool === "extract").length });
      return { status: "success", artifact };
    }

    if (action.tool === "give_up") {
      await evidence.logStep({ stepId: "(final)", action: "discovery_gave_up", reason: action.reason });
      if (opts.allowEscalation) {
        await pauseForHuman(page, evidence, { reason: action.reason, goalOrCapability: opts.goal, stepContext: `model gave up after ${i} steps` });
        history.length = 0; // model's prior plan is stale once a human has intervened; let it re-orient from a fresh observation
        consecutiveFailures = 0;
        continue;
      }
      return { status: "gave_up", reason: action.reason };
    }

    try {
      const exec = await executeAgentAction(page, observation, action);
      consecutiveFailures = 0;
      recordedSteps.push({ action, element: refFor(observation, action), urlBefore, urlAfter: page.url(), extractedValue: exec.extractedValue });
      history.push({ action, resultSummary: exec.resultSummary });
    } catch (err) {
      consecutiveFailures += 1;
      const message = err instanceof UnknownRefError || err instanceof LocatorResolutionError ? err.message : String(err);
      history.push({ action, resultSummary: `FAILED: ${message}` });
      await evidence.logStep({ stepId: `step-${i + 1}`, action: "action_failed", error: message });

      if (consecutiveFailures >= REPEATED_FAILURE_ESCALATION_THRESHOLD) {
        if (opts.allowEscalation) {
          await pauseForHuman(page, evidence, { reason: `${consecutiveFailures} consecutive action failures (${message})`, goalOrCapability: opts.goal, stepContext: `step ${i + 1}` });
          history.length = 0;
          consecutiveFailures = 0;
        } else {
          return { status: "gave_up", reason: `${consecutiveFailures} consecutive action failures: ${message}` };
        }
      }
    }
  }

  await evidence.logStep({ stepId: "(final)", action: "discovery_max_steps_exceeded" });
  return { status: "max_steps_exceeded" };
}

function refFor(observation: PageObservation, action: AgentAction) {
  if (action.tool === "click" || action.tool === "type" || action.tool === "select" || action.tool === "extract") {
    return observation.elements.find((e) => e.ref === action.ref);
  }
  return undefined;
}

function summarizeAction(action: AgentAction): string {
  return `${action.tool} ${JSON.stringify(action)}`;
}
