import type { Page, Response } from "playwright";
import type { CapabilityArtifact, ActionStep } from "../artifact/schema.js";
import { resolveLocator } from "./locator.js";
import { checkpointSatisfied } from "./checkpoint.js";
import { matchErrorHandler } from "./errorTaxonomy.js";
import { checkAction, defaultPolicy, type AllowlistPolicy } from "../safety/allowlist.js";
import { redactForLog } from "../safety/redaction.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import { resolveUrl } from "./template.js";
import type { ReplayParams } from "./engineTypes.js";

export type { ReplayParams };

export type ReplayResult =
  | { status: "success"; outputs: Record<string, unknown> }
  | { status: "business_outcome"; outcomeName: string; outputs: Record<string, unknown> }
  | { status: "blocked_pending_approval"; stepId: string; description: string }
  | { status: "failure"; stepId: string; expected: string; observed: string; message: string };

export interface ReplayOptions {
  page: Page;
  policy?: AllowlistPolicy;
  /** Set of step IDs the caller has pre-approved to actually execute (see brief 3.4: irreversible actions are handled conservatively by default). */
  approvedStepIds?: Set<string>;
  evidence?: EvidenceLogger;
  /**
   * Called when replay hits a condition it cannot recover from on its own
   * (brief 3.6: "a replay hits a condition it can't recover from"). Return
   * "resume" to let a human have taken over the same page and have the
   * engine re-check the step's checkpoint once more; "abort" to fall through
   * to the normal failure result. Omit for unattended/CI replay.
   */
  onStuck?: (ctx: { stepId: string; reason: string }) => Promise<"resume" | "abort">;
}

const sensitiveInputNames = (artifact: CapabilityArtifact) =>
  artifact.inputs.filter((i) => i.sensitive).map((i) => i.name);

/**
 * Checkpoint template context: input params plus whatever this run has extracted so far. A
 * checkpoint recorded from a run's own output (e.g. the successCheckpoint asserting the just-read
 * balance is still on screen -- see agent/recorder.ts) needs the latter to resolve at replay time.
 */
function templateContext(params: ReplayParams, outputs: Record<string, unknown>): ReplayParams {
  const ctx: ReplayParams = { ...params };
  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      ctx[key] = value;
    }
  }
  return ctx;
}

export async function replayArtifact(
  artifact: CapabilityArtifact,
  params: ReplayParams,
  opts: ReplayOptions
): Promise<ReplayResult> {
  const { page } = opts;
  const policy = opts.policy ?? defaultPolicy();

  const paramValidation = validateParams(artifact, params);
  if (paramValidation) {
    await opts.evidence?.logStep({ stepId: "(pre-flight)", action: "hard_failure", description: paramValidation });
    return { status: "failure", stepId: "(pre-flight)", expected: "valid input parameters", observed: paramValidation, message: "Input parameter validation failed before any action was taken." };
  }

  let lastStatusCode: number | undefined;
  const onResponse = (res: Response) => {
    if (res.frame() === page.mainFrame()) lastStatusCode = res.status();
  };
  page.on("response", onResponse);

  const outputs: Record<string, unknown> = {};

  try {
    for (let stepIndex = 0; stepIndex < artifact.steps.length; stepIndex++) {
      const step = artifact.steps[stepIndex];
      await opts.evidence?.logStep({
        stepId: step.stepId,
        action: step.action,
        description: step.description,
        params: redactForLog(params, sensitiveInputNames(artifact)),
      });

      const targetUrl = step.action === "navigate" ? resolveUrl(artifact.target.baseUrl, step.url, params) : page.url();
      const allowCheck = checkAction(policy, { type: step.action, url: targetUrl });
      if (!allowCheck.allowed) {
        return fail(step.stepId, "action permitted by allowlist", `blocked: ${allowCheck.reason}`, opts);
      }

      if (step.requiresConfirmation && !opts.approvedStepIds?.has(step.stepId)) {
        await opts.evidence?.logStep({ stepId: step.stepId, action: "blocked_pending_approval", description: "Irreversible step requires explicit approval before replay executes it." });
        const escalated = opts.onStuck ? await opts.onStuck({ stepId: step.stepId, reason: `Irreversible step "${step.stepId}" (${step.description}) requires explicit approval.` }) : "abort";
        if (escalated !== "resume") {
          return { status: "blocked_pending_approval", stepId: step.stepId, description: step.description };
        }
        // A human approved during the handoff; the automation still performs the action itself,
        // it just no longer needs to ask again -- fall through to execute this step normally.
      }

      let execResult: StepExecResult;
      try {
        execResult = await executeStep(page, step, params, artifact.target.baseUrl);
      } catch (err) {
        // A locator that can't be resolved, or any other action-execution error, is a hard
        // failure -- not an uncaught crash. It still goes through the same declared-handler
        // check first, since e.g. a page that redirected to an error interstitial can easily
        // make the *next* step's locator resolution fail before that step's own checkpoint
        // ever runs.
        const handled = await handleFailedCheckpoint(page, artifact, stepIndex, params, lastStatusCode, opts);
        if (handled.kind === "business_outcome") {
          await opts.evidence?.logStep({ stepId: "(final)", action: "business_outcome", outcomeName: handled.outcomeName });
          return { status: "business_outcome", outcomeName: handled.outcomeName, outputs };
        }
        if (handled.kind === "recovered") {
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        return fail(step.stepId, `action "${step.action}" to execute without error`, await pageSnapshot(page), opts, message);
      }
      if (execResult.outputName) outputs[execResult.outputName] = execResult.value;

      if (step.checkpoint) {
        const ok = await checkpointSatisfied(page, step.checkpoint, templateContext(params, outputs));
        if (!ok) {
          const handled = await handleFailedCheckpoint(page, artifact, stepIndex, params, lastStatusCode, opts);
          if (handled.kind === "business_outcome") {
            await opts.evidence?.logStep({ stepId: "(final)", action: "business_outcome", outcomeName: handled.outcomeName });
          return { status: "business_outcome", outcomeName: handled.outcomeName, outputs };
          }
          if (handled.kind === "recovered") {
            continue; // recovery already re-verified this step's checkpoint
          }
          if (opts.onStuck) {
            const escalated = await opts.onStuck({ stepId: step.stepId, reason: handled.message });
            if (escalated === "resume" && (await checkpointSatisfied(page, step.checkpoint, templateContext(params, outputs)))) {
              continue; // human resolved it live on the same session; re-verified checkpoint now holds
            }
          }
          return fail(step.stepId, describeCheckpoint(step), await pageSnapshot(page), opts, handled.message);
        }
      }
    }

    const finalOk = await checkpointSatisfied(page, artifact.successCheckpoint, templateContext(params, outputs));
    if (!finalOk) {
      return fail("(final)", describeCheckpointKind(artifact.successCheckpoint), await pageSnapshot(page), opts, "Final success checkpoint was not met after all steps completed.");
    }

    await opts.evidence?.logStep({ stepId: "(final)", action: "success", description: "Success checkpoint met.", outputs: redactForLog(outputs, artifact.outputs.filter((o) => o.sensitive).map((o) => o.name)) });
    return { status: "success", outputs };
  } finally {
    page.off("response", onResponse);
  }
}

function validateParams(artifact: CapabilityArtifact, params: ReplayParams): string | null {
  for (const input of artifact.inputs) {
    const value = params[input.name];
    if (value === undefined || value === null || value === "") {
      if (input.required && input.default === undefined) {
        return `missing required input "${input.name}"`;
      }
      continue;
    }
    if (input.type === "number" && typeof value !== "number" && Number.isNaN(Number(value))) {
      return `input "${input.name}" must be a number, got "${value}"`;
    }
  }
  return null;
}

interface StepExecResult {
  outputName?: string;
  value?: unknown;
}

async function executeStep(page: Page, step: ActionStep, params: ReplayParams, baseUrl: string): Promise<StepExecResult> {
  switch (step.action) {
    case "navigate": {
      await page.goto(resolveUrl(baseUrl, step.url, params), { waitUntil: "load" });
      return {};
    }
    case "click": {
      const locator = await resolveLocator(page, step.locator);
      await Promise.all([
        page.waitForLoadState("load", { timeout: 5000 }).catch(() => null),
        locator.click(),
      ]);
      return {};
    }
    case "type": {
      const locator = await resolveLocator(page, step.locator);
      const value = step.valueParam ? String(params[step.valueParam] ?? "") : (step.literalValue ?? "");
      await locator.fill(value);
      return {};
    }
    case "select": {
      const locator = await resolveLocator(page, step.locator);
      const value = step.valueParam ? String(params[step.valueParam] ?? "") : (step.literalValue ?? "");
      await locator.selectOption(value);
      return {};
    }
    case "extract": {
      const locator = await resolveLocator(page, step.locator);
      const text = (await locator.textContent())?.trim() ?? "";
      return { outputName: step.outputName, value: text };
    }
    case "waitFor": {
      await page.waitForTimeout(step.timeoutMs);
      return {};
    }
  }
}

type CheckpointOutcome =
  | { kind: "recovered" }
  | { kind: "business_outcome"; outcomeName: string }
  | { kind: "unhandled"; message: string };

async function handleFailedCheckpoint(
  page: Page,
  artifact: CapabilityArtifact,
  stepIndex: number,
  params: ReplayParams,
  lastStatusCode: number | undefined,
  opts: ReplayOptions
): Promise<CheckpointOutcome> {
  const step = artifact.steps[stepIndex];
  const match = await matchErrorHandler(page, artifact.errorHandlers, lastStatusCode);
  if (!match) {
    return { kind: "unhandled", message: "No declared error handler matched the observed page state." };
  }
  const { handler } = match;

  await opts.evidence?.logStep({
    stepId: step.stepId,
    action: "error_handler_matched",
    description: `Matched error handler "${handler.id}" (${handler.classification})`,
  });

  if (handler.classification === "business_outcome") {
    return { kind: "business_outcome", outcomeName: handler.outcomeName ?? handler.id };
  }

  if (handler.classification === "hard_failure") {
    return { kind: "unhandled", message: `Declared hard failure: ${handler.id}` };
  }

  // recoverable
  const recovery = handler.recovery;
  if (!recovery) return { kind: "unhandled", message: `Recoverable handler "${handler.id}" has no recovery action defined.` };

  if (recovery.kind === "reauthenticate") {
    // A session loss invalidates whatever the earlier steps had built up (a logged-in session,
    // filled-in search state, ...), so "re-authenticate" replays this capability's own steps
    // from the top rather than assuming a single retry of the current step is enough. This is
    // also why login isn't a separate credentials concept: it's just whatever steps the
    // discovery run itself needed to get logged in in the first place.
    for (let i = 0; i < stepIndex; i++) {
      await executeStep(page, artifact.steps[i], params, artifact.target.baseUrl);
    }
  } else if (recovery.kind === "dismissAndContinue") {
    const dismissLocator = await resolveLocator(page, recovery.locator);
    await dismissLocator.click();
  }

  const attempts = recovery.kind === "retryStep" ? recovery.maxAttempts : 1;
  for (let i = 0; i < attempts; i++) {
    if (recovery.kind === "retryStep" && i > 0) {
      await page.waitForTimeout(recovery.backoffMs);
    }
    await executeStep(page, step, params, artifact.target.baseUrl);
    if (step.checkpoint && (await checkpointSatisfied(page, step.checkpoint, params))) {
      return { kind: "recovered" };
    }
  }
  return { kind: "unhandled", message: `Recovery "${recovery.kind}" did not resolve the checkpoint for step "${step.stepId}".` };
}

function describeCheckpoint(step: ActionStep): string {
  return step.checkpoint ? describeCheckpointKind(step.checkpoint) : "(no checkpoint declared)";
}
function describeCheckpointKind(cp: NonNullable<ActionStep["checkpoint"]>): string {
  switch (cp.kind) {
    case "urlMatches": return `URL matches /${cp.pattern}/`;
    case "textVisible": return `text "${cp.text}" visible`;
    case "textNotVisible": return `text "${cp.text}" not visible`;
    case "elementVisible": return `element matching locator visible`;
  }
}

async function pageSnapshot(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => "(could not read page)");
  return `url=${page.url()} bodyText="${text.replace(/\s+/g, " ").trim()}"`;
}

async function fail(stepId: string, expected: string, observed: string, opts: ReplayOptions, message?: string): Promise<ReplayResult> {
  await opts.evidence?.logStep({ stepId, action: "hard_failure", description: message ?? "Unhandled failure", expected, observed });
  await opts.evidence?.saveFailureScreenshot(opts.page, stepId);
  return { status: "failure", stepId, expected, observed, message: message ?? `Step "${stepId}" failed.` };
}
