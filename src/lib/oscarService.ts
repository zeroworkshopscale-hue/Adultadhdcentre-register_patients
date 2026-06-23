// Client for the OSCAR automation backend (server/). All OSCAR work happens
// in that service; this module is the only place the frontend talks to it.
//
// The base URL is configurable so the same build works in local dev and when
// the service is reverse-proxied under parharsaacportal.ca.

const BASE: string =
  (import.meta.env.VITE_OSCAR_SERVICE_URL as string | undefined)?.replace(/\/$/, "") ||
  "http://localhost:8787";

export interface OscarSession {
  sessionId: string;
  username: string;
}

export interface DemographicDetails {
  demographicNo: string;
  firstName: string;
  lastName: string;
  dob: string;
  email: string;
  phone: string;
  province: string;
  sex: string;
}

export type JobOutcome = "found" | "created" | "not_found" | "multiple" | "error";

export interface JobResult {
  outcome: JobOutcome;
  demographicNo?: string;
  patient?: DemographicDetails;
  demographicNos?: string[];
  message?: string;
}

export interface JobEvent {
  kind:
    | "email_received"
    | "searching"
    | "registering"
    | "patient_found"
    | "patient_created"
    | "patient_not_found"
    | "multiple_matches"
    | "error"
    | "done";
  step: string;
  demographicNo?: string;
  patient?: DemographicDetails;
  demographicNos?: string[];
  message?: string;
  result?: JobResult;
}

/** Patient data sent to the backend: email drives the search; the rest is used
 *  to register the patient if they are not already in OSCAR. */
export interface IntakeInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  dob?: string;
  province?: string;
  sex?: string;
  alert?: string;
  address?: string;
}

async function postJson<T>(path: string, body: unknown, sessionId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "X-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((data.error as string) || `Request failed (${res.status}).`);
  }
  return data as T;
}

export async function login(input: {
  oscarUrl: string;
  username: string;
  password: string;
}): Promise<OscarSession> {
  const data = await postJson<{ sessionId: string; username: string }>(
    "/api/oscar/login",
    input,
  );
  return { sessionId: data.sessionId, username: data.username };
}

export async function logout(sessionId: string): Promise<void> {
  await fetch(`${BASE}/api/oscar/logout`, {
    method: "POST",
    headers: { "X-Session-Id": sessionId },
  }).catch(() => undefined);
}

/** Parse an Outlook .msg file into email text on the backend (Node has Buffer;
 *  the browser does not, which is why msgreader can't run client-side). */
export async function parseMsg(buf: ArrayBuffer): Promise<string> {
  const res = await fetch(`${BASE}/api/parse/msg`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(data.error || "Could not read .msg file.");
  return data.text ?? "";
}

export async function submitIntake(
  sessionId: string,
  input: IntakeInput,
): Promise<{ jobId: string }> {
  return postJson<{ jobId: string }>("/api/intake", input, sessionId);
}

/**
 * Open the SSE stream for a job. Returns a function to close the stream early.
 * Resolves nothing; use the handler callbacks to react to progress.
 */
export function streamIntake(
  sessionId: string,
  jobId: string,
  handlers: {
    onEvent?: (event: JobEvent) => void;
    onDone?: (result: JobResult) => void;
    onError?: (message: string) => void;
  },
): () => void {
  const url = `${BASE}/api/intake/${encodeURIComponent(jobId)}/events?sessionId=${encodeURIComponent(sessionId)}`;
  const es = new EventSource(url);
  let finished = false;

  es.onmessage = (msg) => {
    let event: JobEvent;
    try {
      event = JSON.parse(msg.data) as JobEvent;
    } catch {
      return;
    }
    handlers.onEvent?.(event);
    if (event.kind === "done") {
      finished = true;
      handlers.onDone?.(event.result as JobResult);
      es.close();
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects; only report a failure that wasn't a normal
    // completion and has fully closed.
    if (!finished && es.readyState === EventSource.CLOSED) {
      handlers.onError?.("Lost connection to the OSCAR service.");
    }
  };

  return () => {
    finished = true;
    es.close();
  };
}
