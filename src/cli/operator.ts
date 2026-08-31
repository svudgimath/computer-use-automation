import path from "node:path";
import { readControlState } from "../escalation/controlState.js";
import { parseArgs } from "./args.js";

// Minimal, mocked operator console (brief 3.6 scope note: "Mock the operator
// UI if needed"). The actual control transfer happens over the terminal
// running the agent/replay process (see escalation/handoff.ts) -- this
// script is the read-only surface a remote reviewer would use to see *why*
// an intervention was requested and what the live session looked like at
// that moment, without needing to be at the machine. A real operator console
// would be a web UI polling the same control-state.json (or its equivalent
// row in a shared store) and streaming the live screen; that upgrade path is
// the "clear design for the rest" the brief asks for. See REPORT.md section 5.
//
// Usage: npm run operator -- --run evidence/discovery-open-sub-account-<ts>

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const run = flags["run"];
  if (!run) {
    console.error("Usage: npm run operator -- --run <evidence-run-directory>");
    process.exit(2);
  }
  const dir = path.resolve(process.cwd(), run);
  const state = readControlState(dir);
  if (!state) {
    console.log(`No control-state.json found in ${dir} -- no intervention has been requested for this run.`);
    return;
  }

  console.log(`Owner: ${state.owner}`);
  if (state.intervention) {
    console.log("\nIntervention request:");
    console.log(`  reason:      ${state.intervention.reason}`);
    console.log(`  capability:  ${state.intervention.goalOrCapability}`);
    console.log(`  step:        ${state.intervention.stepContext}`);
    console.log(`  current URL: ${state.intervention.currentUrl}`);
    console.log(`  requested:   ${state.intervention.requestedAt}`);
    if (state.intervention.screenshotPath) console.log(`  screenshot:  ${state.intervention.screenshotPath}`);
  }
  if (state.humanActions.length > 0) {
    console.log("\nObserved human actions during handoff:");
    for (const a of state.humanActions) console.log(`  ${a.ts}  ${a.event}`);
  }
}

main();
