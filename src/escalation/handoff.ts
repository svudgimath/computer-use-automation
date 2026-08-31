import readline from "node:readline/promises";
import type { Page } from "playwright";
import type { EvidenceLogger } from "../evidence/logger.js";
import { writeControlState, readControlState, type ControlState, type InterventionRequest } from "./controlState.js";

// Real control transfer, not a simulated one: the automation was already
// driving `page` inside a headed (visible) browser window. Handing off means
// the script simply stops issuing Playwright commands and a human takes the
// same OS-level window -- same cookies, same DOM, same in-flight session --
// and drives it directly. We never construct a second session. See
// REPORT.md section 5 for why this is the seam and what a fuller
// implementation (remote operator over CDP, rather than requiring physical
// access to the machine) would add.
//
// While control is with the human we keep passively observing: Playwright
// can still see navigation events on the page even when a human, not
// Playwright, is the one clicking (it's the same CDP session either way).
// That observation is what "capture the human's actions" means here.

export interface HandoffContext {
  reason: string;
  goalOrCapability: string;
  stepContext: string;
}

export async function pauseForHuman(page: Page, evidence: EvidenceLogger, ctx: HandoffContext): Promise<void> {
  const screenshotPath = await evidence.saveScreenshot(page, "handoff-requested");

  const intervention: InterventionRequest = {
    reason: ctx.reason,
    goalOrCapability: ctx.goalOrCapability,
    stepContext: ctx.stepContext,
    currentUrl: page.url(),
    screenshotPath,
    requestedAt: new Date().toISOString(),
  };
  const humanActions: ControlState["humanActions"] = [];
  writeControlState(evidence.dir, { owner: "human", intervention, humanActions });

  await evidence.logStep({ stepId: "(escalation)", action: "intervention_requested", ...intervention });

  console.log("\n=== HUMAN INTERVENTION REQUESTED ===");
  console.log(`Reason: ${ctx.reason}`);
  console.log(`Context: ${ctx.stepContext}`);
  console.log(`Current page: ${page.url()}`);
  console.log("The browser window is the live automation session -- interact with it directly.");
  console.log("Press ENTER in this terminal, or click Resume in the UI, to hand control back.\n");

  const onNav = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) {
      const ts = new Date().toISOString();
      humanActions.push({ ts, event: `navigated to ${frame.url()}` });
      writeControlState(evidence.dir, { owner: "human", intervention, humanActions });
    }
  };
  page.on("framenavigated", onNav);

  // Two independent resume signals, raced: a terminal keypress (the original mechanism), and an
  // external flip of control-state.json's `owner` field away from "human" -- which is what the UI's
  // Resume button does (server/resume.ts). Either is a legitimate way for a human to say "I'm done."
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const stdinResume = rl.question("").then(() => undefined).catch(() => undefined);
  let stopPolling = false;
  const externalResume = (async () => {
    while (!stopPolling) {
      await new Promise((r) => setTimeout(r, 500));
      const state = readControlState(evidence.dir);
      if (state && state.owner !== "human") return;
    }
  })();

  await Promise.race([stdinResume, externalResume]);
  stopPolling = true;
  rl.close();
  page.off("framenavigated", onNav);

  await evidence.logStep({ stepId: "(escalation)", action: "control_returned_to_agent", humanActions });
  writeControlState(evidence.dir, { owner: "agent", intervention, humanActions });
  await evidence.saveScreenshot(page, "handoff-resumed");
}
