import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-composer-"));
process.env.IMAGE_GEN_STORAGE_STATE = path.join(tempDir, "session.json");
const { ensureChatGptLoggedIn } = await import("../generate.mjs");
let browser;

before(async () => {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
});

after(async () => {
  // Disconnect the test client without closing the user's browser.
  await browser?.close();
  fs.rmSync(process.env.IMAGE_GEN_STORAGE_STATE, { force: true });
  fs.rmdirSync(tempDir);
});

for (const [name, html] of [
  ["legacy textarea", '<textarea id="prompt-textarea"></textarea>'],
  ["current editable textbox", '<div contenteditable="true" role="textbox" aria-label="Спросить ChatGPT"></div>'],
  ["current textbox rendered after login", '<script>setTimeout(() => { document.body.innerHTML = \'<div contenteditable="true" role="textbox"></div>\'; }, 1500);</script>'],
  ["current textbox beside a hidden legacy field", '<textarea id="prompt-textarea" hidden></textarea><div contenteditable="true" role="textbox"></div>'],
]) {
  test(`recognizes a logged-in session with ${name}`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext();
    try {
      await context.addCookies([{
        name: "__Secure-next-auth.session-token",
        value: "synthetic-test-session",
        url: "https://chatgpt.com",
        secure: true,
      }]);
      await context.route("https://chatgpt.com/**", route => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>${html}</body></html>`,
      }));
      const page = await context.newPage();
      await page.goto("https://chatgpt.com/");
      fs.rmSync(process.env.IMAGE_GEN_STORAGE_STATE, { force: true });

      await ensureChatGptLoggedIn(page, { waitForManual: false });

      assert.ok(fs.existsSync(process.env.IMAGE_GEN_STORAGE_STATE), "session backup should be saved");
      const state = JSON.parse(fs.readFileSync(process.env.IMAGE_GEN_STORAGE_STATE, "utf8"));
      assert.ok(state.cookies.some(cookie => cookie.name.includes("session-token")));
    } finally {
      await context.close();
    }
  });
}
