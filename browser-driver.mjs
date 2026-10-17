import fs from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { CDP_URL, STORAGE_STATE_PATH, ensureEdgeWithCdp, generateOnPage, inspectGeneration } from "./generate.mjs";

const STOP_SELECTOR = [
  'button[data-testid="stop-button"]:visible',
  'button[aria-label="Stop generating"]:visible',
  'button[aria-label="Stop streaming"]:visible',
  'button[aria-label="Остановить"]:visible',
  'button[aria-label="Остановить генерацию"]:visible',
].join(", ");

function isChatGpt(url) {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === "chatgpt.com"; }
  catch { return false; }
}

export async function isPageBusy(page) {
  return page.evaluate(() => {
    const last = [...document.querySelectorAll('[data-turn-key], article[data-testid^="conversation-turn-"]')].at(-1);
    const states = last ? [last, ...last.querySelectorAll("[data-talvt-turn-state]")]
      .filter(el => el.hasAttribute("data-talvt-turn-state")) : [];
    return states.some(el => el.getAttribute("data-talvt-turn-state") !== "complete") ||
      !!document.querySelector('[data-testid="stop-button"]');
  });
}

/** One browser connection; each job retains an explicit stable target identity. */
export class BrowserDriver {
  constructor({ browser = null, context = null, cdpUrl = CDP_URL,
    headless = !/^(0|false)$/i.test(process.env.IMAGE_GEN_HEADLESS || ""),
    browserType = chromium, storagePath = STORAGE_STATE_PATH } = {}) {
    this.browser = browser;
    this.context = context;
    this.cdpUrl = cdpUrl;
    this.headless = headless;
    this.browserType = browserType;
    this.storagePath = storagePath;
    this.storageMtime = 0;
    this.ownsConnection = !browser;
    this.connecting = null;
    this.identities = new WeakMap();
    this.managed = new Map();
    this.operations = new Map();
  }

  async connect() {
    if (this.connecting) { await this.connecting; return; }
    if (this.browser?.isConnected()) {
      if (this.ownsConnection && this.headless) await this.refreshSession();
      return;
    }
    if (!this.connecting) this.connecting = (async () => {
      if (this.headless) {
        let storageState;
        try { storageState = JSON.parse(fs.readFileSync(this.storagePath, "utf8")); }
        catch { throw new Error("Saved ChatGPT session is missing or invalid. Run image-gen login first."); }
        if (!storageState.cookies?.some(cookie => /session-token/i.test(cookie.name))) {
          throw new Error("Saved ChatGPT session has no login. Run image-gen login first.");
        }
        this.browser = await this.browserType.launch({ channel: "msedge", headless: true, chromiumSandbox: true });
        try {
          let userAgent = storageState.image_gen_user_agent;
          if (!userAgent) {
            const session = await this.browser.newBrowserCDPSession();
            try { userAgent = (await session.send("Browser.getVersion")).userAgent.replace("HeadlessChrome/", "Chrome/"); }
            finally { await session.detach(); }
          }
          this.context = await this.browser.newContext({ storageState: { cookies: storageState.cookies, origins: storageState.origins || [] }, userAgent });
          this.storageMtime = fs.statSync(this.storagePath).mtimeMs;
        } catch (error) { await this.browser.close(); this.browser = null; throw error; }
      } else {
        if (this.cdpUrl === CDP_URL) await ensureEdgeWithCdp();
        this.browser = await this.browserType.connectOverCDP(this.cdpUrl, { timeout: 15_000 });
        this.context = this.browser.contexts()[0] || await this.browser.newContext();
      }
    })().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  async refreshSession() {
    // Login can refresh the backup while this daemon remains alive. Do not
    // replace cookies underneath active generations or destroy existing tabs.
    if ([...this.operations.values()].some(operation => !operation.settled)) return;
    const stat = fs.statSync(this.storagePath, { throwIfNoEntry: false });
    if (!stat || stat.mtimeMs === this.storageMtime) return;
    const state = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
    if (Array.isArray(state.cookies)) await this.context.addCookies(state.cookies);
    this.storageMtime = stat.mtimeMs;
  }

  async targetId(page) {
    if (!this.identities.has(page)) {
      const session = await page.context().newCDPSession(page);
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        this.identities.set(page, targetInfo.targetId);
      } finally { await session.detach(); }
    }
    return this.identities.get(page);
  }

  async listTabs() {
    await this.connect();
    const tabs = [];
    for (const page of this.context.pages()) {
      if (page.isClosed() || !isChatGpt(page.url())) continue;
      try {
        const tab_id = await this.targetId(page);
        const name = this.managed.get(tab_id);
        tabs.push({ tab_id, title: await page.title(), url: page.url(), managed: this.managed.has(tab_id), ...(name ? { name } : {}) });
      } catch (error) { if (!page.isClosed()) throw error; }
    }
    return tabs;
  }

  async createTab({ name } = {}) {
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 120)) throw new Error("Tab name must be a non-empty string up to 120 characters.");
    await this.connect();
    const page = await this.context.newPage();
    try {
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      const tab_id = await this.targetId(page);
      this.managed.set(tab_id, name?.trim() || "");
      return { tab_id, title: await page.title(), url: page.url(), managed: true, ...(name ? { name: name.trim() } : {}) };
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  async findPage(tabId) {
    await this.connect();
    for (const page of this.context.pages()) {
      if (page.isClosed()) continue;
      if (await this.targetId(page) !== tabId) continue;
      if (!isChatGpt(page.url())) throw new Error("Selected tab has navigated away from ChatGPT.");
      return page;
    }
    throw new Error("Selected tab is closed or its target no longer exists.");
  }

  async run(job, { signal, onStage = () => {} } = {}) {
    if (signal?.aborted) throw new Error("Generation cancelled.");
    const page = await this.findPage(job.tab_id);
    if ([...this.operations.values()].some(operation => !operation.settled && operation.tabId === job.tab_id)) throw new Error("Selected tab already has a running job.");
    if (await isPageBusy(page)) throw new Error("Selected tab is busy with an existing generation.");
    if ([...this.operations.values()].some(operation => !operation.settled && operation.tabId === job.tab_id)) throw new Error("Selected tab already has a running job.");
    let resolveSubmission;
    const operation = {
      tabId: job.tab_id, page, stage: "preparing", submitted: false, attempted: false, settled: false,
      submissionSettled: new Promise(resolve => { resolveSubmission = resolve; }),
    };
    this.operations.set(job.job_id, operation);
    try {
      const saved = await generateOnPage(page, job.prompt, job.artifact_path, {
        transparent: job.transparent_background ?? false,
        referenceImages: job.reference_images || [], signal,
        onStage: (stage, details) => {
          operation.stage = stage;
          if (details?.generation) operation.generation = details.generation;
          if (stage === "sending") operation.attempted = true;
          if (stage === "submitted") { operation.submitted = true; resolveSubmission(); }
          onStage(stage);
        },
      });
      if (signal?.aborted) throw new Error("Generation cancelled.");
      const buffer = fs.readFileSync(saved);
      const png = PNG.sync.read(buffer);
      return { artifact_path: saved, bytes: buffer.length, width: png.width, height: png.height,
        sha256: createHash("sha256").update(buffer).digest("hex") };
    } finally {
      operation.settled = true;
      resolveSubmission();
      // Abort can settle run() before the engine calls cancel(). Retain ownership.
      if (!signal?.aborted) this.operations.delete(job.job_id);
      for (const [id, old] of this.operations) {
        if (this.operations.size <= 100) break;
        if (old.settled && id !== job.job_id) this.operations.delete(id);
      }
    }
  }

  async cancel(job) {
    const operation = this.operations.get(job.job_id);
    if (!operation) return;
    try {
      // A click already in flight must settle before deciding whether a response
      // exists. Otherwise cancellation could acknowledge before a late send.
      if (operation.stage === "submitting" || operation.stage === "sending") await operation.submissionSettled;
      if ((!operation.submitted && !operation.attempted) || operation.page.isClosed()) return;
      const page = operation.page;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (page.isClosed()) return;
        if (!isChatGpt(page.url())) throw new Error("Cannot safely stop a job after its tab navigated away.");
        const state = await inspectGeneration(page, operation.generation);
        if (state.found && state.complete && state.terminal_evidence) return;
        if (state.found && !state.is_latest) throw new Error("Another request now owns the tab; it was not stopped.");
        const stop = page.locator(STOP_SELECTOR).first();
        if (state.found && await stop.isVisible()) {
          await stop.click({ timeout: 3000 });
          // Acknowledgement is the owned response becoming complete, not merely
          // a successful click. Continue checking the same turn identity.
        }
        await page.waitForTimeout(150);
      }
      throw new Error("The current response could not be confirmed stopped. The tab remains busy.");
    } finally { this.operations.delete(job.job_id); }
  }

  async close() {
    if (this.ownsConnection && this.browser?.isConnected()) await this.browser.close();
    this.browser = null;
    this.connecting = null;
  }
}
