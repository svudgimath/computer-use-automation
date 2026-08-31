import type { ErrorHandler } from "../artifact/schema.js";

// App-level error taxonomy for the Community Core Banking Console target.
// Deliberately authored by a human (not discovered per-run by the model):
// what "member not found" looks like is a property of the *vendor app*, not
// of any one capability recorded against it, so in a real deployment this is
// exactly the kind of thing that gets defined once per app/version and
// attached to every capability -- see REPORT.md section 4 (multi-tenant
// reuse). A more advanced discovery loop could propose candidate handlers
// from what it actually encountered during a run; that's a documented cut
// (REPORT.md section 7).

export const communityCoreBankingErrorHandlers: ErrorHandler[] = [
  {
    id: "member-not-found",
    when: { kind: "textVisible", text: "No member found matching ID" },
    classification: "business_outcome",
    outcomeName: "member_not_found",
  },
  {
    id: "permission-denied",
    when: { kind: "textVisible", text: "Permission denied" },
    classification: "business_outcome",
    outcomeName: "permission_denied",
  },
  {
    // Distinct from "permission-denied" above: this is the inline warning shown on a restricted
    // member's own detail page (no "Open Sub-Account" control is even rendered), vs. the dedicated
    // 403 page shown for a direct navigation attempt. Same business outcome, different surface --
    // added after a real replay run against a restricted member surfaced it as an unhandled hard
    // failure (a locator for a button that's simply not on the page). See REPORT.md section 7.
    id: "restricted-member-inline-warning",
    when: { kind: "textVisible", text: "account is restricted" },
    classification: "business_outcome",
    outcomeName: "permission_denied",
  },
  {
    id: "validation-error-deposit",
    when: { kind: "textVisible", text: "Initial deposit is required and must be a positive number" },
    classification: "business_outcome",
    outcomeName: "validation_error",
  },
  {
    id: "invalid-account-type",
    when: { kind: "textVisible", text: "Select a valid account type" },
    classification: "business_outcome",
    outcomeName: "validation_error",
  },
  {
    id: "session-expired",
    when: { kind: "textVisible", text: "Your session has expired" },
    classification: "recoverable",
    recovery: { kind: "reauthenticate" },
  },
  {
    id: "http-404-fallback",
    when: { kind: "statusCode", code: 404 },
    classification: "business_outcome",
    outcomeName: "not_found",
  },
  {
    id: "http-403-fallback",
    when: { kind: "statusCode", code: 403 },
    classification: "business_outcome",
    outcomeName: "permission_denied",
  },
];
