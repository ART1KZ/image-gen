import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawn } from "node:child_process";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-queue-"));
process.env.IMAGE_GEN_LOCK_PATH = path.join(tempDir, "queue.lock");
process.env.IMAGE_GEN_LOCK_WAIT_MS = "80";
process.env.IMAGE_GEN_LOCK_STALE_MS = "1000";
const { acquireGenerateLock, releaseGenerateLock } = await import("../queue.mjs");
const lockPath = process.env.IMAGE_GEN_LOCK_PATH;
after(() => { fs.rmSync(lockPath, { force: true }); fs.rmdirSync(tempDir); });

test("never removes an aged lock while its owner is still alive", async () => {
  const lock = JSON.stringify({ pid: process.pid, at: Date.now() - 60_000, token: "other-job" });
  fs.writeFileSync(lockPath, lock);
  await assert.rejects(acquireGenerateLock(), /Timed out/);
  assert.equal(fs.existsSync(lockPath), true, "the active owner's lock must remain");
  assert.equal(fs.readFileSync(lockPath, "utf8"), lock);
  fs.unlinkSync(lockPath);
});

test("does not delete a freshly created lock before its metadata is written", async () => {
  fs.writeFileSync(lockPath, "");
  await assert.rejects(acquireGenerateLock(), /Timed out/);
  assert.equal(fs.existsSync(lockPath), true, "initializing lock must remain");
  fs.unlinkSync(lockPath);
});

test("release without ownership leaves an initializing lock alone", () => {
  fs.writeFileSync(lockPath, "");
  releaseGenerateLock();
  assert.equal(fs.existsSync(lockPath), true);
  fs.unlinkSync(lockPath);
});

test("does not release another job's token even if it has the same PID", async () => {
  await acquireGenerateLock();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "replacement-owner" }));
  releaseGenerateLock();
  assert.equal(fs.existsSync(lockPath), true);
  fs.unlinkSync(lockPath);
});

test("serializes two independent agent processes and releases the lock", async () => {
  const eventsPath = path.join(tempDir, "events.jsonl");
  const worker = `
    import fs from "node:fs";
    const { withGenerateQueue } = await import(process.argv[1]);
    await withGenerateQueue(async () => {
      fs.appendFileSync(process.argv[2], JSON.stringify({pid:process.pid,event:"start"})+"\\n");
      await new Promise(resolve => setTimeout(resolve, 1200));
      fs.appendFileSync(process.argv[2], JSON.stringify({pid:process.pid,event:"end"})+"\\n");
    });
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker, new URL("../queue.mjs", import.meta.url).href, eventsPath], {
      env: { ...process.env, IMAGE_GEN_LOCK_WAIT_MS: "5000", IMAGE_GEN_LOCK_STALE_MS: "100" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  try {
    await Promise.all([run(), run()]);
    const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(row => row.event), ["start", "end", "start", "end"]);
    assert.equal(events[0].pid, events[1].pid);
    assert.notEqual(events[0].pid, events[2].pid);
    assert.equal(fs.existsSync(lockPath), false);
  } finally { fs.rmSync(eventsPath, { force: true }); }
});
