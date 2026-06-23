import "dotenv/config";

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: int(process.env.PORT, 8787),
  /** Allowed browser origins. Empty => reflect any origin (dev only). */
  corsOrigins: list(process.env.CORS_ORIGINS),
  headless: bool(process.env.PLAYWRIGHT_HEADLESS, true),
  /** "chromium" (bundled) or "chrome" (system Google Chrome). */
  browserChannel: (process.env.BROWSER_CHANNEL ?? "chromium").trim().toLowerCase(),
  sessionIdleMs: int(process.env.SESSION_IDLE_MINUTES, 20) * 60_000,
  oscarTimeoutMs: int(process.env.OSCAR_TIMEOUT_MS, 30_000),
} as const;

export type AppConfig = typeof config;
