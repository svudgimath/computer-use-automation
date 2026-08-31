import type { Page } from "playwright";
import type { ErrorHandler } from "../artifact/schema.js";
import { bodyTextContains } from "./checkpoint.js";

export interface ErrorMatchResult {
  handler: ErrorHandler;
}

/**
 * Checks the current page state against an artifact's declared error
 * handlers, in order, and returns the first match. This is the enforcement
 * point for the taxonomy the brief singles out as the crux of the problem:
 * "no such member" is a legitimate business outcome, a dismissable
 * interstitial is recoverable, and anything undeclared is a hard failure by
 * default (see replay/engine.ts) -- we never guess our way past an
 * unrecognized state.
 */
export async function matchErrorHandler(
  page: Page,
  handlers: ErrorHandler[],
  lastStatusCode?: number
): Promise<ErrorMatchResult | null> {
  for (const handler of handlers) {
    const when = handler.when;
    let matched = false;
    if (when.kind === "textVisible") {
      matched = await bodyTextContains(page, when.text);
    } else if (when.kind === "urlMatches") {
      matched = new RegExp(when.pattern).test(new URL(page.url()).pathname);
    } else if (when.kind === "statusCode") {
      matched = lastStatusCode === when.code;
    }
    if (matched) return { handler };
  }
  return null;
}
