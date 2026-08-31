import { loadDotEnv } from "../config/env.js";
loadDotEnv();

import { chromium } from "playwright";
import { parseArgs } from "./args.js";
import { createEvidenceLogger } from "../evidence/logger.js";
import { loadArtifact } from "../artifact/store.js";
import { replayArtifact, type ReplayParams } from "../replay/engine.js";
import { pauseForHuman } from "../escalation/handoff.js";

// Demo path (see README.md). `--param name=value` (repeatable) is the primary form -- it needs no
// shell quoting for JSON, which matters because npm's Windows script runner mangles a quoted JSON
// blob passed through `npm run ... --` (confirmed while producing this repo's own /evidence; a
// direct `node dist/cli/replay.js --params '{...}'` invocation is unaffected). `--params '<json>'`
// still works as a shorthand on POSIX shells.
//   npm run replay -- --capability-id lookup-member-balance --param memberId=10001
//   npm run replay -- --capability-id lookup-member-balance --param memberId=55555   # business outcome: not found
//   npm run replay -- --capability-id open-sub-account --param memberId=10001 --param initialDeposit=250 --approve step-N

async function main() {
  const { flags, repeated } = parseArgs(process.argv.slice(2));

  const capabilityId = required(flags, "capability-id");
  const version = flags["version"] ? Number(flags["version"]) : undefined;
  const params = parseParams(flags, repeated);
  const approvedStepIds = new Set(repeated["approve"] ?? []);
  const interactive = flags["interactive"] === "true";

  const headed = process.env.HEADED === "1" || interactive;

  const artifact = loadArtifact(capabilityId, version);

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  const evidence = createEvidenceLogger("replay", capabilityId);

  console.log(`[replay] evidence -> ${evidence.dir}`);
  console.log(`[replay] capability: ${artifact.id} v${artifact.version}`);

  try {
    const result = await replayArtifact(artifact, params, {
      page,
      approvedStepIds,
      evidence,
      onStuck: interactive
        ? async (ctx) => {
            await pauseForHuman(page, evidence, { reason: ctx.reason, goalOrCapability: `${artifact.id} v${artifact.version}`, stepContext: ctx.stepId });
            return "resume";
          }
        : undefined,
    });

    console.log(JSON.stringify(result, null, 2));
    if (result.status === "success" || result.status === "business_outcome") {
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  } finally {
    await evidence.close();
    await browser.close();
  }
}

function parseParams(flags: Record<string, string>, repeated: Record<string, string[]>): ReplayParams {
  const fromFlags = repeated["param"];
  if (fromFlags && fromFlags.length > 0) {
    const params: ReplayParams = {};
    for (const entry of fromFlags) {
      const eq = entry.indexOf("=");
      if (eq === -1) {
        console.error(`--param "${entry}" is not in name=value form`);
        process.exit(2);
      }
      params[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return params;
  }
  return JSON.parse(flags["params"] ?? "{}") as ReplayParams;
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
