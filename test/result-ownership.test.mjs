import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { captureGenerationBaseline, getGeneratedImageSrcs, waitForStableGeneratedImage } from "../generate.mjs";

let browser;
let context;
before(async () => {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  context = await browser.newContext();
  await context.route("https://example.invalid/**", route => route.abort());
});
after(async () => {
  await context?.close();
  await browser?.close();
});

const prompt = "Create a green cube";
const scope = { prompt, existingTurnKeys: ["old"], lastTurnKey: "old", existingImageSrcs: ["https://example.invalid/old-original.png"] };
function turn(key, text, image, state = "complete") {
  return `<div data-turn-key="${key}"><div data-talvt-turn-state="${state}">
    <div data-chatgpt-search-unit-key="${key}:0:user">${text}</div>
    ${image ? `<button data-testid="generated-image-preview"><img src="https://example.invalid/${image}.png"></button>` : ""}
  </div></div>`;
}

for (const [name, html, expected] of [
  ["ignores a previous turn whose image URL changed", turn("old", "Previous request", "old-reloaded") + turn("ours", prompt, "current"), ["https://example.invalid/current.png"]],
  ["does not substitute the previous image when the new request has no image", turn("old", "Previous request", "old-reloaded") + turn("ours", prompt, null), []],
  ["ignores an image belonging to another prompt", turn("old", "Previous request", null) + turn("ours", prompt, "current") + turn("other", "Create a red car", "foreign"), ["https://example.invalid/current.png"]],
  ["does not return a preview while the response is still generating", turn("old", "Previous request", null) + turn("ours", prompt, "preview", "in_progress"), []],
  ["does not mistake an old identical prompt for this request", turn("old", prompt, "old-reloaded"), []],
  ["accepts a repeated prompt only in a new turn", turn("old", prompt, "old-reloaded") + turn("ours", prompt, "current"), ["https://example.invalid/current.png"]],
  ["excludes generated-looking images attached to a user message", turn("old", "Previous request", null) + `<div data-turn-key="ours"><div data-chatgpt-search-unit-key="ours:0:user">${prompt}<button data-testid="generated-image-preview"><img src="https://example.invalid/upload.png"></button></div></div>`, []],
]) {
  test(name, async () => {
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      assert.deepEqual(await getGeneratedImageSrcs(page, scope), expected);
    } finally {
      await page.close();
    }
  });
}

test("captures the baseline before submission and supports legacy separate message articles", async () => {
  const page = await context.newPage();
  try {
    await page.setContent('<article data-testid="conversation-turn-0"><div data-message-author-role="assistant"><img alt="Generated image" src="https://example.invalid/old.png"></div></article>');
    const baseline = await captureGenerationBaseline(page, prompt);
    await page.evaluate(prompt => {
      document.body.insertAdjacentHTML("beforeend", `<article data-testid="conversation-turn-1"><div data-message-author-role="user">${prompt}</div></article><article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><img alt="Generated image" src="https://example.invalid/new.png"></div></article>`);
    }, prompt);
    assert.deepEqual(await getGeneratedImageSrcs(page, baseline), ["https://example.invalid/new.png"]);
  } finally { await page.close(); }
});

test("times out without returning an older image or an unstable preview", async () => {
  const page = await context.newPage();
  try {
    await page.setContent(turn("old", "Previous request", "old-reloaded") + turn("ours", prompt, "not-stable-yet"));
    assert.equal(await waitForStableGeneratedImage(page, Date.now() + 900, scope), null);
    await page.setContent(turn("old", "Previous request", "old-reloaded") + turn("ours", prompt, null));
    assert.equal(await waitForStableGeneratedImage(page, Date.now() + 80, scope), null);
  } finally { await page.close(); }
});

test("returns the new request's completed stable image", async () => {
  const page = await context.newPage();
  try {
    await page.setContent(turn("old", "Previous request", "old-reloaded") + turn("ours", prompt, "current"));
    assert.equal(await waitForStableGeneratedImage(page, Date.now() + 6000, scope), "https://example.invalid/current.png");
  } finally { await page.close(); }
});
