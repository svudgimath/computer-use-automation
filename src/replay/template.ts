import type { ReplayParams } from "./engineTypes.js";

/** Resolves `{{paramName}}` placeholders against replay params. Shared by navigate URLs and checkpoints. */
export function resolveTemplate(template: string, params: ReplayParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? ""));
}

/**
 * Resolves a navigate step's `url` against the artifact's own `target.baseUrl`. A recorded step
 * should store a *path* ("/members/search"), not a full origin -- that's what makes swapping
 * `target.baseUrl` for a different tenant's instance of the same app (see
 * artifact/tenantOverride.ts) actually retarget every navigate step, not just the metadata. `new
 * URL(path, base)` also tolerates an already-absolute `url` (an older artifact recorded before
 * this distinction existed) by returning it unchanged -- the base is simply ignored per the
 * WHATWG URL spec, so this is backward compatible, not a breaking change to the schema.
 */
export function resolveUrl(baseUrl: string, urlOrPathTemplate: string, params: ReplayParams): string {
  return new URL(resolveTemplate(urlOrPathTemplate, params), baseUrl).toString();
}
