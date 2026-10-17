/**
 * Verify the generation browser and saved login without spending an image.
 */
import { BrowserDriver } from "./browser-driver.mjs";
import { ensureChatGptLoggedIn } from "./generate.mjs";

const driver = new BrowserDriver();
try {
  const tab = await driver.createTab();
  const page = await driver.findPage(tab.tab_id);
  await ensureChatGptLoggedIn(page, { waitForManual: false, persistSession: false, restoreSession: false });
  console.log(`Connected: ${driver.headless ? "headless" : "visible"} Edge; ChatGPT session ready.`);
} catch (error) {
  console.error(`Connection check failed: ${error.message}`);
  process.exitCode = 1;
} finally { await driver.close(); }
