import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BrowserDriver } from "../../browser-driver.mjs";

test("generation launches isolated headless Edge with saved login and refreshes it without replacing tabs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-headless-"));
  const storagePath = path.join(dir, "state.json");
  const state = { cookies: [{ name: "session-token", value: "synthetic" }], origins: [], image_gen_user_agent: "saved-login-agent" };
  fs.writeFileSync(storagePath, JSON.stringify(state));
  let launchOptions, contextOptions, refreshed, closed = false, releaseContext;
  const contextGate = new Promise(resolve => { releaseContext = resolve; });
  const context = { addCookies: async cookies => { refreshed = cookies; } };
  const browser = { isConnected: () => !closed, newContext: async options => { contextOptions = options; await contextGate; return context; }, close: async () => { closed = true; } };
  const browserType = { launch: async options => { launchOptions = options; return browser; }, connectOverCDP: () => { throw new Error("must never attach to visible login browser"); } };
  const driver = new BrowserDriver({ browserType, storagePath, headless: true });
  try {
    const first = driver.connect();
    await new Promise(resolve => setImmediate(resolve));
    const second = driver.connect();
    releaseContext();
    await Promise.all([first, second]);
    assert.deepEqual(launchOptions, { channel: "msedge", headless: true, chromiumSandbox: true });
    assert.deepEqual(contextOptions.storageState, { cookies: state.cookies, origins: state.origins });
    assert.equal(contextOptions.userAgent, state.image_gen_user_agent);
    const next = { ...state, cookies: [{ name: "session-token", value: "refreshed" }] };
    fs.writeFileSync(storagePath, JSON.stringify(next));
    fs.utimesSync(storagePath, new Date(), new Date(Date.now() + 2000));
    await driver.connect();
    assert.deepEqual(refreshed, next.cookies);
    assert.equal(driver.context, context);
    await driver.close();
    assert.equal(closed, true);
  } finally { fs.rmSync(storagePath); fs.rmdirSync(dir); }
});

test("missing headless session fails with login instruction without opening any browser", async () => {
  let launches = 0;
  const driver = new BrowserDriver({ storagePath: path.join(os.tmpdir(), "missing-state-" + Date.now()), headless: true,
    browserType: { launch: () => { launches++; } } });
  await assert.rejects(driver.connect(), /image-gen login/);
  assert.equal(launches, 0);
});
