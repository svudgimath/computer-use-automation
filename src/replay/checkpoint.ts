import type { Page } from "playwright";
import type { Checkpoint } from "../artifact/schema.js";
import { resolveLocator } from "./locator.js";
import { resolveTemplate } from "./template.js";
import type { ReplayParams } from "./engineTypes.js";

/**
 * A checkpoint is "a condition you assert to confirm you actually reached
 * the state you expected, rather than assuming the click worked" (brief
 * glossary). Every step and the overall run end with one of these -- replay
 * never just assumes success because an action didn't throw.
 *
 * `params` resolves `{{paramName}}` placeholders the recorder bakes into a
 * checkpoint whenever the discovered URL/text contained a literal parameter
 * value (e.g. a memberId landing in the path) -- without this, a checkpoint
 * recorded against one input would spuriously fail for every other input.
 * See agent/recorder.ts `bakeOutKnownParams`.
 */
export async function checkpointSatisfied(page: Page, checkpoint: Checkpoint, params: ReplayParams, timeoutMs = 4000): Promise<boolean> {
  switch (checkpoint.kind) {
    case "urlMatches":
      // Matched against the pathname, not the full URL: origin is already the allowlist's
      // job, and it keeps patterns portable across a tenant's base URL. See safety/allowlist.ts.
      return waitUntil(() => new RegExp(resolveTemplate(checkpoint.pattern, params)).test(new URL(page.url()).pathname), timeoutMs);
    case "textVisible":
      return waitUntil(async () => (await bodyTextContains(page, resolveTemplate(checkpoint.text, params))), timeoutMs);
    case "textNotVisible":
      return waitUntil(async () => !(await bodyTextContains(page, resolveTemplate(checkpoint.text, params))), timeoutMs);
    case "elementVisible":
      try {
        await resolveLocator(page, checkpoint.locator, timeoutMs);
        return true;
      } catch {
        return false;
      }
  }
}

/**
 * Checks for a substring of the page's rendered text -- the same
 * `innerText`-based view the discovery agent is shown (perception.ts), not
 * per-element `textContent`. That distinction matters in a table-layout app:
 * two adjacent `<td>`s have no whitespace between their `textContent`s at
 * all, so a checkpoint like "Savings Balance $2,450.00" (spanning both
 * cells, exactly as a human -- or the model -- reads it on screen) would
 * never match any single element's own text. Matching against rendered text
 * is also what makes it possible for the *model* to author a checkpoint that
 * reliably matches later, since it only ever sees rendered text, never the
 * DOM tree.
 */
export async function bodyTextContains(page: Page, needle: string): Promise<boolean> {
  const haystack = await page.evaluate(() => document.body.innerText).catch(() => "");
  return normalize(haystack).includes(normalize(needle));
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return await predicate();
}
