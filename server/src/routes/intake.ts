/**
 * Intake routes: submit an email for OSCAR search, then stream progress via SSE.
 *
 *   POST /api/intake                -> { jobId }
 *   GET  /api/intake/:jobId/events  -> text/event-stream of JobEvents
 */
import { Router } from "express";
import { z } from "zod";
import { sessionManager } from "../session/sessionManager.js";
import { jobQueue } from "../jobs/jobQueue.js";
import { readSessionId } from "./util.js";

export const intakeRouter = Router();

const intakeSchema = z.object({
  email: z.string().min(3, "An email address is required to search OSCAR."),
  firstName: z.string().default(""),
  lastName: z.string().default(""),
  phone: z.string().optional(),
  dob: z.string().optional(),
  province: z.string().optional(),
  sex: z.string().optional(),
  alert: z.string().optional(),
  address: z.string().optional(),
});

intakeRouter.post("/", (req, res) => {
  const sessionId = readSessionId(req);
  if (!sessionId || !sessionManager.has(sessionId)) {
    return res.status(401).json({ error: "Not connected to OSCAR. Please connect first." });
  }
  const parsed = intakeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
  }
  const jobId = jobQueue.submitIntake(sessionId, parsed.data);
  return res.json({ jobId });
});

intakeRouter.get("/:jobId/events", (req, res) => {
  const sessionId = readSessionId(req);
  if (!sessionId || !sessionManager.has(sessionId)) {
    return res.status(401).json({ error: "Not connected to OSCAR." });
  }
  const { jobId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = jobQueue.subscribe(jobId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.kind === "done") res.end();
  });

  if (!unsubscribe) {
    res.write(`data: ${JSON.stringify({ kind: "error", step: "Unknown Job", message: "Job not found." })}\n\n`);
    return res.end();
  }

  // Keep-alive heartbeat so proxies don't drop an idle stream.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  heartbeat.unref?.();

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
