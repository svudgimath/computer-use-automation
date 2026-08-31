import fs from "node:fs";
import path from "node:path";
import { capabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

const ARTIFACT_DIR = path.resolve(process.cwd(), "artifacts");

function artifactPath(id: string, version: number): string {
  return path.join(ARTIFACT_DIR, `${id}.v${version}.json`);
}

export function saveArtifact(artifact: CapabilityArtifact): string {
  capabilityArtifactSchema.parse(artifact); // fail fast on a malformed artifact rather than write garbage
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = artifactPath(artifact.id, artifact.version);
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2), "utf-8");
  return file;
}

export function loadArtifact(id: string, version?: number): CapabilityArtifact {
  const file = version !== undefined ? artifactPath(id, version) : latestArtifactFile(id);
  const raw = fs.readFileSync(file, "utf-8");
  return capabilityArtifactSchema.parse(JSON.parse(raw));
}

export function loadArtifactFromFile(file: string): CapabilityArtifact {
  const raw = fs.readFileSync(file, "utf-8");
  return capabilityArtifactSchema.parse(JSON.parse(raw));
}

function latestArtifactFile(id: string): string {
  if (!fs.existsSync(ARTIFACT_DIR)) {
    throw new Error(`No artifacts directory at ${ARTIFACT_DIR}`);
  }
  const versions = fs
    .readdirSync(ARTIFACT_DIR)
    .filter((f) => f.startsWith(`${id}.v`) && f.endsWith(".json"))
    .map((f) => {
      const m = f.match(/\.v(\d+)\.json$/);
      return { file: f, version: m ? Number(m[1]) : 0 };
    })
    .sort((a, b) => b.version - a.version);
  if (versions.length === 0) {
    throw new Error(`No artifact found for id "${id}" in ${ARTIFACT_DIR}`);
  }
  return path.join(ARTIFACT_DIR, versions[0].file);
}

/**
 * The latest version of every distinct capability id in the store. This is the catalog an
 * agent-facing interface (see mcp/server.ts) discovers tools from -- one entry per capability,
 * always the newest recorded/approved version.
 */
export function listArtifacts(): CapabilityArtifact[] {
  if (!fs.existsSync(ARTIFACT_DIR)) return [];
  const ids = new Set(
    fs
      .readdirSync(ARTIFACT_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.v\d+\.json$/, ""))
  );
  return [...ids].map((id) => loadArtifact(id)).sort((a, b) => a.id.localeCompare(b.id));
}

export function nextVersion(id: string): number {
  if (!fs.existsSync(ARTIFACT_DIR)) return 1;
  const versions = fs
    .readdirSync(ARTIFACT_DIR)
    .filter((f) => f.startsWith(`${id}.v`) && f.endsWith(".json"))
    .map((f) => Number(f.match(/\.v(\d+)\.json$/)?.[1] ?? 0));
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}
