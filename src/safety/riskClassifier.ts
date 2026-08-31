// Classifies a candidate action as safe/reversible vs. irreversible, at
// discovery time, so the recorded artifact carries the right risk flag on
// each step without relying on the model to self-report it (an LLM asked
// "is this risky?" is exactly the kind of judgment call we don't want to
// trust blindly -- see REPORT.md section 6).
//
// This is deliberately conservative and pattern-based rather than semantic:
// a false positive (flagging something safe as irreversible) costs an extra
// confirmation prompt; a false negative lets a real irreversible action
// through unguarded. We bias toward false positives.

const IRREVERSIBLE_TEXT_PATTERNS = [
  /confirm/i,
  /submit/i,
  /open (a |an )?(new )?account/i,
  /transfer/i,
  /delete/i,
  /close account/i,
  /withdraw/i,
];

export function isLikelyIrreversible(opts: { url?: string; buttonText?: string; httpMethod?: "GET" | "POST" }): "safe" | "irreversible" {
  if (opts.httpMethod === "POST") {
    // Every POST in this app either validates-and-redisplays (safe to retry)
    // or is the final confirm step. We can't tell purely from method, so
    // fall through to text/URL heuristics, but POST alone nudges toward
    // caution over silence.
  }
  if (opts.buttonText && IRREVERSIBLE_TEXT_PATTERNS.some((p) => p.test(opts.buttonText!))) {
    return "irreversible";
  }
  if (opts.url && /\/confirm(\/|$)/.test(new URL(opts.url, "http://placeholder").pathname)) {
    return "irreversible";
  }
  return "safe";
}
