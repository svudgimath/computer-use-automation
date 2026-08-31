import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { redactForLog } from "../safety/redaction.js";

// Structured, append-only evidence for a single run (discovery or replay).
// Brief section 3.5: "a structured log of what the agent did and why, and at
// least one richer signal on failure." We log every step regardless (not
// just failures) because that's what makes a *successful* run auditable too
// -- a reviewer approving an artifact needs to see the discovery reasoning,
// not just the final outcome.

export interface EvidenceLogger {
  runId: string;
  dir: string;
  logStep(entry: Record<string, unknown>): Promise<void>;
  saveScreenshot(page: Page, label: string): Promise<string>;
  saveFailureScreenshot(page: Page, label: string): Promise<string>;
  close(): Promise<void>;
}

export function createEvidenceLogger(kind: "discovery" | "replay", capabilityId?: string, baseDir?: string): EvidenceLogger {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${kind}-${capabilityId ? capabilityId + "-" : ""}${ts}`;
  const dir = path.resolve(baseDir ?? path.resolve(process.cwd(), "evidence"), runId);
  const screenshotsDir = path.join(dir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const logFile = path.join(dir, "log.jsonl");
  const stream = fs.createWriteStream(logFile, { flags: "a" });

  let seq = 0;

  return {
    runId,
    dir,
    async logStep(entry) {
      seq += 1;
      const record = { seq, ts: new Date().toISOString(), ...redactForLog(entry) };
      stream.write(JSON.stringify(record) + "\n");
    },
    async saveScreenshot(page, label) {
      const file = path.join(screenshotsDir, `${String(seq).padStart(3, "0")}-${sanitize(label)}.png`);
      await page.screenshot({ path: file }).catch(() => undefined);
      return file;
    },
    async saveFailureScreenshot(page, label) {
      const file = path.join(screenshotsDir, `${String(seq).padStart(3, "0")}-FAILURE-${sanitize(label)}.png`);
      await page.screenshot({ path: file }).catch(() => undefined);
      return file;
    },
    async close() {
      await new Promise<void>((resolve) => stream.end(resolve));
    },
  };
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}
