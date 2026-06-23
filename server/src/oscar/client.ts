/**
 * OSCAR Pro automation via Playwright — login + patient search by email.
 *
 * Ported from the confirmed Python implementation
 * (adhd-intake-automation/adhd_intake/oscar/client.py). Control flow and URLs
 * are identical; only the language differs. Patient CREATION is intentionally
 * NOT implemented yet (Priority 1 scope).
 *
 *   const client = new OscarClient(browser, { oscarUrl, timeoutMs });
 *   await client.init();
 *   await client.login({ username, password });
 *   const result = await client.searchByEmail("patient@example.com");
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { DEFAULT_SELECTORS, type OscarSelectors } from "./selectors.js";
import { log } from "../logger.js";

export class OscarError extends Error {}
export class OscarLoginError extends OscarError {}

export interface OscarClientOptions {
  /** Full OSCAR login URL the operator entered (e.g. https://host/kaiemr/). */
  oscarUrl: string;
  timeoutMs: number;
  selectors?: OscarSelectors;
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

export type SearchResult =
  | { outcome: "found"; patient: DemographicDetails }
  | { outcome: "not_found" }
  | { outcome: "multiple"; demographicNos: string[] };

export interface NewPatientInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dob?: string; // YYYY-MM-DD (already validated by the extractor)
  /** Full province name from extraction (e.g. "British Columbia"). */
  province?: string;
  /** "M" | "F" | "U" — name-based guess; sets both Sex and Gender Identity. */
  sex?: string;
  /** Booking Alert text, e.g. "Private ADHD" / "Therapist Supported ADHD Assessment". */
  alert?: string;
  /** Full address string from the email, e.g. "1 Main St, City, Province POSTAL". */
  address?: string;
}

/** Split a combined address string into OSCAR's street / city / postal fields. */
function splitAddress(
  raw: string,
  provinceName?: string,
): { street: string; city: string; postal: string } {
  const text = (raw || "").trim();
  if (!text) return { street: "", city: "", postal: "" };
  const postalMatch = text.match(/[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/);
  const postal = postalMatch ? postalMatch[0].toUpperCase() : "";
  let rest = text.replace(/[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/, "");
  if (provinceName) {
    rest = rest.replace(new RegExp(`${provinceName}\\s*,?\\s*$`, "i"), "");
  }
  const segs = rest
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Drop a trailing province segment (e.g. "...Torbay, Newfoundland") so it
  // doesn't end up in the city field — the province dropdown is set separately.
  if (segs.length >= 2 && provinceName) {
    const last = segs[segs.length - 1].toLowerCase();
    const prov = provinceName.toLowerCase();
    if (prov.includes(last) || last.includes(prov)) segs.pop();
  }
  if (segs.length >= 2) {
    return { street: segs[0], city: segs.slice(1).join(", "), postal };
  }
  return { street: segs[0] ?? "", city: "", postal };
}

// Map our full province names to OSCAR's 2-letter dropdown codes (note "NF" for
// Newfoundland in this instance). Unknown / blank → province left unset.
const PROVINCE_CODE: Record<string, string> = {
  Alberta: "AB",
  "British Columbia": "BC",
  Manitoba: "MB",
  "New Brunswick": "NB",
  "Newfoundland and Labrador": "NF",
  "Northwest Territories": "NT",
  "Nova Scotia": "NS",
  Nunavut: "NU",
  Ontario: "ON",
  "Prince Edward Island": "PE",
  Quebec: "QC",
  Saskatchewan: "SK",
  Yukon: "YT",
};

export class OscarClient {
  private readonly opts: OscarClientOptions;
  private readonly sel: OscarSelectors;
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private readonly browser: Browser,
    opts: OscarClientOptions,
  ) {
    this.opts = opts;
    this.sel = opts.selectors ?? DEFAULT_SELECTORS;
  }

  // ---- lifecycle -------------------------------------------------------
  async init(): Promise<void> {
    this.context = await this.browser.newContext({ acceptDownloads: false });
    this.context.setDefaultTimeout(this.opts.timeoutMs);
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } finally {
      this.context = undefined;
      this.page = undefined;
    }
  }

  private get pg(): Page {
    if (!this.page) throw new OscarError("OSCAR client not initialised; call init().");
    return this.page;
  }

  // ---- URL helpers -----------------------------------------------------
  private origin(): string {
    return new URL(this.opts.oscarUrl).origin;
  }

  private classicUrl(path: string): string {
    return `${this.origin()}${this.sel.classicPrefix}${path}`;
  }

  // ---- login -----------------------------------------------------------
  /**
   * Log into OSCAR via the Angular SPA login form, then verify success.
   * Credentials are used here and never retained by the client.
   */
  async login(creds: { username: string; password: string }): Promise<void> {
    const page = this.pg;
    const loginUrl = this.opts.oscarUrl;
    log.info("OSCAR login: navigating to login page", { loginUrl });

    try {
      await page.goto(loginUrl, { waitUntil: "networkidle" });

      const user = page.locator(this.sel.usernameInput).first();
      const pass = page.locator(this.sel.passwordInput).first();
      await user.waitFor({ state: "visible", timeout: this.opts.timeoutMs });
      await pass.waitFor({ state: "visible", timeout: this.opts.timeoutMs });

      // Type real keystrokes. The Okta/Angular login form ignores values set
      // before it has hydrated, so .fill() alone can silently fail to register.
      await user.click();
      await user.fill("");
      await user.pressSequentially(creds.username, { delay: 20 });
      await pass.click();
      await pass.fill("");
      await pass.pressSequentially(creds.password, { delay: 20 });

      // Some OSCAR builds add a separate PIN field that mirrors the password.
      const pin = page.locator(this.sel.pinInput);
      if ((await pin.count()) > 0) {
        await pin.first().pressSequentially(creds.password, { delay: 20 });
      }

      await page.locator(this.sel.loginSubmit).first().click();
    } catch (err) {
      throw new OscarError(`Timed out logging into OSCAR: ${String(err)}`);
    }

    // Success = redirected into the classic OSCAR app (/oscar/…). Fall back to a
    // post-login UI marker for instances that land on a different path.
    try {
      await page.waitForURL("**/oscar/**", { timeout: 20_000 });
      log.info("OSCAR login successful", { url: page.url() });
      return;
    } catch {
      /* fall through to the marker check */
    }
    try {
      await page.waitForSelector(this.sel.loginSuccessMarker, { timeout: 5_000 });
      log.info("OSCAR login successful (marker)", { url: page.url() });
    } catch {
      throw new OscarLoginError(
        "OSCAR login failed — please check your username and password.",
      );
    }
  }

  // ---- patient search by email ----------------------------------------
  async searchByEmail(email: string): Promise<SearchResult> {
    const demos = await this.searchCandidates("search_email", email.trim());
    if (demos.length === 0) return { outcome: "not_found" };
    if (demos.length > 1) return { outcome: "multiple", demographicNos: demos };
    const patient = await this.getDemographicDetails(demos[0]);
    return { outcome: "found", patient };
  }

  /** Run one OSCAR search and return all candidate demographic numbers. */
  private async searchCandidates(mode: string, keyword: string): Promise<string[]> {
    const page = this.pg;
    const url =
      `${this.classicUrl(this.sel.searchResultsPath)}` +
      `?search_mode=${encodeURIComponent(mode)}` +
      `&keyword=${encodeURIComponent(keyword)}` +
      `&dboperation=search_titlename` +
      `&limit1=0&limit2=25&displaymode=Search&ptstatus=active`;

    try {
      await page.goto(url, { waitUntil: "networkidle" });
    } catch {
      log.warn("OSCAR search timed out", { mode, keyword });
      return [];
    }

    const out: string[] = [];
    const rows = page.locator(this.sel.resultLink);
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const onclick = (await rows.nth(i).getAttribute("onclick")) ?? "";
      const demo = parseDemographicNo(onclick);
      if (demo && !out.includes(demo)) out.push(demo);
    }
    log.info("OSCAR search complete", { mode, candidates: out.length });
    return out;
  }

  /** Read a chart's current values (name, dob, email, province, phone, sex). */
  async getDemographicDetails(demo: string): Promise<DemographicDetails> {
    const page = this.pg;
    await page.goto(
      `${this.classicUrl("/demographic/demographiccontrol.jsp")}` +
        `?demographic_no=${encodeURIComponent(demo)}&displaymode=edit&dboperation=search_detail`,
      { waitUntil: "networkidle" },
    );
    await page.waitForSelector("input[name='last_name']", {
      timeout: this.opts.timeoutMs,
      state: "attached",
    });

    // NOTE: no named inner function here — under tsx/esbuild a named helper in
    // page.evaluate triggers a "__name is not defined" runtime error.
    const data = await page.evaluate(() => {
      const names = [
        "last_name", "first_name", "year_of_birth", "month_of_birth",
        "date_of_birth", "full_birth_date", "email", "phone", "phone2",
        "province", "sex",
      ];
      const out: Record<string, string> = {};
      for (const n of names) {
        const e = document.querySelector("[name='" + n + "']") as
          | HTMLInputElement
          | HTMLSelectElement
          | null;
        out[n] = e ? String(e.value) : "";
      }
      return out;
    });

    const y = data.year_of_birth;
    const m = data.month_of_birth;
    const d = data.date_of_birth;
    const dob = y && m && d ? `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : data.full_birth_date;

    return {
      demographicNo: demo,
      firstName: data.first_name,
      lastName: data.last_name,
      dob,
      email: data.email,
      phone: data.phone || data.phone2,
      province: data.province,
      sex: data.sex,
    };
  }

  // ---- patient creation ------------------------------------------------
  /**
   * Create a new demographic from the extracted email data, then read back the
   * new demographic number (via an email search). Health-card type is set to
   * "Other" so OSCAR does not require a HIN we don't have; fields we don't have
   * are left blank — nothing is invented.
   */
  async createPatient(input: NewPatientInput): Promise<DemographicDetails> {
    const page = this.pg;
    await page.goto(this.classicUrl("/demographic/demographicaddarecordhtm.jsp"), {
      waitUntil: "networkidle",
    });
    await page.waitForSelector("input[name='last_name']", {
      state: "visible",
      timeout: this.opts.timeoutMs,
    });

    const [yy = "", mm = "", dd = ""] = (input.dob || "").split("-");
    const provinceCode = input.province ? (PROVINCE_CODE[input.province] ?? "") : "";
    const sex = input.sex === "M" || input.sex === "F" ? input.sex : "U";
    // Gender Identity dropdown on this form: 1=Male, 2=Female.
    const genderId = sex === "M" ? "1" : sex === "F" ? "2" : "";
    const pairs: [string, string][] = [
      ["last_name", input.lastName || ""],
      ["first_name", input.firstName || ""],
      ["email", input.email || ""],
      ["phone", input.phone || ""],
      ["full_birth_date", input.dob || ""],
      ["year_of_birth", yy],
      ["month_of_birth", mm],
      ["date_of_birth", dd],
      ["sex", sex],
      ["patient_status", "AC"],
      ["hc_type", "OT"],
    ];
    if (genderId) pairs.push(["gender", genderId]);
    if (provinceCode) pairs.push(["province", provinceCode]);
    if (input.alert) pairs.push(["bookingAlert", input.alert]);
    const addr = splitAddress(input.address ?? "", input.province);
    if (addr.street) pairs.push(["address", addr.street]);
    if (addr.city) pairs.push(["city", addr.city]);
    if (addr.postal) pairs.push(["postal", addr.postal]);

    await page.evaluate((ps: [string, string][]) => {
      for (const [name, value] of ps) {
        const el = document.querySelector("[name='" + name + "']") as
          | HTMLInputElement
          | HTMLSelectElement
          | null;
        if (!el) continue;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, pairs);

    // Capture any validation dialog (e.g. a missing required field) so we can
    // report it instead of silently failing.
    let dialogMessage = "";
    const onDialog = (dlg: import("playwright").Dialog) => {
      dialogMessage = dlg.message();
      dlg.accept().catch(() => undefined);
    };
    page.on("dialog", onDialog);
    try {
      await page.locator("input[type='submit'][name='submit']").first().click();
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(1500);
    } finally {
      page.off("dialog", onDialog);
    }

    const body = await page.locator("body").innerText().catch(() => "");
    if (!body.includes("Successful Addition")) {
      throw new OscarError(
        `Patient registration was not confirmed${dialogMessage ? `: ${dialogMessage}` : "."}`,
      );
    }

    // Read back the new chart (and its demographic number) by email.
    const result = await this.searchByEmail(input.email);
    if (result.outcome === "found") return result.patient;
    throw new OscarError("Registered the patient but could not read back the demographic number.");
  }

  /**
   * Duplicate guard: before creating, look for an existing chart with the same
   * last name AND date of birth (the patient may already exist under a different
   * email). Returns the matching chart, or null if none.
   */
  async findByNameDob(
    lastName: string,
    firstName: string,
    dob: string,
  ): Promise<DemographicDetails | null> {
    if (!lastName || !dob) return null;
    const keyword = firstName ? `${lastName},${firstName}` : lastName;
    const candidates = await this.searchCandidates("search_name", keyword);
    for (const demo of candidates.slice(0, 8)) {
      const details = await this.getDemographicDetails(demo);
      if (details.dob && details.dob === dob) return details;
    }
    return null;
  }
}

function parseDemographicNo(text: string): string | null {
  const m = /demographic_?no=(\d+)/i.exec(text || "");
  return m ? m[1] : null;
}
