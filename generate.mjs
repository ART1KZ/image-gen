/**
 * generate.mjs — robust ChatGPT image generation over an attached Edge (CDP).
 *
 * Strategy (grounded in ChatGPT's actual 2026 DOM):
 *   The finished image renders as:
 *     <img alt="Generated image: ..." src="https://chatgpt.com/backend-api/estuary/content?id=file_...&sig=...">
 *   - data-testid="generated-image-preview" -> independent of interface language
 *   - alt^="Generated image" -> fallback for the older interface
 *   - src is a SIGNED url (the `sig` query param authorizes it), so it can be
 *     fetched directly from inside the page with no bearer-token handling.
 *
 *   PRIMARY: wait for that <img> to appear, wait until its src STOPS CHANGING
 *     (defeats the preview->final-resolution swap), then fetch the exact src.
 *   Only images belonging to the submitted prompt's new turn are eligible.
 *   A timeout must fail instead of returning an image from an older request.
 *
 *   The /backend-api/conversation stream is parsed ONLY to detect an explicit
 *   refusal so we can fail fast. ChatGPT fires several conversation POSTs per
 *   turn, so "a stream finished" is never treated as "generation finished".
 */

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Port can be overridden with IMAGE_GEN_CDP_PORT (defaults to 9222).
export const CDP_PORT = process.env.IMAGE_GEN_CDP_PORT || "9222";
export const CDP_URL = `http://localhost:${CDP_PORT}`;

/** Dedicated Edge profile — login once here; never mixes with your daily browser. */
export const AUTH_PROFILE_DIR =
  process.env.IMAGE_GEN_PROFILE_DIR || path.join(__dirname, "edge-auth-profile");

/** Cookie/localStorage backup (gitignore). Refresh via: node login-once.mjs */
export const STORAGE_STATE_PATH =
  process.env.IMAGE_GEN_STORAGE_STATE || path.join(__dirname, "chatgpt-storage.json");

const MIN_IMAGE_BYTES = 80 * 1024;   // 80 KB — excludes avatars/icons
const HARD_TIMEOUT_MS = 180_000;     // 3 min absolute ceiling
const SRC_STABLE_MS = 3_000;         // src must be unchanged this long = final
const REFUSAL_MIN_WAIT_MS = 12_000;  // don't honor a refusal read too eagerly
const CDP_LAUNCH_TIMEOUT_MS = 30_000;
const LOGIN_WAIT_MS = 120_000;       // wait for user to finish ChatGPT login once

// ChatGPT's current composer has no id; retain support for the older textarea.
// Ignore hidden legacy fields when both versions exist in the DOM.
const COMPOSER_SELECTOR =
  '#prompt-textarea:visible, [contenteditable="true"][role="textbox"]:visible';
const GENERATED_IMAGE_SELECTOR =
  '[data-testid="generated-image-preview"] img, img[alt^="Generated image"]';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isConversationUrl(url) {
  return (
    url.includes("/backend-api/conversation") ||
    url.includes("/backend-api/f/conversation")
  );
}

function isChromeImage(url) {
  return /avatar|profile|favicon|sprite|emoji|sentinel/i.test(url);
}

/** True if Edge/Chrome is already listening on the CDP port. */
export function cdpReady(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findEdgeExecutable() {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/**
 * Attach-first: if CDP is already up, do nothing (never kill Edge).
 * Otherwise launch a SECOND Edge instance with the dedicated auth profile.
 * Does NOT taskkill your daily browser.
 */
export async function ensureEdgeWithCdp() {
  if (await cdpReady()) {
    console.error(`[image-gen] Attaching to existing browser on :${CDP_PORT}`);
    return;
  }

  if (process.platform !== "win32") {
    throw new Error(
      `Cannot connect to a browser on port ${CDP_PORT}. ` +
      `Start Chrome/Edge with --remote-debugging-port=${CDP_PORT} --remote-allow-origins=* ` +
      `--user-data-dir=<auth-profile> (see login-once.mjs)`,
    );
  }

  const edge = findEdgeExecutable();
  if (!edge) {
    throw new Error("Microsoft Edge not found. Install Edge, then retry.");
  }

  fs.mkdirSync(AUTH_PROFILE_DIR, { recursive: true });
  console.error(
    `[image-gen] No browser on :${CDP_PORT} — launching dedicated auth profile:\n` +
    `  ${AUTH_PROFILE_DIR}`,
  );

  spawn(
    edge,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${AUTH_PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://chatgpt.com",
    ],
    { detached: true, stdio: "ignore" },
  ).unref();

  const deadline = Date.now() + CDP_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await cdpReady(1000)) {
      console.error("[image-gen] Auth-profile Edge CDP is ready.");
      await sleep(2000);
      return;
    }
    await sleep(400);
  }

  throw new Error(
    `Launched auth-profile Edge but port ${CDP_PORT} never opened.\n` +
    `Run once: node login-once.mjs\n` +
    `Or: ${path.join(__dirname, "launch-edge.bat")}`,
  );
}

/** Inject saved cookies if the live profile has no ChatGPT session yet. */
export async function applyStorageState(context) {
  if (!fs.existsSync(STORAGE_STATE_PATH)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, "utf8"));
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    if (!cookies.length) return false;
    await context.addCookies(cookies);
    console.error(`[image-gen] Applied ${cookies.length} cookie(s) from chatgpt-storage.json`);
    return true;
  } catch (err) {
    console.error(`[image-gen] Could not apply storage state: ${err.message}`);
    return false;
  }
}

/** Persist cookies/localStorage after a successful login. */
export async function saveStorageState(context) {
  try {
    const state = await context.storageState();
    const page = context.pages().find(page => page.url().startsWith("https://chatgpt.com/"));
    if (page) state.image_gen_user_agent = await page.evaluate(() => navigator.userAgent);
    fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
    console.error(`[image-gen] Saved session → ${STORAGE_STATE_PATH}`);
  } catch (err) {
    console.error(`[image-gen] Could not save storage state: ${err.message}`);
  }
}

async function hasChatGptSession(page) {
  const cookies = await page.context().cookies("https://chatgpt.com");
  return cookies.some((c) => /session-token/i.test(c.name));
}

async function promptReady(page) {
  try {
    return await page.locator(COMPOSER_SELECTOR).first().isVisible();
  } catch {
    return false;
  }
}

/**
 * ChatGPT often sticks on the "Welcome back / Choose an account" picker.
 * Click the saved account automatically (no password entry).
 */
async function tryClickAccountPicker(page) {
  const preferredEmail =
    process.env.IMAGE_GEN_CHATGPT_EMAIL || "nothariharan@gmail.com";

  const modalVisible = await page
    .getByText(/Choose an account to continue|Welcome back/i)
    .first()
    .isVisible()
    .catch(() => false);

  if (!modalVisible) return false;

  console.error(`[image-gen] Account picker detected — clicking ${preferredEmail}...`);

  // Prefer the known account email.
  const byEmail = page.getByText(preferredEmail, { exact: false }).first();
  if (await byEmail.isVisible().catch(() => false)) {
    await byEmail.click({ timeout: 8_000 }).catch(async () => {
      // Email text may be nested; click its nearest clickable ancestor via JS.
      await page.evaluate((email) => {
        const el = [...document.querySelectorAll("button, [role='button'], a, div")]
          .find((n) => (n.textContent || "").includes(email));
        if (el) el.click();
      }, preferredEmail);
    });
    await sleep(2500);
    return true;
  }

  // Fallback: first visible email-looking account row.
  const anyEmail = page.locator("text=/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/").first();
  if (await anyEmail.isVisible().catch(() => false)) {
    console.error("[image-gen] Preferred email not found — clicking first saved account...");
    await anyEmail.click({ timeout: 8_000 }).catch(() => {});
    await sleep(2500);
    return true;
  }

  // Last resort: click a row that looks like the account card ("awe" name, etc.).
  const clicked = await page.evaluate(() => {
    const root = [...document.querySelectorAll("button, [role='button'], div")]
      .find((n) => /@[\\w.-]+\\.[A-Za-z]{2,}/.test(n.textContent || "") && (n.textContent || "").length < 200);
    if (!root) return false;
    root.click();
    return true;
  });
  if (clicked) {
    await sleep(2500);
    return true;
  }

  return false;
}

/**
 * Ensure ChatGPT is logged in. Auto-clicks the account picker when present.
 * Only waits on the user for real password/OAuth flows that need interaction.
 * Saves chatgpt-storage.json after a successful login.
 */
export async function ensureChatGptLoggedIn(page, { waitForManual = true, persistSession = true, restoreSession = true } = {}) {
  const context = page.context();

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  if (!page.url().includes("chatgpt.com")) {
    await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  // Restore cookies from backup if this profile has no session yet.
  if (restoreSession && !(await hasChatGptSession(page))) {
    const applied = await applyStorageState(context);
    if (applied) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await sleep(1500);
    }
  }

  // Fast path: already logged in with a usable composer.
  if ((await hasChatGptSession(page)) && (await promptReady(page))) {
    await tryClickAccountPicker(page);
    if (await promptReady(page)) {
      if (persistSession) await saveStorageState(context);
      return;
    }
  }

  console.error("[image-gen] Ensuring ChatGPT login (auth profile + account-picker)...");
  await tryClickAccountPicker(page);

  if (!(await hasChatGptSession(page)) && !(await promptReady(page))) {
    const needsLogin = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return /log in|sign up|welcome back|choose an account/i.test(text);
    }).catch(() => true);

    if (needsLogin || page.url().includes("/auth/")) {
      if (!page.url().includes("chatgpt.com") || page.url().includes("/auth/login")) {
        await page.goto("https://chatgpt.com", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        }).catch(() => {});
      }
      await tryClickAccountPicker(page);

      if (!(await hasChatGptSession(page)) && !(await promptReady(page))) {
        const stillPicker = await page
          .getByText(/Choose an account to continue|Welcome back/i)
          .first()
          .isVisible()
          .catch(() => false);
        if (!stillPicker) {
          await page.goto("https://chatgpt.com/auth/login", {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }).catch(() => {});
          await tryClickAccountPicker(page);
        }
      }
    }
  }

  const deadline = Date.now() + (waitForManual ? LOGIN_WAIT_MS : 20_000);
  while (Date.now() < deadline) {
    await tryClickAccountPicker(page);

    if (await hasChatGptSession(page)) {
      if (!page.url().includes("chatgpt.com") || page.url().includes("/auth/")) {
        await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      }
      await tryClickAccountPicker(page);
      const ready = await page
        .waitForSelector(COMPOSER_SELECTOR, { state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (ready) {
        console.error("[image-gen] ChatGPT login ready.");
        if (persistSession) await saveStorageState(context);
        return;
      }
    }

    await sleep(1500);
  }

  throw new Error(
    "ChatGPT login did not complete in the dedicated auth profile.\n" +
    `Run once: node ${path.join(__dirname, "login-once.mjs")}\n` +
    "Log in fully in that Edge window, then retry. Session is saved for next time.",
  );
}

export async function generateOnPage(page, prompt, outputPath, {
  transparent = false, referenceImages = [], signal, onStage = () => {}, validateTab = async () => {},
} = {}) {
  const check = () => { if (signal?.aborted) throw new Error("Generation cancelled."); };
  check();
  const finalPrompt = transparent
    ? `${prompt}. Isolated cutout on a COMPLETELY TRANSPARENT background (alpha), ` +
      `no solid black/white/colored plate, no backdrop box, no vignette fill. ` +
      `A faint contact shadow on the subject is ok; do not fill the canvas behind it.`
    : prompt;

  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });

  onStage("preparing");
  await ensureChatGptLoggedIn(page, { waitForManual: false, persistSession: false, restoreSession: false });
  await validateTab();
  check();

  /** @type {{url: string, buf: Buffer, at: number}[]} */
  const images = [];          // network-captured image bytes (fallback)
  let listening = false;
  let promptSentAt = 0;
  let refusal = null;

  const onResponse = async (resp) => {
    if (!listening) return;
    const url = resp.url();

    // Parse conversation streams ONLY for refusal detection.
    if (isConversationUrl(url) && resp.request().method() === "POST") {
      try {
        const text = await resp.text();
        const hasImage = /image_asset_pointer|estuary\/content|"content_type"\s*:\s*"image/.test(text);
        if (hasImage) {
          refusal = null;
        } else {
          const m = text.match(
            /(I can't[^"\\]{0,140}|I'm not able to[^"\\]{0,140}|can't (?:create|generate)[^"\\]{0,140}|violates[^"\\]{0,140}|content polic[^"\\]{0,140})/i
          );
          if (m) refusal = m[0];
        }
      } catch { /* ignore */ }
      return;
    }

    // Fallback channel: capture real image bytes.
    const ct = (resp.headers()["content-type"] || "").toLowerCase();
    if (ct.startsWith("image/") && !ct.includes("svg") && !isChromeImage(url)) {
      try {
        const buf = await resp.body();
        if (buf.length >= MIN_IMAGE_BYTES) images.push({ url, buf, at: Date.now() });
      } catch { /* ignore */ }
    }
  };

  page.on("response", onResponse);

  try {
    await page.waitForSelector(COMPOSER_SELECTOR, { state: "visible", timeout: 20_000 });
    check();
    // Unblock composer if a prior job left ChatGPT's duplicate-upload dialog open.
    await dismissDuplicateUploadModal(page);

    // Attach reference images BEFORE typing the prompt so ChatGPT sees them as context.
    if (referenceImages.length > 0) {
      onStage("uploading");
      await uploadReferenceImages(page, referenceImages);
      check();
    }

    await validateTab();
    const generation = await captureGenerationBaseline(page, finalPrompt);
    console.error(`[image-gen] Found ${generation.existingImageSrcs.length} pre-existing image(s) — matching only this prompt's new turn.`);

    promptSentAt = Date.now();
    listening = true;

    console.error("[image-gen] Sending prompt...");
    onStage("submitting", { generation });
    await submitPrompt(page, finalPrompt, { signal, conversationPath: generation.conversationPath, onSubmitAttempt: () => onStage("sending", { generation }) });
    // Always publish this acknowledgement before inspecting abort state.
    onStage("submitted", { generation });
    check();

    console.error("[image-gen] Waiting for generated image (up to 3 min)...");
    const deadline = Date.now() + HARD_TIMEOUT_MS;

    const stableSrc = await waitForStableGeneratedImage(page, deadline, generation, () => {
      check();
      if (refusal && Date.now() - promptSentAt > REFUSAL_MIN_WAIT_MS) {
        throw new Error(`ChatGPT refused: ${refusal.trim()}`);
      }
    });

    if (stableSrc) {
      check();
      onStage("downloading");
      console.error("[image-gen] Final image src settled. Fetching exact image...");
      const buf = await fetchInPage(page, stableSrc);
      if (buf && buf.length >= MIN_IMAGE_BYTES) {
        assertValidImage(buf);
        check();
        atomicWriteImage(resolvedOutput, buf);
        console.error(`[image-gen] Saved ${(buf.length / 1024).toFixed(0)} KB -> ${resolvedOutput}`);
        return resolvedOutput;
      }
      // Only an exact response URL from this turn may substitute for a failed fetch.
      const match = images.find((i) => i.url === stableSrc);
      if (match) {
        assertValidImage(match.buf);
        check();
        atomicWriteImage(resolvedOutput, match.buf);
        console.error(`[image-gen] Saved (exact response) ${(match.buf.length/1024).toFixed(0)} KB -> ${resolvedOutput}`);
        return resolvedOutput;
      }
      throw new Error("The current request produced an image, but its exact file could not be downloaded. No older image was substituted.");
    }

    throw new Error(
      refusal ? `ChatGPT refused: ${refusal.trim()}` : "Timed out: no completed image belonging to this request within 3 minutes. No older image was substituted."
    );
  } finally {
    page.off("response", onResponse);
    // Tab stays open — the user controls which chat thread to reuse vs. start fresh.
  }
}

/**
 * Compatible programmatic entry. All callers share coordinator ownership.
 */
export async function generateImage(prompt, outputPath, options = {}) {
  const { request } = await import("./coordinator-client.mjs");
  let job = await request("start_generation", {
    prompt, output_path: path.resolve(outputPath),
    tab_id: options.tab_id, new_tab: options.new_tab,
    transparent_background: options.transparent ?? false,
    reference_images: (options.referenceImages || []).map(file => path.resolve(file)),
  });
  while (job.status === "queued" || job.status === "running") {
    job = await request("wait_job", { job_id: job.job_id, timeout_ms: 30_000 }, { timeoutMs: 35_000 });
  }
  if (job.status !== "succeeded") throw new Error(job.error?.message || job.error || `Generation ${job.status}.`);
  return job.output_path;
}

function atomicWriteImage(destination, buffer) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, buffer, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

/** ChatGPT's "this file was already uploaded" / duplicate-file dialog. */
const DUPLICATE_FILE_MODAL =
  '#modal-duplicate-file, [data-testid="modal-duplicate-file"]';

/**
 * ChatGPT blocks the composer when the same file is attached twice in a thread
 * ("image was already uploaded"). Clear that modal so generation can continue.
 * Prefer labeled buttons / Escape; fall back to removing the overlay from the DOM.
 */
async function dismissDuplicateUploadModal(page) {
  const modal = page.locator(DUPLICATE_FILE_MODAL).first();
  const textHit = page
    .getByText(/already (been )?uploaded|duplicate file|file already exists/i)
    .first();

  const visible =
    (await modal.isVisible().catch(() => false)) ||
    (await textHit.isVisible().catch(() => false));
  if (!visible) return false;

  console.error("[image-gen] Duplicate-upload modal detected — dismissing...");

  const labeled = page
    .locator(`${DUPLICATE_FILE_MODAL} button, [role="dialog"] button`)
    .filter({ hasText: /cancel|close|dismiss|ok|got it|continue|use existing/i });

  if ((await labeled.count()) > 0) {
    await labeled.first().click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await page.waitForTimeout(350);

  // Hard-remove leftover overlay so the composer isn't stuck behind a ghost dialog.
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      const root = el.closest("[data-state='open']") || el.parentElement || el;
      root.remove();
    });
    document.querySelectorAll("[data-state='open'].fixed").forEach((el) => {
      const t = el.textContent || "";
      if (/already (been )?uploaded|duplicate|upload/i.test(t)) el.remove();
    });
  }, DUPLICATE_FILE_MODAL);

  const still =
    (await modal.isVisible().catch(() => false)) ||
    (await textHit.isVisible().catch(() => false));
  if (still) {
    console.error("[image-gen] Warning: duplicate-upload modal may still be present.");
    return false;
  }
  console.error("[image-gen] Duplicate-upload modal dismissed.");
  return true;
}

/**
 * Attaches local image files to the ChatGPT composer as visual references.
 * Uses the hidden file input that backs ChatGPT's attachment button.
 * Missing files are skipped with a warning; errors are non-fatal.
 */
async function uploadReferenceImages(page, imagePaths) {
  // Dedupe so the same path isn't attached twice in one call (triggers ChatGPT's modal).
  const seen = new Set();
  const validPaths = [];
  for (const raw of imagePaths) {
    const p = path.resolve(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    if (!fs.existsSync(p)) {
      console.error(`[image-gen] Skipping missing reference image: ${p}`);
      continue;
    }
    validPaths.push(p);
  }

  if (!validPaths.length) return;

  // Clear a leftover modal from a prior failed attach before we try again.
  await dismissDuplicateUploadModal(page);

  console.error(`[image-gen] Attaching ${validPaths.length} reference image(s)...`);

  // Baseline: count blob-URL previews already on screen so we can detect new ones.
  const beforeCount = await page.evaluate(() =>
    document.querySelectorAll('img[src^="blob:"]').length
  );

  try {
    await page.setInputFiles('input[type="file"]', validPaths);
  } catch (err) {
    console.error(`[image-gen] Warning: could not attach reference images — ${err.message}. Proceeding without them.`);
    await dismissDuplicateUploadModal(page);
    return;
  }

  // Wait for attachment thumbnails OR the duplicate-file modal (same file in this thread).
  const deadline = Date.now() + 10_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    if (await dismissDuplicateUploadModal(page)) {
      // Modal means ChatGPT already has this file — treat as attached and continue.
      confirmed = true;
      break;
    }
    const afterCount = await page.evaluate(() =>
      document.querySelectorAll('img[src^="blob:"]').length
    );
    if (afterCount > beforeCount) {
      confirmed = true;
      break;
    }
  }

  // One more pass in case the modal appeared after the blob preview.
  await dismissDuplicateUploadModal(page);

  if (confirmed) {
    console.error("[image-gen] Reference images attached and previewing in composer.");
  } else {
    console.error("[image-gen] Warning: attachment previews did not appear — proceeding anyway.");
  }
}

const TURN_SELECTOR = '[data-turn-key], article[data-testid^="conversation-turn-"]';
const USER_MESSAGE_SELECTOR = '[data-chatgpt-search-unit-key$=":user"], [data-message-author-role="user"]';

/** Enter can leave a draft when the editor's send state has not caught up yet. */
export async function submitPrompt(page, prompt, { signal, conversationPath, onSubmitAttempt = () => {} } = {}) {
  const check = () => { if (signal?.aborted) throw new Error("Generation cancelled."); };
  check();
  const composer = page.locator(COMPOSER_SELECTOR).first();
  await composer.fill(prompt);
  check();
  const form = composer.locator("xpath=ancestor::form[1]");
  const root = await form.count() ? form : page;
  const send = root.locator('button[data-testid="send-button"]:visible, button[type="submit"]:visible').first();
  // Auto-waiting click() cannot be revoked after an abort. Wait read-only until
  // ready, then check cancellation immediately before the actual click.
  await abortable(send.waitFor({ state: "visible", timeout: 20_000 }), signal);
  const deadline = Date.now() + 20_000;
  while (!(await send.isEnabled())) {
    check();
    if (Date.now() >= deadline) throw new Error("Send button did not become ready.");
    await sleep(100);
  }
  check();
  await abortable(send.click({ trial: true, timeout: 20_000 }), signal);
  const buttonHandle = await abortable(send.elementHandle({ timeout: 1000 }), signal);
  check();
  onSubmitAttempt();
  check();
  try { await buttonHandle.evaluate((button, expectedPath) => {
    if (location.origin !== "https://chatgpt.com") throw new Error("Selected tab navigated away from ChatGPT before submission.");
    if (expectedPath !== undefined && location.pathname !== expectedPath) throw new Error("Selected tab changed conversation before submission.");
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!button.isConnected || button.disabled || !rect.width || !rect.height || !hit || !button.contains(hit)) {
      throw new Error("Send button is no longer actionable.");
    }
    button.click();
  }, conversationPath); } finally { await buttonHandle.dispose(); }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Generation cancelled."));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Capture turn identities as well as URLs: old images can receive new blob URLs. */
export async function captureGenerationBaseline(page, prompt) {
  return page.evaluate(({ turnSelector, imageSelector, prompt }) => {
    const turns = [...document.querySelectorAll(turnSelector)];
    const existingTurnKeys = turns.map(el => el.getAttribute("data-turn-key") || el.getAttribute("data-testid"));
    return {
      prompt,
      existingTurnKeys,
      lastTurnKey: existingTurnKeys.at(-1) || null,
      conversationPath: location.pathname,
      existingImageSrcs: [...document.querySelectorAll(imageSelector)].map(el => el.currentSrc || el.src).filter(Boolean),
    };
  }, { turnSelector: TURN_SELECTOR, imageSelector: GENERATED_IMAGE_SELECTOR, prompt });
}

/** Inspect only the submitted request, including unfinished state for cancellation. */
export async function inspectGeneration(page, generation = null) {
  return page.evaluate(({ imageSelector, turnSelector, userSelector, generation }) => {
    const missing = { found: false, complete: false, is_latest: false, image_srcs: [] };
    const sources = roots => roots.flatMap(root => [...root.querySelectorAll(imageSelector)])
      .filter(el => !el.closest(userSelector))
      .map(el => el.currentSrc || el.src).filter(Boolean);
    if (!generation) return { found: true, complete: true, is_latest: true, image_srcs: sources([document]) };
    if (generation.conversationPath?.startsWith("/c/") && location.pathname !== generation.conversationPath) return missing;

    const turns = [...document.querySelectorAll(turnSelector)];
    const key = el => el.getAttribute("data-turn-key") || el.getAttribute("data-testid");
    const user = el => el.matches(userSelector) ? el : el.querySelector(userSelector);
    const normalize = text => text.replace(/\s+/g, " ").trim();
    const previousKeys = new Set(generation.existingTurnKeys);
    const anchor = generation.lastTurnKey ? turns.findIndex(el => key(el) === generation.lastTurnKey) : -1;
    if (generation.lastTurnKey && anchor < 0) return missing;
    const matches = turns.filter((el, index) => index > anchor && !previousKeys.has(key(el)) &&
      user(el) && normalize(user(el).innerText) === normalize(generation.prompt));
    // Ambiguous repeated/concurrent prompts must not be guessed at.
    if (matches.length !== 1) return missing;

    const target = matches[0];
    let roots;
    if (target.hasAttribute("data-turn-key")) {
      roots = [target];
    } else {
      // Older ChatGPT markup puts user and assistant messages in separate articles.
      roots = [];
      for (let i = turns.indexOf(target) + 1; i < turns.length && !user(turns[i]); i++) roots.push(turns[i]);
    }
    const states = roots.flatMap(root => [root, ...root.querySelectorAll("[data-talvt-turn-state]")])
      .filter(el => el.hasAttribute("data-talvt-turn-state"));
    const terminal_evidence = states.length > 0 && states.every(el => el.getAttribute("data-talvt-turn-state") === "complete");
    const complete = roots.length > 0 && (states.length
      ? states.every(el => el.getAttribute("data-talvt-turn-state") === "complete")
      : !target.hasAttribute("data-turn-key") && !document.querySelector('[data-testid="stop-button"]'));
    const is_latest = (roots.at(-1) || target) === turns.at(-1);
    const previousSources = new Set(generation.existingImageSrcs);
    return { found: true, complete, terminal_evidence, is_latest, turn_key: key(target),
      image_srcs: complete ? sources(roots).filter(src => !previousSources.has(src)) : [] };
  }, { imageSelector: GENERATED_IMAGE_SELECTOR, turnSelector: TURN_SELECTOR, userSelector: USER_MESSAGE_SELECTOR, generation });
}

/** With a generation scope, accept only its new, completed response turn. */
export async function getGeneratedImageSrcs(page, generation = null) {
  return (await inspectGeneration(page, generation)).image_srcs;
}

/**
 * Polls only the submitted prompt's response and returns its image once it
 * has remained unchanged for SRC_STABLE_MS (defeats the preview→final swap).
 * Calls onTick each poll so callers can bail on refusal.
 */
export async function waitForStableGeneratedImage(page, deadline, generation, onTick) {
  let lastSrc = null;
  let stableSince = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.max(0, Math.min(700, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    if (onTick) onTick();

    const newSrcs = await getGeneratedImageSrcs(page, generation);
    const src = newSrcs.length ? newSrcs[newSrcs.length - 1] : null;

    if (!src) {
      lastSrc = null;
      stableSince = 0;
      continue;
    }

    if (src === lastSrc) {
      if (Date.now() - stableSince >= SRC_STABLE_MS) return src;
    } else {
      lastSrc = src;
      stableSince = Date.now();
    }
  }
  return null; // An unstable preview or old image is never a successful result.
}

/** Fetch a URL from inside the page (signed estuary URLs are self-authorizing). */
async function fetchInPage(page, url) {
  try {
    const dataUrl = await page.evaluate(async (u) => {
      const r = await fetch(u);
      if (!r.ok) return null;
      const blob = await r.blob();
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(blob);
      });
    }, url);
    if (!dataUrl) return null;
    return Buffer.from(String(dataUrl).split(",")[1], "base64");
  } catch {
    return null;
  }
}

/** Throw if the buffer is not a PNG/JPEG/WebP raster. */
function assertValidImage(buf) {
  const isPng = buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a";
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isWebp =
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error("Captured data is not a valid image (corrupt or wrong response).");
  }
}
