/**
 * OSCAR Automation Service — Express entrypoint.
 *
 * Standalone Node process (NOT part of the Cloudflare-targeted frontend build)
 * that drives the OSCAR EMR web UI with Playwright. See server/README.md.
 */
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { log } from "./logger.js";
import { sessionManager } from "./session/sessionManager.js";
import { closeBrowser } from "./oscar/browser.js";
import { authRouter } from "./routes/auth.js";
import { intakeRouter } from "./routes/intake.js";
import { parseRouter } from "./routes/parse.js";
import { emailRouter } from "./routes/email.js";

const app = express();

app.use(
  cors({
    // Empty CORS_ORIGINS => reflect request origin (development only).
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    allowedHeaders: ["Content-Type", "X-Session-Id"],
  }),
);
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/oscar", authRouter);
app.use("/api/intake", intakeRouter);
app.use("/api/parse", parseRouter);
app.use("/api/email", emailRouter);

sessionManager.start();

const server = app.listen(config.port, () => {
  log.info(`OSCAR automation service listening on http://localhost:${config.port}`, {
    headless: config.headless,
    browserChannel: config.browserChannel,
    corsOrigins: config.corsOrigins.length ? config.corsOrigins : "(reflect any — dev)",
  });
});

async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down…`);
  server.close();
  await sessionManager.shutdown();
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
