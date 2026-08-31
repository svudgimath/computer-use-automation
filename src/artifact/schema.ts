import { z } from "zod";

// ---------------------------------------------------------------------------
// Capability Artifact schema.
//
// This is the contract between "the model discovered how to do this" and
// "an AI agent can invoke this in production without a model in the loop."
// See REPORT.md section 2 for the design rationale. Two things drove the
// shape more than anything else:
//
//   1. Every locator carries a fallback chain, not a single selector, because
//      the only thing we can promise about a legacy surface is that a role +
//      accessible-name locator degrades better over time than a CSS path.
//   2. Steps are annotated with risk and reference input params by *name*,
//      never by literal value, so replay is parameterizable and an artifact
//      never bakes in the sensitive data it happened to run with during
//      discovery.
// ---------------------------------------------------------------------------

export const locatorStrategySchema = z.discriminatedUnion("kind", [
  // Preferred: accessibility role + accessible name. Survives markup/CSS
  // churn and is the one strategy that also has a direct analogue on desktop
  // (OS accessibility APIs use the same role/name concepts). See REPORT.md
  // section 4.
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string(), exact: z.boolean().default(false) }),
  // Fallback: visible text content of the element itself.
  z.object({ kind: z.literal("text"), text: z.string(), exact: z.boolean().default(false) }),
  // Fallback: a <label> wrapping/associated with a form control, matched by its text.
  z.object({ kind: z.literal("label"), text: z.string() }),
  // Last resort only. Recorded with fragile:true and never chosen as primary
  // by the recorder; kept as an escape hatch for elements with no accessible
  // name at all (rare, but real, in hostile legacy markup).
  z.object({ kind: z.literal("css"), selector: z.string(), fragile: z.literal(true).default(true) }),
]);
export type LocatorStrategy = z.infer<typeof locatorStrategySchema>;

export const locatorSchema = z.object({
  primary: locatorStrategySchema,
  fallbacks: z.array(locatorStrategySchema).default([]),
});
export type Locator = z.infer<typeof locatorSchema>;

export const checkpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("urlMatches"), pattern: z.string() }), // regex, matched against page URL
  z.object({ kind: z.literal("textVisible"), text: z.string() }),
  z.object({ kind: z.literal("textNotVisible"), text: z.string() }),
  z.object({ kind: z.literal("elementVisible"), locator: locatorSchema }),
]);
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const paramTypeSchema = z.enum(["string", "number", "boolean"]);
export type ParamType = z.infer<typeof paramTypeSchema>;

export const inputParamSchema = z.object({
  name: z.string(),
  type: paramTypeSchema,
  required: z.boolean().default(true),
  description: z.string(),
  // Sensitive inputs (member IDs, in a real deployment SSNs/account numbers)
  // are redacted wherever a run is logged or persisted. See safety/redaction.ts.
  sensitive: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type InputParam = z.infer<typeof inputParamSchema>;

export const outputSpecSchema = z.object({
  name: z.string(),
  type: paramTypeSchema,
  description: z.string(),
  sensitive: z.boolean().default(false),
});
export type OutputSpec = z.infer<typeof outputSpecSchema>;

// A step's "risk" governs how replay treats it. See safety/riskClassifier.ts
// for how discovery assigns this and REPORT.md section 6 for the model.
export const riskLevelSchema = z.enum(["safe", "irreversible"]);

const stepBase = {
  stepId: z.string(),
  description: z.string(), // human-readable "why" captured from the model at record time
  checkpoint: checkpointSchema.optional(),
  risk: riskLevelSchema.default("safe"),
  // Irreversible steps require an explicit confirmation gate at replay time
  // (see replay/engine.ts) regardless of what the allowlist permits.
  requiresConfirmation: z.boolean().default(false),
};

export const actionStepSchema = z.discriminatedUnion("action", [
  z.object({ ...stepBase, action: z.literal("navigate"), url: z.string() }), // may contain {{param}} templates
  z.object({ ...stepBase, action: z.literal("click"), locator: locatorSchema }),
  z.object({
    ...stepBase,
    action: z.literal("type"),
    locator: locatorSchema,
    // References an input param by name; never a literal value for sensitive fields.
    valueParam: z.string().optional(),
    literalValue: z.string().optional(),
  }),
  z.object({
    ...stepBase,
    action: z.literal("select"),
    locator: locatorSchema,
    valueParam: z.string().optional(),
    literalValue: z.string().optional(),
  }),
  z.object({
    ...stepBase,
    action: z.literal("extract"),
    locator: locatorSchema,
    outputName: z.string(),
  }),
  z.object({ ...stepBase, action: z.literal("waitFor"), timeoutMs: z.number().default(5000) }),
]);
export type ActionStep = z.infer<typeof actionStepSchema>;

// How replay classifies a runtime condition it detects mid-flow. This is the
// taxonomy the brief calls "the most common design mistake" to get wrong.
// See REPORT.md section 3.
export const errorClassificationSchema = z.enum(["business_outcome", "recoverable", "hard_failure"]);

export const errorMatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("textVisible"), text: z.string() }),
  z.object({ kind: z.literal("urlMatches"), pattern: z.string() }),
  z.object({ kind: z.literal("statusCode"), code: z.number() }),
]);

export const recoveryActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reauthenticate") }), // re-run the login sub-flow, then retry current step
  z.object({ kind: z.literal("retryStep"), maxAttempts: z.number().default(2), backoffMs: z.number().default(1000) }),
  z.object({ kind: z.literal("dismissAndContinue"), locator: locatorSchema }),
]);

export const errorHandlerSchema = z.object({
  id: z.string(),
  when: errorMatchSchema,
  classification: errorClassificationSchema,
  // For business_outcome: the named outcome surfaced to the caller (e.g. "member_not_found").
  outcomeName: z.string().optional(),
  // For recoverable: what to do before resuming the step that triggered this handler.
  recovery: recoveryActionSchema.optional(),
});
export type ErrorHandler = z.infer<typeof errorHandlerSchema>;

export const targetSchema = z.object({
  appId: z.string(), // stable id for the underlying vendor app, independent of any one tenant's base URL
  baseUrl: z.string(),
  surface: z.enum(["web"]).default("web"),
});

export const provenanceSchema = z.object({
  discoveryRunId: z.string(),
  model: z.string(),
  recordedAt: z.string(), // ISO timestamp
});

export const capabilityArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(), // stable capability id, e.g. "open-sub-account"
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  target: targetSchema,
  inputs: z.array(inputParamSchema),
  outputs: z.array(outputSpecSchema),
  steps: z.array(actionStepSchema),
  successCheckpoint: checkpointSchema,
  errorHandlers: z.array(errorHandlerSchema).default([]),
  risk: z.object({
    hasIrreversibleSteps: z.boolean(),
    requiresApproval: z.boolean(),
  }),
  provenance: provenanceSchema,
});
export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
