// Never persist secrets or raw sensitive data into artifacts or logs (brief
// section 3.4). This is intentionally conservative: it redacts by field-name
// pattern *and* by value shape, because either signal alone misses cases
// (a well-named field with an unexpected value, or a well-formed value under
// an unhelpfully generic field name -- exactly what legacy forms produce).

const SENSITIVE_FIELD_NAME_PATTERN = /password|secret|token|ssn|social.?security|credential|apikey|api_key/i;

// Loose value-shape heuristics: SSN-like (###-##-#### or 9 digits), and
// anything that looks like a bearer/API token.
const SENSITIVE_VALUE_PATTERNS = [/^\d{3}-?\d{2}-?\d{4}$/, /^(sk|pk|bearer)[-_][A-Za-z0-9]{10,}$/i];

export function redactValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value.trim()))) {
    return "[REDACTED]";
  }
  return value;
}

/**
 * Deep-redacts an object for logging/evidence: sensitive-looking field names
 * are always redacted regardless of value; every remaining string value is
 * also checked against value-shape patterns.
 */
export function redactForLog<T>(input: T, extraSensitiveFieldNames: string[] = []): T {
  const extra = new Set(extraSensitiveFieldNames.map((s) => s.toLowerCase()));

  function walk(value: unknown, key?: string): unknown {
    if (key && (SENSITIVE_FIELD_NAME_PATTERN.test(key) || extra.has(key.toLowerCase()))) {
      return "[REDACTED]";
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    return redactValue(value);
  }

  return walk(input) as T;
}
