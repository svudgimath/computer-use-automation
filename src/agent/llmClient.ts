import Anthropic from "@anthropic-ai/sdk";
import type { PageObservation } from "./perception.js";

// The discovery loop's only contact with the model. Actions are constrained
// to a small closed tool set operating on numbered refs from perception.ts --
// never raw coordinates, never free-form selectors -- so every action the
// model takes is, by construction, something the recorder can turn into a
// replayable locator. See REPORT.md section 1.

export interface ParamDeclaration {
  /** True if this value should become a reusable, caller-supplied input on replay rather than a baked-in literal. */
  isParameter: boolean;
  paramName?: string;
  paramType?: "string" | "number" | "boolean";
  paramDescription?: string;
  /** True for identifiers/PII-adjacent values (e.g. a member ID) that should be redacted in logs. */
  sensitive?: boolean;
}

export type AgentAction =
  | { tool: "click"; ref: number; reason: string }
  | ({ tool: "type"; ref: number; text: string; reason: string } & ParamDeclaration)
  | ({ tool: "select"; ref: number; value: string; reason: string } & ParamDeclaration)
  | { tool: "extract"; ref: number; outputName: string; outputType: "string" | "number" | "boolean"; sensitive: boolean; reason: string }
  | { tool: "wait"; ms: number; reason: string }
  | { tool: "finish"; outputs: Record<string, string>; summary: string; successCheckpointText: string }
  | { tool: "give_up"; reason: string };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description: "Click an interactive element identified by its numbered ref.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" }, reason: { type: "string", description: "Why this click moves toward the goal." } },
      required: ["ref", "reason"],
    },
  },
  {
    name: "type",
    description:
      "Type text into a text input or textarea identified by its numbered ref. Clears the field first. You must also declare whether this value is task-specific (a literal, e.g. free text that happens to satisfy this goal) or should become a reusable input parameter of the recorded capability (e.g. a member ID, an amount -- something a future caller would supply differently each time).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        text: { type: "string" },
        reason: { type: "string" },
        isParameter: { type: "boolean", description: "true if a future caller should be able to supply a different value here" },
        paramName: { type: "string", description: "camelCase name for the parameter, required if isParameter is true" },
        paramType: { type: "string", enum: ["string", "number", "boolean"] },
        paramDescription: { type: "string" },
        sensitive: { type: "boolean", description: "true if this value is an identifier or PII-adjacent and must be redacted in logs" },
      },
      required: ["ref", "text", "reason", "isParameter"],
    },
  },
  {
    name: "select",
    description: "Choose an option (by its value) in a <select> dropdown identified by its numbered ref. Same parameter-declaration rules as type.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        value: { type: "string" },
        reason: { type: "string" },
        isParameter: { type: "boolean" },
        paramName: { type: "string" },
        paramType: { type: "string", enum: ["string", "number", "boolean"] },
        paramDescription: { type: "string" },
        sensitive: { type: "boolean" },
      },
      required: ["ref", "value", "reason", "isParameter"],
    },
  },
  {
    name: "extract",
    description: "Record the visible text of an element identified by its numbered ref as a named output of this capability -- something a caller invoking this capability in production would want back.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        outputName: { type: "string" },
        outputType: { type: "string", enum: ["string", "number", "boolean"] },
        sensitive: { type: "boolean", description: "true if this output is sensitive financial/PII data" },
        reason: { type: "string" },
      },
      required: ["ref", "outputName", "outputType", "sensitive", "reason"],
    },
  },
  {
    name: "wait",
    description: "Wait for a short period (e.g. for a slow-loading page) before observing again.",
    input_schema: {
      type: "object",
      properties: { ms: { type: "integer" }, reason: { type: "string" } },
      required: ["ms", "reason"],
    },
  },
  {
    name: "finish",
    description: "Declare the goal accomplished. Provide any named outputs collected via extract, a one-line summary of the final state reached, and a short exact snippet of visible text on the current page that proves success -- this becomes the recorded capability's success checkpoint, so it must be text you can actually see on screen right now.",
    input_schema: {
      type: "object",
      properties: {
        outputs: { type: "object", description: "outputName -> value, for every extract() call made so far." },
        summary: { type: "string" },
        successCheckpointText: { type: "string", description: "Exact short text visible on the current page that confirms the goal was reached." },
      },
      required: ["outputs", "summary", "successCheckpointText"],
    },
  },
  {
    name: "give_up",
    description: "Declare that the goal cannot be safely or reliably accomplished from the current state, and explain why. Use this rather than guessing when stuck.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

export interface HistoryEntry {
  action: AgentAction;
  resultSummary: string;
}

export interface DecideOptions {
  goal: string;
  observation: PageObservation;
  history: HistoryEntry[];
  allowlistNote: string;
}

export class AgentLlmClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  get modelId(): string {
    return this.model;
  }

  async decide(opts: DecideOptions): Promise<{ action: AgentAction; rawText?: string }> {
    const elementsText = opts.observation.elements
      .map((e) => {
        const bits = [`#${e.ref}`, e.role, e.accessibleName ? `"${e.accessibleName}"` : "(no accessible name)"];
        if (e.inputType) bits.push(`type=${e.inputType}`);
        if (e.currentValue) bits.push(`currentValue=${JSON.stringify(e.currentValue)}`);
        return bits.join(" ");
      })
      .join("\n");

    const historyText =
      opts.history.length === 0
        ? "(none yet)"
        : opts.history.map((h, i) => `${i + 1}. ${describeAction(h.action)} -> ${h.resultSummary}`).join("\n");

    const system = `You are operating a real back-office web application on behalf of an automation system, exactly the way a trained human operator would. You can only act through the numbered refs shown to you -- you do not have raw click coordinates and must not invent selectors.

Goal: ${opts.goal}

Safety constraints: ${opts.allowlistNote}

Rules:
- Always choose exactly one tool call per turn.
- Prefer the most direct path to the goal. Do not explore irrelevant links.
- Before any step that looks irreversible (submitting a form that says "Confirm", "Open Account", etc.), make sure you are on a page that is clearly a confirmation/review step, not the entry form.
- If a page shows an error, a "not found" message, a permission-denied notice, or asks you to sign in again, treat that as real information about the task's outcome -- do not just retry the same click blindly. If you cannot proceed safely, call give_up with a clear reason rather than guessing.
- Call finish only once the goal's success condition is clearly visible on the page, with any values you were asked to read out passed as outputs (use extract first to capture them, then reference the same values in finish.outputs).
- Every time you type or select a value, decide whether it is specific to this one run (isParameter: false -- e.g. incidental text) or something a future caller of this recorded capability should be able to supply differently (isParameter: true -- e.g. a member ID, a dollar amount, an account type). Mark identifiers and financial values as sensitive so they get redacted from logs.
- Call extract for each distinct value exactly once. Do not re-extract a value you've already captured just to double-check it -- if you're confident in what you read, move on.`;

    const userText = `Step ${opts.history.length + 1}.

Current page: ${opts.observation.title} (${opts.observation.url})

Visible interactive elements (numbered to match the screenshot):
${elementsText}

Visible text on page (truncated):
${opts.observation.visibleText.slice(0, 1500)}

History so far:
${historyText}

Decide the single next action.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      tool_choice: { type: "any" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image", source: { type: "base64", media_type: "image/png", data: opts.observation.screenshotBase64 } },
          ],
        },
      ],
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) {
      throw new Error("Model did not return a tool call.");
    }
    const rawText = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    return { action: toolCallToAction(toolUse), rawText };
  }
}

function toolCallToAction(toolUse: Anthropic.ToolUseBlock): AgentAction {
  const input = toolUse.input as any;
  switch (toolUse.name) {
    case "click": return { tool: "click", ref: input.ref, reason: input.reason };
    case "type":
      return {
        tool: "type", ref: input.ref, text: input.text, reason: input.reason,
        isParameter: !!input.isParameter, paramName: input.paramName, paramType: input.paramType,
        paramDescription: input.paramDescription, sensitive: input.sensitive,
      };
    case "select":
      return {
        tool: "select", ref: input.ref, value: input.value, reason: input.reason,
        isParameter: !!input.isParameter, paramName: input.paramName, paramType: input.paramType,
        paramDescription: input.paramDescription, sensitive: input.sensitive,
      };
    case "extract":
      return { tool: "extract", ref: input.ref, outputName: input.outputName, outputType: input.outputType ?? "string", sensitive: !!input.sensitive, reason: input.reason };
    case "wait": return { tool: "wait", ms: input.ms, reason: input.reason };
    case "finish": return { tool: "finish", outputs: input.outputs ?? {}, summary: input.summary, successCheckpointText: input.successCheckpointText };
    case "give_up": return { tool: "give_up", reason: input.reason };
    default: throw new Error(`Unknown tool call: ${toolUse.name}`);
  }
}

function describeAction(a: AgentAction): string {
  switch (a.tool) {
    case "click": return `click(#${a.ref}) -- ${a.reason}`;
    case "type": return `type(#${a.ref}, "${a.text}") -- ${a.reason}`;
    case "select": return `select(#${a.ref}, "${a.value}") -- ${a.reason}`;
    case "extract": return `extract(#${a.ref} -> ${a.outputName}) -- ${a.reason}`;
    case "wait": return `wait(${a.ms}ms) -- ${a.reason}`;
    case "finish": return `finish() -- ${a.summary}`;
    case "give_up": return `give_up() -- ${a.reason}`;
  }
}
