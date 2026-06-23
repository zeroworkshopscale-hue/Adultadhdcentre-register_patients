/**
 * Session manager.
 *
 * One authenticated OSCAR session == one isolated Playwright BrowserContext,
 * keyed by an opaque sessionId handed back to the frontend at login. OSCAR
 * credentials are used to log in and then discarded; only the live (cookie-
 * bearing) browser context is retained in memory.
 *
 *  - runExclusive() serialises all actions for a given session (one OSCAR
 *    session cannot drive two navigations at once).
 *  - Idle sessions are evicted (context closed) after config.sessionIdleMs,
 *    which is the only implicit "logout".
 */
import { randomUUID } from "node:crypto";
import { getBrowser } from "../oscar/browser.js";
import { OscarClient } from "../oscar/client.js";
import { config } from "../config.js";
import { log } from "../logger.js";

interface Session {
  id: string;
  client: OscarClient;
  username: string;
  oscarUrl: string;
  createdAt: number;
  lastUsedAt: number;
  /** Promise chain that serialises actions on this session. */
  tail: Promise<unknown>;
}

export interface LoginInput {
  oscarUrl: string;
  username: string;
  password: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private sweeper?: ReturnType<typeof setInterval>;

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000);
    // Don't keep the process alive solely for the sweeper.
    this.sweeper.unref?.();
  }

  /** Launch a context, log into OSCAR, and register the session on success. */
  async login(input: LoginInput): Promise<{ sessionId: string; username: string }> {
    const browser = await getBrowser();
    const client = new OscarClient(browser, {
      oscarUrl: input.oscarUrl,
      timeoutMs: config.oscarTimeoutMs,
    });
    await client.init();
    try {
      await client.login({ username: input.username, password: input.password });
    } catch (err) {
      await client.close();
      throw err;
    }

    const id = randomUUID();
    const now = Date.now();
    this.sessions.set(id, {
      id,
      client,
      username: input.username,
      oscarUrl: input.oscarUrl,
      createdAt: now,
      lastUsedAt: now,
      tail: Promise.resolve(),
    });
    log.info("Session created", { sessionId: id, username: input.username });
    return { sessionId: id, username: input.username };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  info(sessionId: string): { username: string; oscarUrl: string } | null {
    const s = this.sessions.get(sessionId);
    return s ? { username: s.username, oscarUrl: s.oscarUrl } : null;
  }

  /**
   * Run `fn` with exclusive access to the session's OSCAR client. Calls for the
   * same session are queued and executed one at a time.
   */
  runExclusive<T>(sessionId: string, fn: (client: OscarClient) => Promise<T>): Promise<T> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);

    const run = session.tail.then(async () => {
      session.lastUsedAt = Date.now();
      const result = await fn(session.client);
      session.lastUsedAt = Date.now();
      return result;
    });
    // Keep the chain alive regardless of individual failures.
    session.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async logout(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.client.close();
    log.info("Session closed (logout)", { sessionId });
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - config.sessionIdleMs;
    for (const [id, s] of this.sessions) {
      if (s.lastUsedAt < cutoff) {
        this.sessions.delete(id);
        await s.client.close().catch(() => undefined);
        log.info("Session evicted (idle)", { sessionId: id });
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.client.close().catch(() => undefined)));
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No active OSCAR session: ${sessionId}`);
  }
}

export const sessionManager = new SessionManager();
