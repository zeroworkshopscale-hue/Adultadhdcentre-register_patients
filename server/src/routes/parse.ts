/**
 * Parse an Outlook .msg file into plain email text.
 *
 * Done on the backend because @kenjiuno/msgreader depends on iconv-lite /
 * Buffer, which exist in Node but not in the browser. The raw .msg bytes are
 * POSTed here (over loopback in the desktop/local setup) and the composed
 * Subject/Date/From/body text is returned for the frontend extractor.
 */
import { Router, raw } from "express";
import { createRequire } from "node:module";
import { log } from "../logger.js";

// @kenjiuno/msgreader is CJS; Node's ESM default-import hands back the whole
// module object, so resolve the actual constructor via require().
const require = createRequire(import.meta.url);
const MsgReader: new (ab: ArrayBuffer) => { getFileData: () => Record<string, unknown> } =
  require("@kenjiuno/msgreader").default ?? require("@kenjiuno/msgreader");

export const parseRouter = Router();

parseRouter.post("/msg", raw({ type: "*/*", limit: "25mb" }), (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({ error: "Empty request body." });
  }
  try {
    const ab = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
    const reader = new MsgReader(ab);
    const info = reader.getFileData() as {
      dataType?: unknown;
      error?: string;
      subject?: string;
      body?: string;
      senderEmail?: string;
      messageDeliveryTime?: string;
      clientSubmitTime?: string;
    };
    if (!info || info.dataType === null || info.error) {
      return res.status(422).json({ error: info?.error || "Unreadable .msg file." });
    }
    const text = [
      `Subject: ${info.subject ?? ""}`,
      `Date: ${info.messageDeliveryTime ?? info.clientSubmitTime ?? ""}`,
      `From: ${info.senderEmail ?? ""}`,
      "",
      info.body ?? "",
    ].join("\n");
    return res.json({ text });
  } catch (err) {
    log.error("Failed to parse .msg", { error: String(err) });
    return res.status(500).json({ error: `Could not parse .msg: ${(err as Error).message}` });
  }
});
