import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { randomFillSync, createHash } from "node:crypto";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-driver-"));
process.env.IMAGE_GEN_STORAGE_STATE = path.join(scratch, "auth.json");
const generation = await import("../../generate.mjs");
const { BrowserDriver } = await import("../../browser-driver.mjs").catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
let browser;
let context;
let driver;
const fixture = `<!doctype html><title>ChatGPT test</title><main></main>
  <form><div role="textbox" contenteditable="true"></div><button type="submit" aria-label="Отправить">Send</button></form>
  <script>
    window.submissions = 0; window.stops = 0;
    document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const editor = document.querySelector('[contenteditable]');
      const turn = document.createElement('div');
      turn.dataset.turnKey = 'turn-' + (++window.submissions);
      turn.innerHTML = '<div data-talvt-turn-state="in_progress"><div data-chatgpt-search-unit-key="message:0:user"></div><button type="button" data-testid="stop-button" aria-label="Остановить">Stop</button></div>';
      turn.querySelector('[data-chatgpt-search-unit-key]').textContent = editor.textContent;
      editor.textContent = '';
      turn.querySelector('[data-testid=stop-button]').onclick = () => {
        ++window.stops; turn.querySelector('[data-talvt-turn-state]').dataset.talvtTurnState = 'complete';
        turn.querySelector('[data-testid=stop-button]').remove();
      };
      if (window.delayResponseMs) {
        const state = turn.querySelector('[data-talvt-turn-state]');
        const stop = turn.querySelector('[data-testid=stop-button]');
        state.removeAttribute('data-talvt-turn-state'); stop.remove();
        setTimeout(() => { state.dataset.talvtTurnState = 'in_progress'; state.append(stop); }, window.delayResponseMs);
      }
      document.querySelector('main').append(turn);
    });
  </script>`;

before(async () => {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  context = await browser.newContext();
  await context.addCookies([{ name: "__Secure-next-auth.session-token", value: "synthetic-session", url: "https://chatgpt.com", secure: true }]);
  await context.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: fixture }));
  if (BrowserDriver) driver = new BrowserDriver({ browser, context });
});
after(async () => {
  await driver?.close();
  await context?.close();
  await browser?.close();
  for (const file of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, file));
  fs.rmdirSync(scratch);
});

test("exposes a page-bound generation pipeline", () => {
  assert.equal(typeof generation.generateOnPage, "function");
  assert.equal(typeof BrowserDriver, "function");
});

test("tab identifiers survive unrelated tab creation and closure", async () => {
  assert.ok(driver, "browser driver is required");
  const a = await driver.createTab({ name: "one" });
  const b = await driver.createTab({ name: "two" });
  assert.notEqual(a.tab_id, b.tab_id);
  assert.equal(a.managed, true);
  const before = await driver.listTabs();
  const temporary = await context.newPage();
  await temporary.close();
  const after = await driver.listTabs();
  assert.deepEqual(after.map(tab => tab.tab_id), before.map(tab => tab.tab_id));
  assert.equal(after.find(tab => tab.tab_id === a.tab_id).name, "one");
});

test("missing and non-ChatGPT targets fail without creating a replacement", async () => {
  assert.ok(driver);
  const count = context.pages().length;
  await assert.rejects(driver.run({ job_id: "missing", tab_id: "does-not-exist", prompt: "test", artifact_path: path.join(scratch, "missing.png") }, {}), /tab|target/i);
  const external = await context.newPage();
  await external.goto("data:text/html,external");
  assert.equal((await driver.listTabs()).some(tab => tab.url.startsWith("data:")), false);
  assert.equal(context.pages().length, count + 1);
  await external.close();
});

test("abort before submission writes no artifact and submits no prompt", async () => {
  assert.ok(driver);
  const tab = await driver.createTab({ name: "aborted" });
  const controller = new AbortController();
  controller.abort();
  const output = path.join(scratch, "aborted.png");
  await assert.rejects(driver.run({ job_id: "aborted", tab_id: tab.tab_id, prompt: "test", artifact_path: output }, { signal: controller.signal }), /abort|cancel/i);
  assert.equal(fs.existsSync(output), false);
});

test("cancellation stops only the submitted job's own tab", async () => {
  assert.ok(driver);
  const first = await driver.createTab({ name: "cancel-first" });
  const second = await driver.createTab({ name: "leave-second" });
  const pages = context.pages();
  const other = pages.at(-1);
  await other.locator('[contenteditable]').fill("external generation");
  await other.locator('button[type=submit]').click();
  const controller = new AbortController();
  const job = { job_id: "cancel-first", tab_id: first.tab_id, prompt: "our generation", artifact_path: path.join(scratch, "cancelled.png") };
  let submitted;
  const ready = new Promise(resolve => { submitted = resolve; });
  const run = driver.run(job, { signal: controller.signal, onStage: stage => { if (stage === "submitted") submitted(); } });
  const rejected = assert.rejects(run, /abort|cancel/i);
  await ready;
  controller.abort();
  await driver.cancel(job);
  await rejected;
  assert.equal(await other.evaluate(() => window.stops), 0);
  assert.equal(fs.existsSync(job.artifact_path), false);
  const ours = context.pages().find(page => page !== other && page.url().includes("chatgpt.com") && pages.includes(page) && page === pages.at(-2));
  assert.equal(await ours.evaluate(() => window.stops), 1);
  assert.ok((await driver.listTabs()).some(tab => tab.tab_id === second.tab_id));
});

test("a tab with an external generation is rejected without stopping it", async () => {
  assert.ok(driver);
  const tab = await driver.createTab({ name: "busy" });
  const page = context.pages().at(-1);
  await page.locator('[contenteditable]').fill("someone else's request");
  await page.locator('button[type=submit]').click();
  await assert.rejects(driver.run({ job_id: "busy", tab_id: tab.tab_id, prompt: "ours", artifact_path: path.join(scratch, "busy.png") }, {}), /busy|already.*generat/i);
  assert.equal(await page.evaluate(() => window.submissions), 1);
  assert.equal(await page.evaluate(() => window.stops), 0);
});

test("cancelling while send is disabled never submits a delayed prompt", async () => {
  assert.ok(driver);
  const tab = await driver.createTab({ name: "cancel-delayed-send" });
  const page = context.pages().at(-1);
  await page.evaluate(() => {
    const send = document.querySelector('button[type=submit]');
    send.disabled = true;
    document.querySelector('[contenteditable]').addEventListener('input', () => {
      setTimeout(() => { send.disabled = false; }, 400);
    });
  });
  const controller = new AbortController();
  const job = { job_id: "cancel-delayed-send", tab_id: tab.tab_id, prompt: "must never send", artifact_path: path.join(scratch, "delayed.png") };
  let timer;
  const run = driver.run(job, { signal: controller.signal, onStage: stage => {
    if (stage === "submitting") timer = setTimeout(() => controller.abort(), 60);
  }});
  const rejected = assert.rejects(run, /abort|cancel/i);
  await new Promise(resolve => setTimeout(resolve, 120));
  await driver.cancel(job);
  await rejected;
  clearTimeout(timer);
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("two page-bound pipelines overlap and save their own exact image bytes", async () => {
  assert.ok(driver);
  const tabs = await Promise.all([driver.createTab({ name: "parallel-a" }), driver.createTab({ name: "parallel-b" })]);
  const pages = await Promise.all(tabs.map(tab => driver.findPage(tab.tab_id)));
  const buffers = [0, 1].map(() => {
    const png = new PNG({ width: 192, height: 192 });
    randomFillSync(png.data);
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    return PNG.sync.write(png);
  });
  const submitted = [];
  const ready = [0, 1].map(index => new Promise(resolve => { submitted[index] = resolve; }));
  const jobs = tabs.map((tab, index) => ({ job_id: `parallel-${index}`, tab_id: tab.tab_id, prompt: `Image for page ${index}`, artifact_path: path.join(scratch, `parallel-${index}.png`) }));
  const runs = jobs.map((job, index) => driver.run(job, { onStage: stage => { if (stage === "submitted") submitted[index](); } }));
  await Promise.all(ready);
  assert.equal(await pages[0].locator('[data-testid=stop-button]').count(), 1);
  assert.equal(await pages[1].locator('[data-testid=stop-button]').count(), 1);
  await Promise.all(pages.map((page, index) => page.evaluate(src => {
    const turn = [...document.querySelectorAll('[data-turn-key]')].at(-1);
    const button = document.createElement('button');
    button.dataset.testid = 'generated-image-preview';
    const img = document.createElement('img');
    img.src = src; button.append(img); turn.append(button);
    turn.querySelector('[data-talvt-turn-state]').dataset.talvtTurnState = 'complete';
    turn.querySelector('[data-testid=stop-button]').remove();
  }, `data:image/png;base64,${buffers[index].toString("base64")}`)));
  const results = await Promise.all(runs);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(fs.readFileSync(results[i].artifact_path), buffers[i]);
    assert.equal(results[i].sha256, createHash("sha256").update(buffers[i]).digest("hex"));
  }
  assert.notEqual(results[0].sha256, results[1].sha256);
});

test("cancellation waits for a delayed owned response instead of treating a user-only turn as complete", async () => {
  const tab = await driver.createTab({ name: "delayed-response" });
  const page = await driver.findPage(tab.tab_id);
  await page.evaluate(() => { window.delayResponseMs = 500; });
  const controller = new AbortController();
  const job = { job_id: "delayed-response", tab_id: tab.tab_id, prompt: "delayed response", artifact_path: path.join(scratch, "delay-response.png") };
  let submitted;
  const ready = new Promise(resolve => { submitted = resolve; });
  const run = driver.run(job, { signal: controller.signal, onStage: stage => { if (stage === "submitted") submitted(); } });
  const rejected = assert.rejects(run, /abort|cancel/i);
  await ready; controller.abort();
  let acknowledged = false;
  const cancelling = driver.cancel(job).then(() => { acknowledged = true; });
  await page.waitForTimeout(100);
  assert.equal(acknowledged, false, "a user-only turn is not a completed response");
  await cancelling; await rejected;
  assert.equal(await page.evaluate(() => window.stops), 1);
});

test("an overlay actionability wait cannot send a prompt after abort", async () => {
  const tab = await driver.createTab({ name: "overlay-send" });
  const page = await driver.findPage(tab.tab_id);
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'test-overlay'; overlay.style = 'position:fixed;inset:0;z-index:999;background:white';
    document.body.append(overlay);
    setTimeout(() => overlay.remove(), 400);
  });
  const controller = new AbortController();
  const sent = generation.submitPrompt(page, "must not send after abort", { signal: controller.signal });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(sent, /abort|cancel/i);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("a replaced send button cannot revive a detached submission after cancellation", async () => {
  const tab = await driver.createTab({ name: "replacement-send" });
  const page = await driver.findPage(tab.tab_id);
  const controller = new AbortController();
  const sent = generation.submitPrompt(page, "never submit a replacement", {
    signal: controller.signal,
    onSubmitAttempt: () => {
      void page.evaluate(() => {
        const send = document.querySelector('button[type=submit]');
        const replacement = send.cloneNode(true);
        send.remove();
        setTimeout(() => document.querySelector('form').append(replacement), 250);
      });
      setTimeout(() => controller.abort(), 50);
    },
  });
  await assert.rejects(sent, /actionable|detach|cancel/i);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});
