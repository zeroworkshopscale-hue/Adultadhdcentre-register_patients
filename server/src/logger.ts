/**
 * Minimal structured logger with hard redaction of sensitive fields.
 *
 * OSCAR passwords must NEVER reach the logs. Any object key matching
 * /pass|pwd|secret|token/i is replaced with "***" before printing.
 */

const SENSITIVE = /pass|pwd|secret|token/i;

function redact(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "***" : redact(v);
  }
  return out;
}

function emit(level: "info" | "warn" | "error", msg: string, meta?: unknown) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  if (meta === undefined) {
    console[level](line);
  } else {
    console[level](line, redact(meta));
  }
}

export const log = {
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
};
