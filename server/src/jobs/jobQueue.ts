/**
 * In-memory job queue (free, no external broker).
 *
 * A job runs one OSCAR search and streams JobEvents. Events are buffered on the
 * job so an SSE client that subscribes a moment after creation still replays the
 * full history. Per-session serialisation is delegated to SessionManager, so
 * two jobs on the same OSCAR session never drive the browser concurrently.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { sessionManager } from "../session/sessionManager.js";
import { log } from "../logger.js";
import type { JobEvent, JobResult, IntakeJobInput } from "./types.js";

interface Job {
  id: string;
  sessionId: string;
  events: JobEvent[];
  done: boolean;
  emitter: EventEmitter;
}

const JOB_TTL_MS = 10 * 60_000;

class JobQueue {
  private readonly jobs = new Map<string, Job>();

  submitIntake(sessionId: string, input: IntakeJobInput): string {
    const id = randomUUID();
    const job: Job = {
      id,
      sessionId,
      events: [],
      done: false,
      emitter: new EventEmitter(),
    };
    this.jobs.set(id, job);
    // Fire-and-forget; the SSE stream reports progress and errors.
    void this.run(job, input);
    return id;
  }

  /** Subscribe to a job: replays buffered events, then streams new ones. */
  subscribe(jobId: string, listener: (event: JobEvent) => void): (() => void) | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    for (const e of job.events) listener(e);
    if (job.done) return () => undefined;
    job.emitter.on("event", listener);
    return () => job.emitter.off("event", listener);
  }

  isDone(jobId: string): boolean {
    return this.jobs.get(jobId)?.done ?? true;
  }

  private push(job: Job, event: JobEvent) {
    job.events.push(event);
    job.emitter.emit("event", event);
  }

  private finish(job: Job, result: JobResult) {
    this.push(job, { kind: "done", step: "Added To Dashboards", result });
    job.done = true;
    setTimeout(() => this.jobs.delete(job.id), JOB_TTL_MS).unref?.();
  }

  private async run(job: Job, input: IntakeJobInput): Promise<void> {
    this.push(job, { kind: "email_received", step: "Email Imported" });

    try {
      // The whole search → (duplicate-check) → register flow runs inside one
      // exclusive section so a job waiting its turn isn't shown as active, and
      // the same OSCAR session is reused for every step.
      const result = await sessionManager.runExclusive(job.sessionId, async (client) => {
        this.push(job, { kind: "searching", step: "Searching OSCAR" });
        const search = await client.searchByEmail(input.email);

        if (search.outcome === "found") {
          this.push(job, {
            kind: "patient_found",
            step: `Patient already in OSCAR (#${search.patient.demographicNo})`,
            demographicNo: search.patient.demographicNo,
            patient: search.patient,
          });
          return {
            outcome: "found",
            demographicNo: search.patient.demographicNo,
            patient: search.patient,
          } as JobResult;
        }

        if (search.outcome === "multiple") {
          this.push(job, {
            kind: "multiple_matches",
            step: "Multiple matches — manual review required",
            demographicNos: search.demographicNos,
          });
          return { outcome: "multiple", demographicNos: search.demographicNos } as JobResult;
        }

        // Not found by email. Guard against creating a duplicate of a patient
        // who exists under a different email (match on last name + DOB).
        const dup = await client.findByNameDob(input.lastName, input.firstName, input.dob ?? "");
        if (dup) {
          this.push(job, {
            kind: "patient_found",
            step: `Possible existing chart by name + DOB (#${dup.demographicNo})`,
            demographicNo: dup.demographicNo,
            patient: dup,
          });
          return { outcome: "found", demographicNo: dup.demographicNo, patient: dup } as JobResult;
        }

        // New patient — register in OSCAR.
        this.push(job, { kind: "registering", step: "Registering new patient in OSCAR" });
        const created = await client.createPatient({
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          dob: input.dob,
          province: input.province,
          sex: input.sex,
          alert: input.alert,
          address: input.address,
        });
        this.push(job, {
          kind: "patient_created",
          step: `New patient registered (#${created.demographicNo})`,
          demographicNo: created.demographicNo,
          patient: created,
        });
        return {
          outcome: "created",
          demographicNo: created.demographicNo,
          patient: created,
        } as JobResult;
      });

      this.finish(job, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Intake job failed", { jobId: job.id, message });
      this.push(job, { kind: "error", step: "OSCAR Error", message });
      this.finish(job, { outcome: "error", message });
    }
  }
}

export const jobQueue = new JobQueue();
