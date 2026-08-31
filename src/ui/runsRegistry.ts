import fs from "node:fs";
import path from "node:path";
import type { DiscoveryResult } from "../agent/loop.js";
import type { ReplayResult } from "../replay/engine.js";
import { readControlState, type ControlState } from "../escalation/controlState.js";

// In-memory record of runs kicked off *by this UI server process*, so the
// dashboard can poll a run started a second ago without re-parsing its
// (possibly still-growing) evidence log from scratch. Historical runs from
// disk (started by the CLI, or by a previous server process) are merged in
// separately by scanEvidenceDir below -- the registry is a cache, not the
// source of truth; the evidence directory always is.

export type RunStatus = "running" | "done" | "error";

export interface RunRecord {
  runId: string;
  kind: "discovery" | "replay";
  capabilityId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  result?: DiscoveryResult | ReplayResult;
  errorMessage?: string;
  evidenceDir: string;
}

const registry = new Map<string, RunRecord>();

export function registerRun(record: RunRecord): void {
  registry.set(record.runId, record);
}

export function completeRun(runId: string, result: DiscoveryResult | ReplayResult): void {
  const r = registry.get(runId);
  if (!r) return;
  r.status = "done";
  r.result = result;
  r.finishedAt = new Date().toISOString();
}

export function failRun(runId: string, errorMessage: string): void {
  const r = registry.get(runId);
  if (!r) return;
  r.status = "error";
  r.errorMessage = errorMessage;
  r.finishedAt = new Date().toISOString();
}

export function getRun(runId: string): RunRecord | undefined {
  return registry.get(runId);
}

export interface LogEntry {
  seq: number;
  ts: string;
  stepId?: string;
  action?: string;
  [key: string]: unknown;
}

export interface RunDetail {
  runId: string;
  kind: "discovery" | "replay";
  capabilityId: string;
  status: RunStatus;
  /** The actual DiscoveryResult/ReplayResult once available -- from the in-memory registry when this server process ran the run, otherwise reconstructed from the log's terminal entry (e.g. after a server restart). */
  result: (DiscoveryResult | ReplayResult | { status: string; [key: string]: unknown }) | null;
  errorMessage?: string;
  log: LogEntry[];
  controlState: ControlState | null;
  screenshots: string[];
}

const EVIDENCE_DIR = path.resolve(process.cwd(), "evidence");

/** Parses a run's evidence directory fresh off disk -- the log may still be growing for an in-progress run. */
export function readRunDetail(runId: string): RunDetail | null {
  const dir = path.join(EVIDENCE_DIR, runId);
  if (!fs.existsSync(dir)) return null;

  const { kind, capabilityId } = parseRunId(runId);
  const log = readLog(dir);
  const controlState = readControlState(dir);
  const screenshotsDir = path.join(dir, "screenshots");
  const screenshots = fs.existsSync(screenshotsDir) ? fs.readdirSync(screenshotsDir).sort() : [];

  const inMemory = registry.get(runId);
  const status = inMemory?.status ?? inferStatusFromLog(kind, log);

  const result = inMemory?.result ?? (status === "done" ? reconstructResultFromLog(kind, log) : null);

  return { runId, kind, capabilityId, status, result, errorMessage: inMemory?.errorMessage, log, controlState, screenshots };
}

/** Best-effort reconstruction of the terminal result from the log alone -- used when this server process didn't run the job itself (e.g. after a restart), so there's no in-memory record to read from directly. */
function reconstructResultFromLog(kind: "discovery" | "replay", log: LogEntry[]): RunDetail["result"] {
  const terminal = [...log].reverse().find((e) => typeof e.action === "string" && e.action !== "unparseable_log_line");
  if (!terminal) return null;

  if (kind === "discovery") {
    if (terminal.action === "discovery_success") return { status: "success" };
    if (terminal.action === "discovery_gave_up") return { status: "gave_up", reason: terminal.reason };
    if (terminal.action === "discovery_max_steps_exceeded") return { status: "max_steps_exceeded" };
    return null;
  }

  if (terminal.action === "success") return { status: "success", outputs: terminal.outputs };
  if (terminal.action === "business_outcome") return { status: "business_outcome", outcomeName: terminal.outcomeName };
  if (terminal.action === "blocked_pending_approval") return { status: "blocked_pending_approval", stepId: terminal.stepId, description: terminal.description };
  if (terminal.action === "hard_failure") return { status: "failure", stepId: terminal.stepId, expected: terminal.expected, observed: terminal.observed, message: terminal.description };
  return null;
}

/** Lists every run directory on disk (discovery or replay), newest first, with a lightweight status inferred from the log tail -- for the dashboard's run list, which shouldn't have to fetch every full log to render. */
export function listRunSummaries(): Array<Pick<RunDetail, "runId" | "kind" | "capabilityId" | "status"> & { startedAt: string }> {
  if (!fs.existsSync(EVIDENCE_DIR)) return [];
  return fs
    .readdirSync(EVIDENCE_DIR)
    .filter((name) => fs.statSync(path.join(EVIDENCE_DIR, name)).isDirectory())
    .map((runId) => {
      const { kind, capabilityId } = parseRunId(runId);
      const inMemory = registry.get(runId);
      const status = inMemory?.status ?? inferStatusFromLog(kind, readLog(path.join(EVIDENCE_DIR, runId)));
      const startedAt = inMemory?.startedAt ?? runIdToTimestamp(runId);
      return { runId, kind, capabilityId, status, startedAt };
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function parseRunId(runId: string): { kind: "discovery" | "replay"; capabilityId: string } {
  const kind = runId.startsWith("discovery-") ? "discovery" : "replay";
  const rest = runId.slice(kind.length + 1);
  // rest is "<capabilityId>-<ISO-timestamp-with-dashes>"; the timestamp is always the trailing
  // `YYYY-MM-DDTHH-mm-ss-sssZ` chunk appended by evidence/logger.ts, so strip that back off.
  const capabilityId = rest.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, "");
  return { kind, capabilityId };
}

/**
 * The raw `YYYY-MM-DDTHH-mm-ss-sssZ` suffix evidence/logger.ts appends to every runId (colons and
 * the dot swapped for dashes so it's filesystem-safe). Not reparsed into a real Date -- string
 * comparison already sorts it correctly since every run uses the same fixed-width format, and the
 * raw form is what's actually on disk if a reader wants to go look.
 */
function runIdToTimestamp(runId: string): string {
  return runId.match(/\d{4}-\d{2}-\d{2}T[\d-]+Z$/)?.[0] ?? "";
}

function readLog(dir: string): LogEntry[] {
  const file = path.join(dir, "log.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return { seq: -1, ts: "", action: "unparseable_log_line" };
      }
    });
}

/**
 * Only ever called as a fallback when there's no in-memory record for this runId -- which means
 * this server process did not start it (a previous process did, or it's from the CLI). Such a run
 * can never legitimately be "running" from this process's point of view: nothing here is going to
 * make further progress on it, or ever call completeRun()/failRun() for it. Defaulting to
 * "running" when no recognized terminal marker is found (an early log format, say) would leave a
 * run stuck showing as in-progress forever; "done" is always the safer default for a foreign log.
 */
function inferStatusFromLog(_kind: "discovery" | "replay", _log: LogEntry[]): RunStatus {
  return "done";
}
