import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import * as generation from "../generate.mjs";

let browser;
let context;
before(async () => {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  context = await browser.newContext();
});
after(async () => { await context?.close(); await browser?.close(); });

test("submits through the enabled send button when Enter does not submit", async () => {
  const page = await context.newPage();
  try {
    await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
    await page.goto("https://chatgpt.com/");
    await page.setContent(`<form>
      <div contenteditable="true" role="textbox">leftover draft</div>
      <button type="submit" aria-label="Отправить" disabled>Send</button>
      <script>
        const editor = document.querySelector('[contenteditable]');
        const send = document.querySelector('button');
        editor.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
        editor.addEventListener('input', () => setTimeout(() => { send.disabled = false; }, 100));
        document.querySelector('form').addEventListener('submit', event => {
          event.preventDefault(); document.body.dataset.submitted = editor.textContent;
        });
      </script>
    </form>`);
    assert.equal(typeof generation.submitPrompt, "function", "prompt submission must wait for the send button");
    await generation.submitPrompt(page, "Create a yellow boat");
    assert.equal(await page.evaluate(() => document.body.dataset.submitted), "Create a yellow boat");
  } finally { await page.close(); }
});
