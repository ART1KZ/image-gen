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

after(async () => {
  await context?.close();
  await browser?.close();
});

test("finds localized generated previews and legacy images, excluding uploads", async () => {
  const page = await context.newPage();
  try {
    await page.setContent(`
      <img alt="Uploaded reference" src="https://example.invalid/upload.png">
      <button data-testid="generated-image-preview">
        <img alt="Сгенерированное изображение 1" src="https://example.invalid/current.png">
      </button>
      <img alt="Generated image: legacy" src="https://example.invalid/legacy.png">
    `, { waitUntil: "domcontentloaded" });
    assert.equal(typeof generation.getGeneratedImageSrcs, "function", "generation needs a shared image detector");
    assert.deepEqual(await generation.getGeneratedImageSrcs(page), [
      "https://example.invalid/current.png",
      "https://example.invalid/legacy.png",
    ]);
  } finally {
    await page.close();
  }
});
