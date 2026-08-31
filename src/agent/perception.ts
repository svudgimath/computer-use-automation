import type { Page } from "playwright";
import type { Locator as ArtifactLocator, LocatorStrategy } from "../artifact/schema.js";

// "Set-of-marks" perception: every visible interactive element gets a
// numbered ref, a best-effort accessible role/name, and a CSS fallback. The
// LLM only ever sees refs (never raw coordinates or CSS) -- which means the
// *same* structure the model reasons over is exactly what gets baked into
// the recorded artifact's locator. There is no separate "translate the
// model's intent into a selector" step to get subtly wrong later.
//
// This is also the seam called out in REPORT.md section 4: swapping this
// module for one that reads the OS accessibility tree instead of the DOM is
// the entire cost of porting to a desktop surface -- everything downstream
// (agent loop, artifact schema, replay engine) is unchanged.

export interface MarkedElement {
  ref: number;
  role: string;
  accessibleName: string;
  tag: string;
  inputType?: string;
  currentValue?: string;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  locator: ArtifactLocator;
}

export interface PageObservation {
  url: string;
  title: string;
  visibleText: string; // trimmed body text, for the model's situational awareness
  elements: MarkedElement[];
  screenshotBase64: string; // annotated with ref numbers
}

// Interactive controls the model can act on, plus table cells so it can also
// *extract* data that lives in plain markup (a balance, an account number) --
// not everything worth reading back is behind a control. Table cells get
// role "cell" for free from the HTML-ARIA mapping, so the same role+name
// locator strategy covers both without a separate extraction mechanism.
const INTERACTIVE_SELECTOR = "a[href], button, input, select, textarea, td";

export async function observePage(page: Page): Promise<PageObservation> {
  const raw = await page.evaluate((sel) => {
    function accessibleName(el: Element): string {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();

      if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
        // Wrapping <label> is the pattern this app uses (label text + input, no `for`/`id`).
        const label = el.closest("label");
        if (label) {
          const clone = label.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
          const text = clone.textContent?.trim();
          if (text) return text;
        }
        if (el.tagName === "INPUT") {
          const input = el as HTMLInputElement;
          if (input.type === "submit" || input.type === "button") return input.value || "";
        }
      }
      const text = el.textContent?.trim();
      return text ?? "";
    }

    function roleOf(el: Element): string {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "td") return "cell";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        if (type === "submit" || type === "button") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "password") return "textbox";
        return "textbox";
      }
      return tag;
    }

    function cssPath(el: Element): string {
      // nth-of-type chain from body -- deliberately last-resort and marked
      // fragile in the artifact; only used when role+name is empty.
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "body") {
        const parent: Element | null = node.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === node!.tagName);
        const idx = siblings.indexOf(node) + 1;
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${idx})`);
        node = parent;
      }
      return "body > " + parts.join(" > ");
    }

    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
        if (!visible) return null;
        const htmlEl = el as HTMLInputElement;
        return {
          role: roleOf(el),
          accessibleName: accessibleName(el),
          tag: el.tagName.toLowerCase(),
          inputType: el.tagName === "INPUT" ? htmlEl.type : undefined,
          currentValue: "value" in el ? String((el as HTMLInputElement).value ?? "") : undefined,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          cssPath: cssPath(el),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, INTERACTIVE_SELECTOR);

  const elements: MarkedElement[] = raw.map((r, i) => {
    const ref = i + 1;
    const strategies: LocatorStrategy[] = [];
    if (r.accessibleName) {
      strategies.push({ kind: "role", role: r.role, name: r.accessibleName, exact: false });
      strategies.push({ kind: "text", text: r.accessibleName, exact: false });
    }
    strategies.push({ kind: "css", selector: r.cssPath, fragile: true });

    const locator: ArtifactLocator = {
      primary: strategies[0],
      fallbacks: strategies.slice(1),
    };

    return {
      ref,
      role: r.role,
      accessibleName: r.accessibleName,
      tag: r.tag,
      inputType: r.inputType,
      currentValue: r.currentValue,
      boundingBox: r.boundingBox,
      locator,
    };
  });

  const screenshotBase64 = await annotatedScreenshot(page, elements);
  const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 4000));

  return {
    url: page.url(),
    title: await page.title(),
    visibleText,
    elements,
    screenshotBase64,
  };
}

async function annotatedScreenshot(page: Page, elements: MarkedElement[]): Promise<string> {
  await page.evaluate((els) => {
    const overlay = document.createElement("div");
    overlay.id = "__agent_overlay__";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "2147483647";
    for (const el of els) {
      if (!el.boundingBox) continue;
      const badge = document.createElement("div");
      badge.textContent = String(el.ref);
      badge.style.position = "fixed";
      badge.style.left = `${el.boundingBox.x}px`;
      badge.style.top = `${Math.max(0, el.boundingBox.y - 14)}px`;
      badge.style.background = "#ff3b30";
      badge.style.color = "#fff";
      badge.style.fontSize = "10px";
      badge.style.fontFamily = "monospace";
      badge.style.padding = "1px 3px";
      badge.style.borderRadius = "2px";
      badge.style.lineHeight = "1";
      overlay.appendChild(badge);

      const box = document.createElement("div");
      box.style.position = "fixed";
      box.style.left = `${el.boundingBox.x}px`;
      box.style.top = `${el.boundingBox.y}px`;
      box.style.width = `${el.boundingBox.width}px`;
      box.style.height = `${el.boundingBox.height}px`;
      box.style.outline = "1px solid #ff3b30";
      overlay.appendChild(box);
    }
    document.body.appendChild(overlay);
  }, elements);

  const buffer = await page.screenshot({ type: "png" });

  await page.evaluate(() => {
    document.getElementById("__agent_overlay__")?.remove();
  });

  return buffer.toString("base64");
}
