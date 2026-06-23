/**
 * Lazily-launched, shared Chromium instance.
 *
 * One Browser is launched for the whole process; every OSCAR session gets its
 * own isolated BrowserContext (separate cookies), so multiple operators never
 * share an OSCAR login.
 */
import { chromium, type Browser } from "playwright";
import { config } from "../config.js";
import { log } from "../logger.js";

let browserPromise: Promise<Browser> | undefined;

export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const channel =
      config.browserChannel && config.browserChannel !== "chromium"
        ? config.browserChannel
        : undefined;
    log.info("Launching Chromium", {
      headless: config.headless,
      channel: channel ?? "bundled",
    });
    browserPromise = chromium
      .launch({ headless: config.headless, channel })
      .catch((err) => {
        browserPromise = undefined;
        throw err;
      });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (err) {
    log.warn("Error closing browser", { err: String(err) });
  } finally {
    browserPromise = undefined;
  }
}
