/**
 * Instance-specific OSCAR locators in one place, so an integrator can adjust
 * them per deployment WITHOUT touching control flow.
 *
 * Defaults follow the KAI OSCAR deployment (welcome.kai-oscar.com): an Angular
 * SPA login at /kaiemr/#/ whose session cookie then unlocks the classic OSCAR
 * Pro JSP endpoints under /oscar/... on the same origin.
 *
 * These values are ported from the confirmed selectors in the sibling Python
 * project (adhd-intake-automation/adhd_intake/oscar/client.py).
 */
export interface OscarSelectors {
  /** Robust Angular-friendly login field selectors (".first" is used). */
  usernameInput: string;
  passwordInput: string;
  pinInput: string;
  loginSubmit: string;
  /** Visible only AFTER a successful login. */
  loginSuccessMarker: string;

  /** Path prefix for the classic OSCAR Pro JSP endpoints (appended to origin). */
  classicPrefix: string;

  /** Patient search result page + the link that carries demographic_no. */
  searchResultsPath: string;
  resultLink: string;
}

export const DEFAULT_SELECTORS: OscarSelectors = {
  usernameInput:
    "input[name='username'], input[name='userName'], " +
    "input[type='text']:not([type='password']), " +
    "input[placeholder*='sername' i], input[placeholder*='user' i]",
  passwordInput: "input[type='password']",
  pinInput:
    "input[name='pin'], input[placeholder*='pin' i], input[placeholder*='PIN' i]",
  loginSubmit:
    "button[type='submit'], input[type='submit'], " +
    "button:has-text('Sign'), button:has-text('Log'), " +
    "button:has-text('Login'), button:has-text('Enter')",
  loginSuccessMarker:
    "nav, [class*='nav-'], [class*='sidebar'], [class*='dashboard'], " +
    "[class*='schedule'], [class*='menu'], " +
    "text=Schedule, text=Patient Search, text=Inbox",

  classicPrefix: "/oscar",

  searchResultsPath: "/demographic/demographiccontrol.jsp",
  resultLink: "a[onclick*='demographic_no']",
};
