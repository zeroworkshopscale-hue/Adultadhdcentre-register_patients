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

// Loading page. The backend starts in ~2s; the frontend dev server can take
// up to a minute on the first launch after install (dependency optimization).
// The desktop launcher opens THIS page so the user always sees a friendly
// spinner instead of a "connection refused" error, and it auto-redirects to
// the dashboard (port 8080) the moment the frontend is ready.
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:8080/";
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Starting the app…</title>
<style>
  html,body{height:100%;margin:0}
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#faf7fb;color:#3a2a3a;
       display:flex;align-items:center;justify-content:center}
  .box{text-align:center;max-width:440px;padding:2rem}
  .spinner{width:40px;height:40px;border:4px solid #ead7e0;border-top-color:#A8182B;border-radius:50%;
           animation:spin 1s linear infinite;margin:0 auto 1.4rem}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.15rem;margin:0 0 .5rem}p{font-size:.9rem;line-height:1.5;color:#6b5a66;margin:.3rem 0}
</style></head><body><div class="box">
  <div class="spinner"></div>
  <h1>Starting the ADHD Patients Registration App…</h1>
  <p>The first launch after installing can take up to a minute while it gets ready.</p>
  <p>This page will open the dashboard automatically — please wait.</p>
</div>
<script>
  var target = ${JSON.stringify(FRONTEND_URL)};
  function ping(){
    fetch(target,{mode:'no-cors',cache:'no-store'})
      .then(function(){ location.replace(target); })
      .catch(function(){ setTimeout(ping,1500); });
  }
  setTimeout(ping,1200);
</script></body></html>`);
});

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
