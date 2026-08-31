import type { CapabilityArtifact, Locator } from "./schema.js";

// Multi-tenant reuse, made concrete (see REPORT.md section 4 for the design
// rationale; test/crossTenantDemo.ts for it actually running). The premise:
// hundreds of tenants run the same underlying vendor product, configured and
// branded differently. Most of a capability recorded against one tenant
// keeps working against another for free, because locators are
// role/name-based, not tied to one tenant's exact markup or data. Where a
// tenant's customization genuinely breaks a specific step -- a relabeled or
// unlabeled field, say -- the fix is a small, targeted override, not a
// re-recording of the whole capability.
//
// A TenantOverride is intentionally minimal: which base artifact it patches,
// what base URL to run against, and a small map of stepId -> replacement
// locator. It is not a fork of the artifact -- applying it produces a new
// in-memory CapabilityArtifact for this replay call; the base artifact on
// disk is untouched. A real deployment would persist overrides the same
// shape as this (base id + version, tenantId, baseUrl, per-step locator
// patches) rather than duplicating the whole artifact file per tenant.

export interface TenantOverride {
  tenantId: string;
  /** Which capability + version this override applies to. */
  baseCapabilityId: string;
  baseVersion: number;
  /** This tenant's instance of the same vendor app. */
  baseUrl: string;
  /** stepId -> replacement locator, for steps whose base locator doesn't resolve on this tenant's markup. */
  stepLocatorOverrides: Record<string, Locator>;
}

export function applyTenantOverride(artifact: CapabilityArtifact, override: TenantOverride): CapabilityArtifact {
  if (artifact.id !== override.baseCapabilityId || artifact.version !== override.baseVersion) {
    throw new Error(
      `Override targets ${override.baseCapabilityId} v${override.baseVersion}, but got ${artifact.id} v${artifact.version}.`
    );
  }
  return {
    ...artifact,
    target: { ...artifact.target, baseUrl: override.baseUrl },
    steps: artifact.steps.map((step) => {
      const replacement = override.stepLocatorOverrides[step.stepId];
      if (!replacement || !("locator" in step)) return step;
      return { ...step, locator: replacement };
    }),
  };
}
