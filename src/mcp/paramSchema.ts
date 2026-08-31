import { z } from "zod";
import type { CapabilityArtifact, ParamType } from "../artifact/schema.js";

// Builds the Zod shape MCP uses both to advertise a tool's input schema to a
// connecting agent and to validate a call before it ever reaches the replay
// engine. This is a direct, mechanical translation of the artifact's own
// `inputs` contract (artifact/schema.ts) -- the MCP tool's shape is not a
// separate thing to keep in sync, it's generated from the same source of
// truth replay itself reads.

function zodForType(type: ParamType): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
  }
}

/** Every tool also accepts `approveSteps`, the MCP-native equivalent of the CLI's `--approve` flag (see replay/engine.ts `requiresConfirmation`). */
export function buildToolInputShape(artifact: CapabilityArtifact): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const input of artifact.inputs) {
    let field = zodForType(input.type).describe(input.description + (input.sensitive ? " (sensitive)" : ""));
    if (!input.required || input.default !== undefined) {
      field = field.optional();
    }
    shape[input.name] = field;
  }
  if (artifact.risk.hasIrreversibleSteps) {
    shape.approveSteps = z
      .array(z.string())
      .optional()
      .describe(
        "Step IDs to pre-approve for this call. This capability has at least one irreversible step " +
          "that is blocked by default (see the artifact's risk.requiresApproval) -- pass its stepId here " +
          "to let replay actually perform it. Omitting this returns a blocked_pending_approval result " +
          "instead of guessing that approval was implied."
      );
  }
  return shape;
}
