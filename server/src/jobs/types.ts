import type { DemographicDetails } from "../oscar/client.js";

/** Outcome of an intake job. */
export type JobOutcome = "found" | "created" | "not_found" | "multiple" | "error";

/**
 * Events streamed to the frontend over SSE. `step` is a human-readable label the
 * Processing Status panel renders directly; `kind` lets the client branch.
 */
export type JobEvent =
  | { kind: "email_received"; step: string }
  | { kind: "searching"; step: string }
  | { kind: "registering"; step: string }
  | { kind: "patient_found"; step: string; demographicNo: string; patient: DemographicDetails }
  | { kind: "patient_created"; step: string; demographicNo: string; patient: DemographicDetails }
  | { kind: "patient_not_found"; step: string }
  | { kind: "multiple_matches"; step: string; demographicNos: string[] }
  | { kind: "error"; step: string; message: string }
  | { kind: "done"; step: string; result: JobResult };

export interface JobResult {
  outcome: JobOutcome;
  demographicNo?: string;
  patient?: DemographicDetails;
  demographicNos?: string[];
  message?: string;
}

/** Full patient data sent from the frontend: email drives the search; the rest
 *  is used to register the patient if they are not already in OSCAR. */
export interface IntakeJobInput {
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
