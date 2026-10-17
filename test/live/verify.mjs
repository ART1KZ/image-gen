// Explicit account-spending smoke test. Never included in npm test.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { startCoordinator } from "../../coordinator-server.mjs";
import { request } from "../../coordinator-client.mjs";

if (process.env.IMAGE_GEN_LIVE_TEST !== "1" || !process.env.IMAGE_GEN_LIVE_OUTPUT_DIR) {
  throw new Error("Opt in with IMAGE_GEN_LIVE_TEST=1 and an absolute IMAGE_GEN_LIVE_OUTPUT_DIR. This spends three image generations.");
}
assert.ok(path.isAbsolute(process.env.IMAGE_GEN_LIVE_OUTPUT_DIR));
const output = process.env.IMAGE_GEN_LIVE_OUTPUT_DIR;
await fs.mkdir(output, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "image-gen-live-"));
const env = { ...process.env, IMAGE_GEN_PROFILE_DIR: path.join(scratch, "isolated-namespace"), IMAGE_GEN_STATE_DIR: scratch, IMAGE_GEN_MAX_PARALLEL: "2" };
const coordinator = await startCoordinator({ env });
assert.ok(coordinator, "live test must own its isolated coordinator");
const rpc = (method, params = {}) => request(method, params, { env, autoStart: false, timeoutMs: 45000 });
const wait = async job => {
  for (;;) {
    job = await rpc("wait_job", { job_id: job.job_id, timeout_ms: 30000 });
    console.log(JSON.stringify({ job_id: job.job_id, status: job.status, stage: job.stage }));
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      assert.equal(job.status, "succeeded", job.error || "generation failed");
      return job;
    }
  }
};
try {
  const nonce = randomUUID().slice(0, 8);
  const prompts = [
    "Generate exactly one image: a bright blue origami whale on a plain white background, centered, clean paper sculpture, no letters or text.",
    "Generate exactly one image: a red lighthouse on a rocky island at sunset, orange sky, centered, watercolor illustration, no letters or text.",
  ];
  const starts = await Promise.all(prompts.map((prompt, i) => rpc("start_generation", { prompt,
    output_path: path.join(output, `live-${nonce}-${i}.png`) })));
  assert.notEqual(starts[0].tab_id, starts[1].tab_id);
  const first = await Promise.all(starts.map(wait));
  assert.ok(Math.max(...first.map(j => Date.parse(j.started_at))) < Math.min(...first.map(j => Date.parse(j.finished_at))), "jobs must overlap");
  assert.notEqual(first[0].result.sha256, first[1].result.sha256);
  const third = await wait(await rpc("start_generation", { tab_id: first[0].tab_id,
    prompt: "Generate exactly one NEW image instead: a yellow ceramic teapot on a deep violet background, centered, studio product photo, no letters or text.",
    output_path: path.join(output, `live-${nonce}-2.png`) }));
  const jobs = [...first, third];
  for (const job of jobs) {
    const [artifact, exported] = await Promise.all([fs.readFile(job.artifact_path), fs.readFile(job.output_path)]);
    assert.deepEqual(exported, artifact);
    assert.equal(createHash("sha256").update(artifact).digest("hex"), job.result.sha256);
  }
  assert.equal(new Set(jobs.map(j => j.result.sha256)).size, 3);
  await fs.writeFile(path.join(output, `live-${nonce}-report.json`), JSON.stringify({ headless: true, overlap: true, jobs }, null, 2));
  console.log(JSON.stringify({ success: true, overlap: true, outputs: jobs.map(j => j.output_path) }));
} finally { await coordinator.close(); }
