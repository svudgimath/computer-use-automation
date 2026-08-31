import { loadDotEnv } from "../config/env.js";
loadDotEnv();

import { chromium } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { loadArtifact } from "../artifact/store.js";
import { applyTenantOverride, type TenantOverride } from "../artifact/tenantOverride.js";
import { replayArtifact } from "../replay/engine.js";
import { createEvidenceLogger } from "../evidence/logger.js";
import { defaultPolicy } from "../safety/allowlist.js";

// Runs the real cross-tenant reuse demo described in REPORT.md section 4:
// the lookup-member-balance capability, recorded once against the base
// target-app (Community Core Banking Console, "tenant A"), replayed against
// a second, differently-branded, differently-populated instance of the
// same vendor product (Northgate Credit Union, "tenant B") that also has
// one deliberately hostile difference -- an unlabeled search field.
//
// Three phases, each producing real /evidence:
//   1. Unmodified base artifact against tenant B -> fails at exactly the one
//      incompatible step, not silently, proving the taxonomy holds even
//      when the *reason* for failure is "this locator doesn't exist here."
//   2. The same artifact with one targeted per-step override -> succeeds,
//      extracting a tenant-B-specific member's real balance.
//   3. The overridden artifact against a tenant-B member that doesn't exist
//      -> business_outcome, proving the *shared* error taxonomy (declared
//      once, against the base artifact) also carries over unmodified.
//
// Run with: npm run cross-tenant-demo (after `npm run agent` has produced
// artifacts/lookup-member-balance.v1.json).

const TENANT_A_URL = process.env.TARGET_BASE_URL ?? "http://localhost:4000";
const TENANT_B_URL = `http://localhost:${process.env.TENANT_B_PORT ?? 4001}`;

// The allowlist is deliberately per-run, not baked into the artifact -- a caller replaying against
// a specific tenant supplies the policy for *that* tenant. Reusing the default policy here would
// wrongly reject every action against tenant B's origin.
const tenantBPolicy = { ...defaultPolicy(), allowedOrigins: [TENANT_B_URL] };

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   ${name}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
    failed++;
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

async function main() {
  console.log("[cross-tenant-demo] starting tenant A and tenant B target apps...");
  const tenantA: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/target-app/server.ts"], { stdio: "inherit", env: process.env });
  const tenantB: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/target-app/tenantB/server.ts"], { stdio: "inherit", env: process.env });
  await Promise.all([waitForServer(`${TENANT_A_URL}/login`, 15000), waitForServer(`${TENANT_B_URL}/login`, 15000)]);

  let baseArtifact;
  try {
    baseArtifact = loadArtifact("lookup-member-balance");
  } catch (err) {
    console.error("Could not load artifacts/lookup-member-balance.v1.json -- run `npm run agent` first to record it.");
    tenantA.kill();
    tenantB.kill();
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });

  try {
    console.log(`\n[cross-tenant-demo] phase 1: unmodified base artifact (recorded against ${TENANT_A_URL}) replayed against tenant B (${TENANT_B_URL})`);
    {
      const unmodified = { ...baseArtifact, target: { ...baseArtifact.target, baseUrl: TENANT_B_URL } };
      const page = await browser.newPage();
      const evidence = createEvidenceLogger("replay", "cross-tenant-unmodified");
      const result = await replayArtifact(unmodified, { memberId: "20001" }, { page, evidence, policy: tenantBPolicy });
      await evidence.close();
      check("fails, not silently", result.status === "failure", JSON.stringify(result));
      if (result.status === "failure") {
        check("fails at the search-field step specifically", result.stepId === "step-3", `failed at ${result.stepId} instead`);
        console.log(`       (as expected: ${result.message})`);
      }
      await page.close();
    }

    console.log(`\n[cross-tenant-demo] phase 2: base artifact + one targeted override, replayed against tenant B`);
    const override: TenantOverride = {
      tenantId: "northgate",
      baseCapabilityId: baseArtifact.id,
      baseVersion: baseArtifact.version,
      baseUrl: TENANT_B_URL,
      stepLocatorOverrides: {
        "step-3": {
          // The field has no accessible name on this tenant's markup at all (see
          // target-app/tenantB/server.ts) -- role/name locators have nothing to match. The HTML
          // `name` attribute is the one thing that has to stay stable regardless of branding,
          // since the same backend form handler depends on it too.
          primary: { kind: "css", selector: "input[name=memberId]", fragile: true },
          fallbacks: [],
        },
      },
    };
    const overridden = applyTenantOverride(baseArtifact, override);
    {
      const page = await browser.newPage();
      const evidence = createEvidenceLogger("replay", "cross-tenant-overridden");
      const result = await replayArtifact(overridden, { memberId: "20001" }, { page, evidence, policy: tenantBPolicy });
      await evidence.close();
      check("succeeds with the override", result.status === "success", JSON.stringify(result));
      if (result.status === "success") {
        check("extracts tenant B's own data (Priya Natarajan's balance)", result.outputs.savingsBalance === "$3,612.00", String(result.outputs.savingsBalance));
      }
      await page.close();
    }

    console.log(`\n[cross-tenant-demo] phase 3: overridden artifact, tenant-B member that doesn't exist -- proves the shared error taxonomy carries over too`);
    {
      const page = await browser.newPage();
      const evidence = createEvidenceLogger("replay", "cross-tenant-notfound");
      const result = await replayArtifact(overridden, { memberId: "99999" }, { page, evidence, policy: tenantBPolicy });
      await evidence.close();
      check("business_outcome, not a crash or a hard failure", result.status === "business_outcome", JSON.stringify(result));
      if (result.status === "business_outcome") {
        check("outcomeName is member_not_found (declared once, against the base artifact)", result.outcomeName === "member_not_found", result.outcomeName);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    tenantA.kill();
    tenantB.kill();
  }

  console.log(`\n[cross-tenant-demo] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
