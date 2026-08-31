import type { Page } from "playwright";
import type { PageObservation } from "./perception.js";
import type { AgentAction } from "./llmClient.js";
import { resolveLocator } from "../replay/locator.js";

export interface ActionExecution {
  resultSummary: string;
  extractedValue?: string;
}

export class UnknownRefError extends Error {
  constructor(ref: number) {
    super(`Model referenced ref #${ref}, which does not exist in the current observation.`);
  }
}

/**
 * Executes one model-chosen action against the live page. Every locating
 * action goes through the exact same resolveLocator() the replay engine
 * uses -- discovery and replay never diverge on "how do we find the
 * element," only on who decides *which* element to act on.
 */
export async function executeAgentAction(page: Page, observation: PageObservation, action: AgentAction): Promise<ActionExecution> {
  switch (action.tool) {
    case "click": {
      const element = requireElement(observation, action.ref);
      const locator = await resolveLocator(page, element.locator);
      await Promise.all([page.waitForLoadState("load", { timeout: 5000 }).catch(() => null), locator.click()]);
      return { resultSummary: `Clicked "${element.accessibleName || element.role}" (#${action.ref}).` };
    }
    case "type": {
      const element = requireElement(observation, action.ref);
      const locator = await resolveLocator(page, element.locator);
      await locator.fill(action.text);
      return { resultSummary: `Typed "${action.text}" into "${element.accessibleName || element.role}" (#${action.ref}).` };
    }
    case "select": {
      const element = requireElement(observation, action.ref);
      const locator = await resolveLocator(page, element.locator);
      await locator.selectOption(action.value);
      return { resultSummary: `Selected "${action.value}" in "${element.accessibleName || element.role}" (#${action.ref}).` };
    }
    case "extract": {
      const element = requireElement(observation, action.ref);
      const locator = await resolveLocator(page, element.locator);
      const value = (await locator.textContent())?.trim() ?? "";
      return { resultSummary: `Extracted "${element.accessibleName || element.role}" (#${action.ref}) -> ${action.outputName} = "${value}".`, extractedValue: value };
    }
    case "wait": {
      await page.waitForTimeout(action.ms);
      return { resultSummary: `Waited ${action.ms}ms.` };
    }
    case "finish":
    case "give_up":
      return { resultSummary: "(terminal action, no page interaction)" };
  }
}

function requireElement(observation: PageObservation, ref: number) {
  const element = observation.elements.find((e) => e.ref === ref);
  if (!element) throw new UnknownRefError(ref);
  return element;
}
