import type { Request } from "express";

/**
 * Read the session id from (in priority order) the X-Session-Id header, a
 * `sessionId` query param (needed for EventSource, which cannot set headers),
 * or the JSON body.
 */
export function readSessionId(req: Request): string | null {
  const header = req.header("x-session-id");
  if (header) return header;
  const query = req.query.sessionId;
  if (typeof query === "string" && query) return query;
  const body = (req.body ?? {}) as { sessionId?: unknown };
  if (typeof body.sessionId === "string" && body.sessionId) return body.sessionId;
  return null;
}
