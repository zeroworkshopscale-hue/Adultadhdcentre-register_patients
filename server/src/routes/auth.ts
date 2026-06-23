/**
 * OSCAR authentication routes.
 *
 * Credentials arrive over TLS, are used to drive the OSCAR login form, and are
 * never stored or logged. The response returns an opaque sessionId that the
 * frontend keeps in memory (not localStorage) for the life of the tab.
 */
import { Router } from "express";
import { z } from "zod";
import { sessionManager } from "../session/sessionManager.js";
import { OscarLoginError } from "../oscar/client.js";
import { readSessionId } from "./util.js";
import { log } from "../logger.js";

export const authRouter = Router();

const loginSchema = z.object({
  oscarUrl: z.string().url("A valid OSCAR URL is required."),
  username: z.string().min(1, "Username is required."),
  password: z.string().min(1, "Password is required."),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
  }
  try {
    const { sessionId, username } = await sessionManager.login(parsed.data);
    return res.json({ status: "authenticated", sessionId, username });
  } catch (err) {
    if (err instanceof OscarLoginError) {
      return res.status(401).json({ status: "failed", error: err.message });
    }
    log.error("Login error", { error: String(err) });
    return res.status(502).json({
      status: "error",
      error: "Could not reach or drive OSCAR. Check the OSCAR URL and try again.",
    });
  }
});

authRouter.post("/logout", async (req, res) => {
  const sessionId = readSessionId(req);
  if (sessionId) await sessionManager.logout(sessionId);
  return res.status(204).end();
});

authRouter.get("/session", (req, res) => {
  const sessionId = readSessionId(req);
  const info = sessionId ? sessionManager.info(sessionId) : null;
  return res.json({ authenticated: Boolean(info), username: info?.username ?? null });
});
