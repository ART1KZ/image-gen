import fs from 'node:fs/promises';
import { request as coordinatorRequest } from './coordinator-client.mjs';
import { buildTransparencyReport } from './transparency.mjs';

const generationProperties = {
  prompt: { type: 'string', minLength: 1, description: 'Detailed image prompt, including subject, style and composition.' },
  tab_id: { type: 'string', minLength: 1, description: 'Reuse this exact ChatGPT tab. Omit to create a fresh dedicated tab.' },
  new_tab: { type: 'boolean', description: 'Create a fresh dedicated tab. Conflicts with tab_id when true.' },
  output_path: { type: 'string', minLength: 1, description: 'Exact PNG export path. Conflicts with output_dir and filename.' },
  output_dir: { type: 'string', minLength: 1, description: 'Export directory; defaults to the client working directory.' },
  filename: { type: 'string', minLength: 1, description: 'Basename, with or without .png. Default: generated_<job_id>.png.' },
  transparent_background: { type: 'boolean', description: 'Request a transparent cutout. Soft bottom shadows are normal; use the measured transparency report.' },
  reference_images: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 }, description: 'Local reference image paths to attach to this job.' },
};
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const lookupProperties = { job_id: { type: 'string', minLength: 1, description: 'Previously accepted job identifier.' } };

export const TOOL_DEFINITIONS = [
  { name: 'generate_image', description: 'Generate an image using the shared local ChatGPT browser coordinator. Waits for this job and returns its PNG, immutable artifact path, export path and TRANSPARENCY_REPORT. Transparent pixels can look black in dark viewers; trust TRANSPARENT_OK and the checkerboard preview. Do not regenerate for a soft bottom shadow alone. For long-running or parallel work, use start_generation and job tools. If login is missing, run image-gen login.', inputSchema: schema(generationProperties, ['prompt']) },
  { name: 'list_tabs', description: 'List stable ChatGPT tab IDs, titles, URLs and managed status.', inputSchema: schema() },
  { name: 'create_tab', description: 'Create a dedicated ChatGPT tab, optionally assigning a name.', inputSchema: schema({ name: { type: 'string', minLength: 1, maxLength: 200 } }) },
  { name: 'start_generation', description: 'Accept an asynchronous image job and return immediately. Different tabs can run concurrently; the same tab runs FIFO. Without a target, a fresh dedicated tab is created.', inputSchema: schema(generationProperties, ['prompt']) },
  { name: 'get_job', description: 'Read one accepted job and its exact status, paths, result or error.', inputSchema: schema(lookupProperties, ['job_id']) },
  { name: 'list_jobs', description: 'List persisted jobs owned by the shared coordinator.', inputSchema: schema() },
  { name: 'wait_job', description: 'Wait up to timeout_ms for a job. May return unfinished; call again without resubmitting the prompt.', inputSchema: schema({ ...lookupProperties, timeout_ms: { type: 'integer', minimum: 0, maximum: 30000, default: 30000 } }, ['job_id']) },
  { name: 'cancel_job', description: 'Cancel a queued job or request cancellation of its own running response. A running job retains its slot until stopping is acknowledged.', inputSchema: schema(lookupProperties, ['job_id']) },
];

export const isTerminalJob = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);

/** Bounded IPC waits repeat; the prompt is never submitted again. */
export async function waitForJob(initialJob, { request = coordinatorRequest, requestOptions = {}, onUpdate = () => {} } = {}) {
  let job = initialJob;
  while (!isTerminalJob(job)) {
    job = await request('wait_job', { job_id: initialJob.job_id, timeout_ms: 30000 }, requestOptions);
    onUpdate(job);
  }
  return job;
}

export function createToolService({ request = coordinatorRequest, requestOptions = {} } = {}) {
  const names = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  return {
    listTools() { return { tools: TOOL_DEFINITIONS }; },
    async callTool(name, args = {}) {
      let acceptedJob;
      try {
        if (!names.has(name)) throw new Error(`Unknown tool: ${name}`);
        if (name !== 'generate_image') {
          const value = await request(name, args, requestOptions);
          const structuredContent = name === 'list_tabs' ? { tabs: value } : name === 'list_jobs' ? { jobs: value } : value;
          return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent };
        }
        acceptedJob = await request('start_generation', args, requestOptions);
        const job = await waitForJob(acceptedJob, { request, requestOptions });
        if (job.status !== 'succeeded') throw new Error(`Job ${job.job_id} ${job.status}: ${job.error || 'Generation did not complete'}`);
        const artifact = job.result?.artifact_path;
        if (typeof artifact !== 'string' || !artifact) throw new Error('Successful job has no immutable artifact_path');
        // Never reread output_path: another completed job can replace that export.
        const { text, previewPath, report } = buildTransparencyReport(artifact, { wantedTransparent: args.transparent_background === true });
        const bytes = await fs.readFile(previewPath || artifact);
        return {
          content: [
            { type: 'text', text: `Job: ${job.job_id}\nTab: ${job.tab_id}\nImage exported to: ${job.output_path}\n\n${text}` },
            { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
          ],
          structuredContent: { ...job, transparency: report },
          _meta: { job_id: job.job_id, tab_id: job.tab_id, artifact_path: artifact, output_path: job.output_path,
            verdict: report.verdict, softBottomVignette: report.softBottomVignette, doNotRegenerateForSoftShadow: report.verdict !== 'OPAQUE_BAKED_BACKGROUND' },
        };
      } catch (error) {
        const message = error.message || 'Tool failed';
        return { content: [{ type: 'text', text: `Error: ${message}${acceptedJob ? `\nJob: ${acceptedJob.job_id}\nUse get_job to inspect this accepted job; do not resubmit it.` : ''}` }], isError: true,
          ...(acceptedJob ? { structuredContent: { job_id: acceptedJob.job_id, tab_id: acceptedJob.tab_id, error: message } } : {}) };
      }
    },
  };
}
