/**
 * queue.mjs — serialize image generations so only ONE job drives ChatGPT at a time.
 *
 * Cursor/agents often fire multiple generate_image calls in parallel. They all
 * attach to the same Edge CDP session and type into the same composer, which
 * interleaves keystrokes into garbage. This module provides:
 *   1) In-process mutex (same MCP server instance)
 *   2) Cross-process file lock (multiple MCP processes / overlapping clients)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LOCK_PATH =
  process.env.IMAGE_GEN_LOCK_PATH || path.join(__dirname, ".generate.lock");

const LOCK_WAIT_MS = Number(process.env.IMAGE_GEN_LOCK_WAIT_MS || 12 * 60 * 1000);
const LOCK_STALE_MS = Number(process.env.IMAGE_GEN_LOCK_STALE_MS || 6 * 60 * 1000);
const POLL_MS = 350;
let ownedLockToken = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Permission denied still means the owner exists.
    return err.code !== "ESRCH";
  }
}

function readLockMeta() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function tryRemoveStaleLock() {
  try {
    const before = fs.statSync(LOCK_PATH);
    const meta = readLockMeta();
    // Another process may have created the file and not written its JSON yet.
    if (!meta && Date.now() - before.mtimeMs < LOCK_STALE_MS) return;
    // A long login/generation does not give another process ownership.
    if (meta && pidAlive(meta.pid)) return;
    const current = fs.statSync(LOCK_PATH);
    if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.size !== before.size) return;
    fs.unlinkSync(LOCK_PATH);
    console.error("[image-gen] Cleared abandoned queue lock.");
  } catch {
    /* The owner may have released the lock in the meantime. */
  }
}

/** Acquire exclusive lock file. Waits until free or times out. */
export async function acquireGenerateLock() {
  const started = Date.now();
  let loggedWait = false;

  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      const token = randomUUID();
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      ownedLockToken = token;
      if (loggedWait) {
        console.error(
          `[image-gen] Queue lock acquired after ${Math.round((Date.now() - started) / 1000)}s`,
        );
      }
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!loggedWait) {
        console.error(
          "[image-gen] Another generate_image is running — queued (same ChatGPT session cannot run in parallel)",
        );
        loggedWait = true;
      }
      tryRemoveStaleLock();
      await sleep(POLL_MS);
    }
  }

  throw new Error(
    `Timed out after ${Math.round(LOCK_WAIT_MS / 1000)}s waiting for the image-gen queue. ` +
      "Cancel or restart the owning MCP process if it is stuck; do not delete an active job's lock.",
  );
}

export function releaseGenerateLock() {
  if (!ownedLockToken) return;
  try {
    const meta = readLockMeta();
    if (meta?.pid === process.pid && meta.token === ownedLockToken) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    /* ignore */
  } finally {
    ownedLockToken = null;
  }
}

/** In-process FIFO chain so concurrent awaits inside one process stay ordered. */
let chain = Promise.resolve();

/**
 * Run `fn` exclusively — waits for prior jobs in this process AND the file lock.
 */
export function withGenerateQueue(fn) {
  const run = chain.then(async () => {
    await acquireGenerateLock();
    try {
      return await fn();
    } finally {
      releaseGenerateLock();
    }
  });

  // Keep the chain alive even if this job fails.
  chain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}
