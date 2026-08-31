import type { Page, Locator as PwLocator } from "playwright";
import type { Locator as ArtifactLocator, LocatorStrategy } from "../artifact/schema.js";

export class LocatorResolutionError extends Error {
  constructor(public triedStrategies: LocatorStrategy[]) {
    super(`Could not resolve any of ${triedStrategies.length} locator strategies to a unique visible element`);
    this.name = "LocatorResolutionError";
  }
}

function toPwLocator(page: Page, strategy: LocatorStrategy): PwLocator {
  switch (strategy.kind) {
    case "role":
      return page.getByRole(strategy.role as any, { name: strategy.name, exact: strategy.exact });
    case "text":
      return page.getByText(strategy.text, { exact: strategy.exact });
    case "label":
      return page.getByLabel(strategy.text);
    case "css":
      return page.locator(strategy.selector);
  }
}

/**
 * Resolves an artifact locator against the live page, trying the primary
 * strategy first and falling back in order. This is the one place both the
 * live agent loop and the deterministic replay engine share -- the fallback
 * chain is exactly how the system tolerates the "UI is stable but not
 * pixel-identical" reality without invoking a model. See REPORT.md section 3.
 */
export async function resolveLocator(page: Page, locator: ArtifactLocator, timeoutMs = 4000): Promise<PwLocator> {
  const strategies = [locator.primary, ...locator.fallbacks];
  const tried: LocatorStrategy[] = [];

  for (const strategy of strategies) {
    tried.push(strategy);
    const pwLocator = toPwLocator(page, strategy);
    try {
      const count = await pwLocator.count();
      if (count === 1) {
        await pwLocator.waitFor({ state: "visible", timeout: timeoutMs });
        return pwLocator;
      }
      if (count > 1) {
        // Ambiguous match. This has two very different causes that need different fixes:
        // sibling duplicates (legacy pages often repeat identical link text, e.g. "Back to
        // Search" -- DOM position disambiguates those fine, first() is right) vs. a text/role
        // match that's satisfied by both an element and one of its own ancestors (a <td>'s text
        // is, definitionally, also a substring of its <tr>'s and <table>'s text). For the
        // ancestor case, first() in document order returns the *outermost* match -- exactly
        // wrong for e.g. extracting one table cell's value. Prefer the most specific (shortest
        // own-text) match; it's correct for both cases, since a true sibling duplicate has equal
        // length and ties keep DOM/first-visible order.
        const mostSpecific = await pickMostSpecific(pwLocator, count);
        await mostSpecific.waitFor({ state: "visible", timeout: timeoutMs });
        return mostSpecific;
      }
    } catch {
      // fall through to next strategy
    }
  }

  throw new LocatorResolutionError(tried);
}

async function pickMostSpecific(pwLocator: PwLocator, count: number): Promise<PwLocator> {
  const lengths = await Promise.all(
    Array.from({ length: count }, (_, i) => pwLocator.nth(i).evaluate((el) => el.textContent?.length ?? Infinity).catch(() => Infinity))
  );
  let bestIndex = 0;
  for (let i = 1; i < lengths.length; i++) {
    if (lengths[i] < lengths[bestIndex]) bestIndex = i;
  }
  return pwLocator.nth(bestIndex);
}
