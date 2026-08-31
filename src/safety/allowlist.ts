// Explicit, configurable allowlist (brief section 3.4). The agent and the
// replay engine both consult this before *every* action -- it is not just a
// discovery-time nicety. See REPORT.md section 6 for the model and its limits.

export type ActionType = "navigate" | "click" | "type" | "select" | "extract" | "waitFor";

export interface AllowlistPolicy {
  /** Origins the automation is permitted to act against at all. */
  allowedOrigins: string[];
  /** Action types permitted in principle. Anything else is refused outright. */
  allowedActionTypes: ActionType[];
  /**
   * URL path patterns considered irreversible / high-consequence. Actions
   * whose target URL matches these are never auto-approved -- they require
   * requiresConfirmation on the step (enforced at replay) and, in the live
   * discovery loop, are only taken once, deliberately, never retried blindly.
   */
  irreversiblePathPatterns: RegExp[];
  /** Path patterns the agent must never act against, full stop. */
  blockedPathPatterns: RegExp[];
}

// A function, not a frozen constant: ESM hoists imports, so a module-level
// `process.env.TARGET_BASE_URL` read here would run before a CLI entrypoint's
// own loadDotEnv() call gets a chance to populate it. Reading it lazily, at
// first use, means it reflects whatever .env actually loaded.
let cachedDefaultPolicy: AllowlistPolicy | undefined;
export function defaultPolicy(): AllowlistPolicy {
  if (!cachedDefaultPolicy) {
    cachedDefaultPolicy = {
      allowedOrigins: [process.env.TARGET_BASE_URL ?? "http://localhost:4000"],
      allowedActionTypes: ["navigate", "click", "type", "select", "extract", "waitFor"],
      irreversiblePathPatterns: [/\/sub-account\/confirm$/],
      // Nothing is hard-blocked in this demo beyond the origin check itself; a
      // real deployment would list e.g. account-closure or funds-transfer routes
      // here if it wanted them refused outright rather than confirmation-gated.
      blockedPathPatterns: [],
    };
  }
  return cachedDefaultPolicy;
}

export interface AllowlistCheck {
  allowed: boolean;
  reason?: string;
  irreversible: boolean;
}

export function checkAction(
  policy: AllowlistPolicy,
  action: { type: ActionType; url: string }
): AllowlistCheck {
  if (!policy.allowedActionTypes.includes(action.type)) {
    return { allowed: false, reason: `action type "${action.type}" is not in the allowlist`, irreversible: false };
  }

  let origin: string;
  try {
    origin = new URL(action.url).origin;
  } catch {
    return { allowed: false, reason: `could not parse URL "${action.url}"`, irreversible: false };
  }
  if (!policy.allowedOrigins.includes(origin)) {
    return { allowed: false, reason: `origin "${origin}" is not in the allowlist`, irreversible: false };
  }

  const pathname = new URL(action.url).pathname;

  if (policy.blockedPathPatterns.some((p) => p.test(pathname))) {
    return { allowed: false, reason: `path "${pathname}" is explicitly blocked`, irreversible: false };
  }

  const irreversible = policy.irreversiblePathPatterns.some((p) => p.test(pathname));
  return { allowed: true, irreversible };
}
