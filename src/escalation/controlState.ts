import fs from "node:fs";
import path from "node:path";

// Minimal, file-backed control-state record for a run. This is the seam the
// brief asks for: "there must be a way to know who is (or should be) in
// control." A real operator console would poll/subscribe to this file (or
// the equivalent row in a shared store); here it doubles as that console's
// data source. See REPORT.md section 5.

export type ControlOwner = "agent" | "human";

export interface InterventionRequest {
  reason: string;
  goalOrCapability: string;
  stepContext: string;
  currentUrl: string;
  screenshotPath?: string;
  requestedAt: string;
}

export interface ControlState {
  owner: ControlOwner;
  intervention?: InterventionRequest;
  humanActions: Array<{ ts: string; event: string }>;
}

export function controlStateFile(evidenceDir: string): string {
  return path.join(evidenceDir, "control-state.json");
}

export function writeControlState(evidenceDir: string, state: ControlState): void {
  fs.writeFileSync(controlStateFile(evidenceDir), JSON.stringify(state, null, 2), "utf-8");
}

export function readControlState(evidenceDir: string): ControlState | null {
  const file = controlStateFile(evidenceDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
