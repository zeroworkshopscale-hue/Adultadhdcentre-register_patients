import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractFromEmail, initials, buildSheetRow, type Extracted } from "@/lib/extract";
import {
  login as oscarLogin,
  logout as oscarLogout,
  parseMsg,
  submitIntake,
  streamIntake,
  createAcknowledgementDrafts,
  sendAcknowledgements,
  type AckRecipient,
  type JobResult,
  type OscarSession,
} from "@/lib/oscarService";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ADHD Intake Dashboard — Adult ADHD Centre" },
      {
        name: "description",
        content:
          "Drag in ADHD intake emails to batch-search OSCAR and populate the Daily Sheet and Scheduling Queue dashboards.",
      },
    ],
  }),
  component: Index,
});

type Outcome = "found" | "created" | "not_found" | "multiple" | "error" | "no_email" | "review";

interface BatchItem {
  id: string;
  name: string;
  state: "queued" | "processing" | "done";
  step: string; // latest status line shown in the queue
  data?: Extracted;
  demographicNo: string;
  outcome?: Outcome;
  status: string; // value shown in the dashboard Status column
}

// Max emails processed in parallel from the browser. Kept small both to respect
// the browser's ~6-connections-per-host limit on EventSource and because the
// backend already serialises OSCAR operations per session (one search at a
// time). This pool mainly pipelines file reading / extraction.
const CONCURRENCY = 3;

// The OSCAR login URL is fixed for the clinic, so staff only enter ID + password.
// Override with VITE_OSCAR_DEFAULT_URL if the instance ever changes.
const OSCAR_URL: string =
  (import.meta.env.VITE_OSCAR_DEFAULT_URL as string | undefined) ??
  "https://welcome.kai-oscar.com/kaiemr/#/";

function oscarHost(): string {
  try {
    return new URL(OSCAR_URL).host;
  } catch {
    return OSCAR_URL;
  }
}

// Optional "remember me" — saves the login on THIS computer only (browser
// localStorage). Opt-in; cleared when the box is unchecked at connect time.
const SAVED_LOGIN_KEY = "adhd.oscarLogin";

function loadSavedLogin(): { username: string; password: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SAVED_LOGIN_KEY);
    return raw ? (JSON.parse(raw) as { username: string; password: string }) : null;
  } catch {
    return null;
  }
}

function saveLogin(value: { username: string; password: string } | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(SAVED_LOGIN_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(SAVED_LOGIN_KEY);
  } catch {
    /* ignore storage failures */
  }
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// OSCAR Booking Alert text, set on the chart from the assessment type.
function alertFor(assessment: Extracted["assessment"], womensClinic: boolean): string {
  const suffix = womensClinic ? " - Women" : "";
  if (assessment === "therapist") return `Therapist Supported ADHD Assessment${suffix}`;
  if (assessment === "private") return `Private ADHD${suffix}`;
  return "";
}

// Map processed rows to acknowledgement-email recipients. Greets by the
// preferred/nickname when present (e.g. "Yuning (Renee) Liang" -> "Dear Renee").
function ackRecipients(rows: BatchItem[]): AckRecipient[] {
  return rows
    .filter((r) => r.data && r.data.assessment && r.data.email)
    .map((r) => ({
      toEmail: r.data!.email,
      firstName: r.data!.preferredName || r.data!.firstName,
      assessment: r.data!.assessment as "private" | "therapist",
      womensClinic: r.data!.womensClinic,
    }));
}

async function readFileText(file: File): Promise<string> {
  // .msg parsing runs on the backend (it needs Node's Buffer, unavailable in the
  // browser). .eml/.txt are plain text and read directly.
  if (file.name.toLowerCase().endsWith(".msg")) {
    return parseMsg(await file.arrayBuffer());
  }
  return file.text();
}

/** Run one intake (search → register if new) to completion. Never rejects —
 *  errors resolve as an "error" result so one bad email never breaks the batch. */
function runEmail(
  sessionId: string,
  ext: Extracted,
  onStep: (step: string) => void,
): Promise<JobResult> {
  return new Promise((resolve) => {
    submitIntake(sessionId, {
      email: ext.email,
      firstName: ext.firstName,
      lastName: ext.lastName,
      preferredName: ext.preferredName || undefined,
      phone: ext.phone || undefined,
      dob: ext.dob || undefined,
      province: ext.province || undefined,
      sex: ext.gender, // name-based guess (M/F/U) → Sex + Gender Identity
      alert: alertFor(ext.assessment, ext.womensClinic) || undefined,
      address: ext.address || undefined,
    })
      .then(({ jobId }) => {
        streamIntake(sessionId, jobId, {
          onEvent: (e) => {
            if (e.kind !== "email_received" && e.kind !== "done") onStep(e.step);
          },
          onDone: (result) => resolve(result),
          onError: (message) => resolve({ outcome: "error", message }),
        });
      })
      .catch((err) => resolve({ outcome: "error", message: (err as Error).message }));
  });
}

function finalize(ext: Extracted, result: JobResult): Partial<BatchItem> {
  if (result.outcome === "found" && result.patient) {
    const p = result.patient;
    // OSCAR is the source of truth for contact info on a matched chart.
    const data: Extracted = {
      ...ext,
      firstName: p.firstName || ext.firstName,
      lastName: p.lastName || ext.lastName,
      email: p.email || ext.email,
      province: p.province || ext.province,
    };
    const demo = result.demographicNo ?? p.demographicNo;
    return {
      state: "done",
      data,
      demographicNo: demo,
      outcome: "found",
      status: "Patient already in Oscar - Review it manually",
      step: `Patient already in OSCAR (#${demo})`,
    };
  }
  if (result.outcome === "created" && result.patient) {
    const p = result.patient;
    const data: Extracted = {
      ...ext,
      firstName: p.firstName || ext.firstName,
      lastName: p.lastName || ext.lastName,
      email: p.email || ext.email,
      province: p.province || ext.province,
    };
    const demo = result.demographicNo ?? p.demographicNo;
    return {
      state: "done",
      data,
      demographicNo: demo,
      outcome: "created",
      status: "New patient - Registered",
      step: `New patient registered (#${demo})`,
    };
  }
  if (result.outcome === "multiple") {
    return {
      state: "done",
      data: ext,
      outcome: "multiple",
      status: "Multiple matches in Oscar - Review it manually",
      step: "Multiple matches — manual review",
    };
  }
  if (result.outcome === "error") {
    return {
      state: "done",
      data: ext,
      outcome: "error",
      status: "Error - Review it manually",
      step: `OSCAR error: ${result.message ?? "unknown"}`,
    };
  }
  // Not in OSCAR. These are new patients that need a chart. Once patient
  // creation is enabled this becomes "New patient - Registered" with a demo #.
  return {
    state: "done",
    data: ext,
    outcome: "not_found",
    status: "New patient - Needs registration",
    step: "Not in OSCAR — new patient",
  };
}

function Index() {
  const [session, setSession] = useState<OscarSession | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Controlled queue: shared refs so multiple pump() calls cooperate.
  const pendingRef = useRef<{ id: string; file: File }[]>([]);
  const inFlightRef = useRef(0);

  const updateItem = useCallback((id: string, patch: Partial<BatchItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const processTask = useCallback(
    async (task: { id: string; file: File }) => {
      const { id, file } = task;
      updateItem(id, { state: "processing", step: "Reading email…" });

      let text: string;
      try {
        text = await readFileText(file);
      } catch (e) {
        updateItem(id, {
          state: "done",
          outcome: "error",
          status: "Error",
          step: `Could not read file: ${(e as Error).message}`,
        });
        return;
      }

      const ext = extractFromEmail(text);
      updateItem(id, { data: ext, step: "Patient data extracted" });

      if (!ext.email) {
        updateItem(id, {
          state: "done",
          data: ext,
          outcome: "no_email",
          status: "Manual Review - No email in message",
          step: "No email address found — cannot search OSCAR",
        });
        return;
      }
      if (ext.dobAmbiguous) {
        // DOB present but not in an accepted format → flag, do not guess, do not
        // search OSCAR. The batch continues and the row lands on the dashboards.
        updateItem(id, {
          state: "done",
          data: ext,
          outcome: "review",
          status: "Manual Review - Check date of birth",
          step: "Date of birth format not recognized — manual review",
        });
        return;
      }
      if (!session) {
        updateItem(id, {
          state: "done",
          data: ext,
          outcome: "error",
          status: "Error",
          step: "Not connected to OSCAR",
        });
        return;
      }

      const result = await runEmail(session.sessionId, ext, (step) =>
        updateItem(id, { step }),
      );
      updateItem(id, finalize(ext, result));
    },
    [session, updateItem],
  );

  const pump = useCallback(() => {
    while (inFlightRef.current < CONCURRENCY && pendingRef.current.length > 0) {
      const task = pendingRef.current.shift()!;
      inFlightRef.current++;
      void processTask(task).finally(() => {
        inFlightRef.current--;
        pump();
      });
    }
  }, [processTask]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (!session) {
        setError("Connect to OSCAR first — enter your OSCAR URL, username, and password.");
        return;
      }
      setError(null);
      const newItems: BatchItem[] = files.map((f) => ({
        id: uid(),
        name: f.name || "email",
        state: "queued",
        step: "Queued",
        demographicNo: "",
        status: "Queued",
      }));
      setItems((prev) => [...prev, ...newItems]);
      newItems.forEach((it, i) => pendingRef.current.push({ id: it.id, file: files[i] }));
      pump();
    },
    [session, pump],
  );

  const addText = useCallback(
    (text: string) => {
      // Dragged plain-text email (no file). Wrap as a pseudo-file via a Blob.
      const file = new File([text], "pasted-email.txt", { type: "text/plain" });
      addFiles([file]);
    },
    [addFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) {
        addFiles(files);
        return;
      }
      const text = e.dataTransfer.getData("text/plain");
      if (text) addText(text);
    },
    [addFiles, addText],
  );

  const counts = useMemo(() => {
    let processed = 0;
    let successful = 0;
    let manual = 0;
    let failed = 0;
    for (const it of items) {
      if (it.state !== "done") continue;
      processed++;
      if (it.outcome === "found" || it.outcome === "created") successful++;
      else if (it.outcome === "error") failed++;
      else manual++; // not_found, multiple, no_email, review
    }
    return { total: items.length, processed, successful, manual, failed };
  }, [items]);

  const doneItems = useMemo(
    () => items.filter((it) => it.state === "done" && it.data),
    [items],
  );

  // What's shown in the Daily Sheet table (human-readable, includes Status).
  const dailyRow = (it: BatchItem): string[] => [
    it.data!.emailDate,
    it.data!.paymentId,
    initials(it.data!.firstName, it.data!.lastName),
    it.demographicNo,
    it.data!.assessment === "therapist" ? "Requested" : "",
    it.data!.province,
    it.status,
  ];

  // What's COPIED for the Daily Sheet: the spreadsheet A–Q layout (no Status).
  const dailyCopyRow = (it: BatchItem): string[] =>
    buildSheetRow(it.data!, it.demographicNo);

  const schedulingRow = (it: BatchItem): string[] => [
    it.data!.firstName,
    it.data!.email,
    it.data!.province,
    it.data!.assessment === "therapist" ? "Therapist-Supported" : "Regular",
  ];

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };
  const copyAllDaily = () => copy(doneItems.map((r) => dailyCopyRow(r).join("\t")).join("\n"));
  const copyAllScheduling = () =>
    copy(doneItems.map((r) => schedulingRow(r).join("\t")).join("\n"));

  const clearAll = () => {
    pendingRef.current = [];
    setItems([]);
  };
  const deleteRow = (id: string) => {
    pendingRef.current = pendingRef.current.filter((t) => t.id !== id);
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  const busy = counts.processed < counts.total;

  return (
    <div className="app-bg min-h-screen text-foreground">
      <header className="site-header border-b bg-card">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 64 64" className="h-10 w-10 shrink-0" role="img" aria-label="Adult ADHD Centre">
              <defs>
                <linearGradient id="brandPulse" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#D12A45" />
                  <stop offset="55%" stopColor="#A8182B" />
                  <stop offset="100%" stopColor="#7C1023" />
                </linearGradient>
              </defs>
              <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#brandPulse)" />
              <path
                d="M12 34 H22 L26 23 L32 45 L37 28 L41 34 H52"
                fill="none"
                stroke="#fff"
                strokeWidth="3.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Adult ADHD Centre
              </div>
              <h1 className="text-lg font-semibold leading-tight">
                Intake Processing Dashboard
              </h1>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {counts.processed} / {counts.total} processed this session
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] gap-6 px-6 py-6 lg:grid-cols-[360px_1fr]">
        {/* LEFT — connection + drop zone + batch status */}
        <aside className="space-y-4">
          <ConnectionPanel session={session} onSession={setSession} />
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex h-44 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed bg-card text-center transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
            } ${session ? "" : "opacity-60"}`}
          >
            <div className="text-lg font-semibold">Drop Emails Here</div>
            <div className="mt-1 px-4 text-xs text-muted-foreground">
              Outlook .msg · drag a whole batch to process them all automatically
            </div>
            <div className="mt-3 text-xs text-muted-foreground">or click to browse</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".msg,.eml,.txt"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          )}
          <BatchStatusPanel counts={counts} items={items} busy={busy} />
        </aside>

        {/* RIGHT — two dashboards */}
        <section className="space-y-6">
          <DashboardCard
            title="ADHD Daily Sheet"
            subtitle="Copy pastes columns A–Q for the Daily Google Sheet (Status is not copied)."
            headers={[
              "Email Date",
              "Payment ID",
              "Initials",
              "Demographic #",
              "Therapist-Supported",
              "Province",
              "Status",
            ]}
            rows={doneItems}
            getRow={dailyRow}
            getCopyRow={dailyCopyRow}
            onCopyAll={copyAllDaily}
            onClear={clearAll}
            onDeleteRow={deleteRow}
            copyAllLabel="Copy All Rows"
          />
          <DashboardCard
            title="Send acknowledgement email to the patients listed below"
            subtitle="Tick patients, then Send Emails to send now (or Draft Only to review first). Each goes from the correct clinic address with the right PDF, and replies come back to the clinic (adhd@adultadhdcentre.com / hers@adhdcentreforwomen.com)."
            headers={["First Name", "Email Address", "Province", "Assessment Type"]}
            rows={doneItems}
            getRow={schedulingRow}
            onCopyAll={copyAllScheduling}
            onClear={clearAll}
            onDeleteRow={deleteRow}
            copyAllLabel="Copy All Rows"
            onDraftBatch={async (rows) => createAcknowledgementDrafts(ackRecipients(rows))}
            onSendBatch={async (rows) => sendAcknowledgements(ackRecipients(rows))}
          />
        </section>
      </main>
    </div>
  );
}

function ConnectionPanel({
  session,
  onSession,
}: {
  session: OscarSession | null;
  onSession: (s: OscarSession | null) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Prefill from a saved login (this computer only), after mount to avoid SSR.
  useEffect(() => {
    const saved = loadSavedLogin();
    if (saved) {
      setUsername(saved.username);
      setPassword(saved.password);
      setRemember(true);
    }
  }, []);

  const connect = async () => {
    setErr(null);
    setBusy(true);
    try {
      const s = await oscarLogin({ oscarUrl: OSCAR_URL, username, password });
      saveLogin(remember ? { username, password } : null);
      onSession(s);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (session) await oscarLogout(session.sessionId);
    onSession(null);
  };

  if (session) {
    return (
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              OSCAR Connection
            </div>
            <div className="mt-0.5 text-sm font-medium">
              <span className="text-success-foreground">●</span> Connected as {session.username}
            </div>
          </div>
          <button
            onClick={() => void disconnect()}
            className="rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted"
          >
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
        Connect to OSCAR
      </div>
      <div className="mb-3 text-xs text-muted-foreground">{oscarHost()}</div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (username && password && !busy) void connect();
        }}
      >
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="OSCAR username"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          autoComplete="username"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="OSCAR password"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          autoComplete="current-password"
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Remember my login on this computer
        </label>
        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
        {err && <div className="text-xs text-destructive">{err}</div>}
        <p className="text-[11px] leading-snug text-muted-foreground">
          Your login is used only to open an OSCAR session. With “Remember” on, it
          is saved on this computer only — never sent anywhere else.
        </p>
      </form>
    </div>
  );
}

function BatchStatusPanel({
  counts,
  items,
  busy,
}: {
  counts: { total: number; processed: number; successful: number; manual: number; failed: number };
  items: BatchItem[];
  busy: boolean;
}) {
  const pct = counts.total ? Math.round((counts.processed / counts.total) * 100) : 0;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Batch Status
        </h2>
        {busy && <span className="text-xs text-muted-foreground">processing…</span>}
      </div>

      {counts.total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Drop one or more emails to begin automatic batch processing.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <Stat label="Total Emails" value={counts.total} />
            <Stat label="Processed" value={counts.processed} />
            <Stat label="Successful" value={counts.successful} className="text-success-foreground" />
            <Stat label="Manual Review" value={counts.manual} className="text-warning-foreground" />
            <Stat label="Failed" value={counts.failed} className={counts.failed ? "text-destructive" : ""} />
          </dl>

          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>

          <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto pr-1 text-xs">
            {items.map((it) => (
              <li key={it.id} className="flex items-start gap-2">
                <span className="mt-[1px] w-4 shrink-0">{itemIcon(it)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{it.name}</span>
                  <span className="block truncate text-muted-foreground">{it.step}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  className = "",
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-semibold tabular-nums ${className}`}>{value}</dd>
    </div>
  );
}

function itemIcon(it: BatchItem): string {
  if (it.state === "queued") return "•";
  if (it.state === "processing") return "⏳";
  if (it.outcome === "found" || it.outcome === "created") return "✓";
  if (it.outcome === "error") return "✕";
  return "⚠"; // not_found, multiple, no_email, review
}

function DashboardCard({
  title,
  subtitle,
  headers,
  rows,
  getRow,
  getCopyRow,
  onCopyAll,
  onClear,
  onDeleteRow,
  copyAllLabel,
  onDraftBatch,
  onSendBatch,
}: {
  title: string;
  subtitle: string;
  headers: string[];
  rows: BatchItem[];
  getRow: (r: BatchItem) => string[];
  getCopyRow?: (r: BatchItem) => string[];
  onCopyAll: () => void;
  onClear: () => void;
  onDeleteRow: (id: string) => void;
  copyAllLabel: string;
  onDraftBatch?: (rows: BatchItem[]) => Promise<{ created: number; note?: string }>;
  onSendBatch?: (rows: BatchItem[]) => Promise<{ sent: number; failed: string[]; note?: string }>;
}) {
  const [copiedRow, setCopiedRow] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<string | null>(null);

  const hasSelect = !!onDraftBatch;
  const isEligible = (r: BatchItem) => !!(r.data && r.data.assessment && r.data.email);
  const eligibleRows = rows.filter(isEligible);
  const selectedRows = eligibleRows.filter((r) => selected.has(r.id));
  const allSelected = eligibleRows.length > 0 && selectedRows.length === eligibleRows.length;

  const copyRow = async (r: BatchItem) => {
    await navigator.clipboard.writeText((getCopyRow ?? getRow)(r).join("\t"));
    setCopiedRow(r.id);
    setTimeout(() => setCopiedRow((c) => (c === r.id ? null : c)), 1500);
  };
  const copyAll = () => {
    onCopyAll();
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(eligibleRows.map((r) => r.id)));

  const sendSelected = async () => {
    if (!onDraftBatch || selectedRows.length === 0) return;
    const n = selectedRows.length;
    if (
      !window.confirm(
        `Create ${n} draft email${n > 1 ? "s" : ""} in Outlook (from the correct clinic address)? ` +
          `Nothing is sent — you review each draft and click Send yourself.`,
      )
    )
      return;
    setSending(true);
    setSendStatus(null);
    setSendNote(null);
    try {
      const res = await onDraftBatch(selectedRows);
      setSendStatus(
        `Created ${res.created} draft${res.created === 1 ? "" : "s"} in Outlook — review & click Send in each ✓`,
      );
      setSendNote(res.note ?? null);
      setSelected(new Set());
    } catch (e: any) {
      setSendStatus(`Failed: ${e?.message ?? "could not create drafts"}`);
    } finally {
      setSending(false);
    }
  };

  const sendNow = async () => {
    if (!onSendBatch || selectedRows.length === 0) return;
    const n = selectedRows.length;
    if (
      !window.confirm(
        `Send ${n} acknowledgement email${n > 1 ? "s" : ""} to patients NOW?\n\n` +
          `They go out from the clinic address, and replies come back to the clinic ` +
          `(adhd@adultadhdcentre.com / hers@adhdcentreforwomen.com). This cannot be undone.`,
      )
    )
      return;
    setSending(true);
    setSendStatus(null);
    setSendNote(null);
    try {
      const res = await onSendBatch(selectedRows);
      const failN = res.failed?.length ?? 0;
      setSendStatus(
        failN
          ? `Sent ${res.sent}; ${failN} failed (${res.failed.join(", ")})`
          : `Sent ${res.sent} email${res.sent === 1 ? "" : "s"} ✓`,
      );
      setSendNote(res.note ?? null);
      setSelected(new Set());
    } catch (e: any) {
      setSendStatus(`Failed: ${e?.message ?? "could not send"}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          {hasSelect && sendStatus && (
            <p className="mt-1 text-xs font-medium text-primary">{sendStatus}</p>
          )}
          {hasSelect && sendNote && (
            <p className="mt-1 text-xs font-medium text-warning-foreground">{sendNote}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {hasSelect && onSendBatch && (
            <button
              onClick={() => void sendNow()}
              disabled={selectedRows.length === 0 || sending}
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending
                ? "Sending…"
                : `Send Emails${selectedRows.length ? ` (${selectedRows.length})` : ""}`}
            </button>
          )}
          {hasSelect && (
            <button
              onClick={() => void sendSelected()}
              disabled={selectedRows.length === 0 || sending}
              className="rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending
                ? "…"
                : `Draft Only${selectedRows.length ? ` (${selectedRows.length})` : ""}`}
            </button>
          )}
          <button
            onClick={copyAll}
            disabled={rows.length === 0}
            className="rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copiedAll ? "Copied" : copyAllLabel}
          </button>
          <button
            onClick={onClear}
            disabled={rows.length === 0}
            className="rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear All
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              {hasSelect && (
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={eligibleRows.length === 0}
                    aria-label="Select all patients"
                  />
                </th>
              )}
              {headers.map((h) => (
                <th key={h} className="px-3 py-2 font-semibold">
                  {h}
                </th>
              ))}
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={headers.length + 1 + (hasSelect ? 1 : 0)}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No entries yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const cells = getRow(r);
                const flag = r.outcome !== "found" && r.outcome !== "created";
                const eligible = isEligible(r);
                return (
                  <tr
                    key={r.id}
                    className={`border-b last:border-0 ${flag ? "bg-warning/10" : ""}`}
                  >
                    {hasSelect && (
                      <td className="px-3 py-2 align-top">
                        {eligible && (
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleRow(r.id)}
                            aria-label={`Select ${r.data?.firstName ?? "patient"}`}
                          />
                        )}
                      </td>
                    )}
                    {cells.map((c, i) => (
                      <td
                        key={i}
                        className={`px-3 py-2 align-top ${
                          flag && !c ? "text-warning-foreground italic" : ""
                        }`}
                      >
                        {c || <span className="text-muted-foreground">—</span>}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={() => void copyRow(r)}
                          className="rounded border px-2 py-1 text-xs hover:bg-muted"
                        >
                          {copiedRow === r.id ? "Copied" : "Copy Row"}
                        </button>
                        <button
                          onClick={() => onDeleteRow(r.id)}
                          className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-destructive"
                          aria-label="Delete row"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
