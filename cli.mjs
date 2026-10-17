#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { request as coordinatorRequest } from './coordinator-client.mjs';
import { waitForJob } from './service-tools.mjs';

const HELP = `Usage:
  image-gen login
  image-gen tabs list [--json]
  image-gen tabs create [--name NAME] [--json]
  image-gen generate --prompt TEXT [--tab ID | --new-tab] [--output PATH]
                     [--output-dir DIR] [--filename NAME] [--reference-image PATH]...
                     [--transparent-background] [--async] [--json] [--headed]
  image-gen jobs list [--json]
  image-gen jobs get|wait|cancel JOB_ID [--json]

Generation waits by default. --async returns the accepted job without waiting.
--headed sets IMAGE_GEN_HEADLESS=0 when starting the coordinator; login is visible.
Omitting a target creates a fresh tab. Progress goes to stderr.
`;
const flagDefinitions = {
  '--prompt': ['prompt', 'value'], '--tab': ['tab_id', 'value'], '--new-tab': ['new_tab', 'boolean'],
  '--output': ['output_path', 'value'], '--output-dir': ['output_dir', 'value'], '--filename': ['filename', 'value'],
  '--name': ['name', 'value'], '--reference-image': ['reference_images', 'repeat'], '--reference': ['reference_images', 'repeat'],
  '--transparent-background': ['transparent_background', 'boolean'], '--transparent': ['transparent_background', 'boolean'],
  '--async': ['async', 'boolean'], '--json': ['json', 'boolean'], '--headed': ['headed', 'boolean'],
};
const generationFlags = ['prompt', 'tab_id', 'new_tab', 'output_path', 'output_dir', 'filename', 'reference_images', 'transparent_background', 'async', 'json', 'headed'];
const allowedFlags = { login: [], 'tabs list': ['json', 'headed'], 'tabs create': ['name', 'json', 'headed'], generate: generationFlags,
  'jobs list': ['json'], 'jobs get': ['json'], 'jobs wait': ['json'], 'jobs cancel': ['json'] };

export function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be strings');
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { command: 'help', params: {}, json: false, async: false, headed: false };
  if (argv.length === 1 && argv[0] === '--version') return { command: 'version', params: {}, json: false, async: false, headed: false };
  const tokens = [...argv];
  let command = tokens.shift();
  if (command === 'tabs' || command === 'jobs') command += ` ${tokens.shift() || ''}`;
  if (!Object.hasOwn(allowedFlags, command)) throw new Error(`Unknown command: ${command}`);
  const params = {}, positional = [], seen = new Set();
  let json = false, asynchronous = false, headed = false;
  while (tokens.length) {
    const token = tokens.shift();
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    const definition = flagDefinitions[flag];
    if (!definition || !allowedFlags[command].includes(definition[0])) throw new Error(`Unknown or unsupported option: ${flag}`);
    const [key, kind] = definition;
    if (kind !== 'repeat' && seen.has(key)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(key);
    let value;
    if (kind === 'boolean') { if (equals >= 0) throw new Error(`${flag} does not take a value`); value = true; }
    else {
      value = equals >= 0 ? token.slice(equals + 1) : tokens.shift();
      if (typeof value !== 'string' || !value.trim() || (equals < 0 && value.startsWith('--'))) throw new Error(`Missing value for ${flag}`);
    }
    if (key === 'json') json = value;
    else if (key === 'async') asynchronous = value;
    else if (key === 'headed') headed = value;
    else if (kind === 'repeat') (params[key] ||= []).push(value);
    else params[key] = value;
  }
  if (['jobs get', 'jobs wait', 'jobs cancel'].includes(command)) {
    if (positional.length !== 1 || !positional[0].trim()) throw new Error('Exactly one JOB_ID is required');
    params.job_id = positional[0];
  } else if (positional.length) throw new Error(`Unexpected argument: ${positional[0]}`);
  if (command === 'generate') {
    if (!params.prompt) throw new Error('--prompt is required');
    if (params.tab_id && params.new_tab) throw new Error('--tab conflicts with --new-tab');
    if (params.output_path && (params.output_dir || params.filename)) throw new Error('--output conflicts with --output-dir or --filename');
  }
  return { command, params, json, async: asynchronous, headed };
}

function defaultLogin({ env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./login-once.mjs', import.meta.url))], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}
function textResult(command, value, asynchronous) {
  if (command === 'tabs list') return value.length ? value.map(tab => `${tab.tab_id}\t${tab.name || tab.title}\t${tab.managed ? 'managed' : 'external'}\t${tab.active_job_id || '-'}\t${tab.url}`).join('\n') : 'No ChatGPT tabs.';
  if (command === 'jobs list') return value.length ? value.map(job => `${job.job_id}\t${job.status}\t${job.tab_id}\t${job.output_path}`).join('\n') : 'No jobs.';
  if (command === 'tabs create') return `Tab: ${value.tab_id}\n${value.url}`;
  if (command === 'generate' && !asynchronous && value.status === 'succeeded') return `Saved image: ${value.output_path}\nJob: ${value.job_id}\nTab: ${value.tab_id}`;
  return `Job: ${value.job_id}\nTab: ${value.tab_id}\nStatus: ${value.status}\nOutput: ${value.output_path}${value.error ? `\nError: ${value.error}` : ''}`;
}

export async function runCli(argv, { request = coordinatorRequest, stdout = process.stdout, stderr = process.stderr, env = process.env, login = defaultLogin } = {}) {
  let parsed;
  try { parsed = parseCliArgs(argv); }
  catch (error) {
    if (argv.includes('--json')) stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    stderr.write(`Error: ${error.message}\nRun image-gen --help for usage.\n`); return 2;
  }
  if (parsed.command === 'help') { stdout.write(HELP); return 0; }
  if (parsed.command === 'version') { stdout.write('3.0.0\n'); return 0; }
  const launchEnv = { ...env, ...(parsed.headed || parsed.command === 'login' ? { IMAGE_GEN_HEADLESS: '0' } : {}) };
  const requestOptions = { env: launchEnv };
  let acceptedJob;
  try {
    if (parsed.command === 'login') return await login({ env: launchEnv });
    const operations = { 'tabs list': 'list_tabs', 'tabs create': 'create_tab', generate: 'start_generation', 'jobs list': 'list_jobs', 'jobs get': 'get_job', 'jobs wait': 'get_job', 'jobs cancel': 'cancel_job' };
    let value = await request(operations[parsed.command], parsed.params, requestOptions);
    if (parsed.command === 'generate') acceptedJob = value;
    if ((parsed.command === 'generate' && !parsed.async) || parsed.command === 'jobs wait') {
      stderr.write(`[image-gen] Job ${value.job_id}: ${value.status}\n`);
      let previous = value.status;
      value = await waitForJob(value, { request, requestOptions, onUpdate: job => { if (job.status !== previous) { stderr.write(`[image-gen] Job ${job.job_id}: ${job.status}\n`); previous = job.status; } } });
    }
    stdout.write(`${parsed.json ? JSON.stringify(value) : textResult(parsed.command, value, parsed.async)}\n`);
    if (((parsed.command === 'generate' && !parsed.async) || parsed.command === 'jobs wait') && value.status !== 'succeeded') {
      stderr.write(`Error: ${value.error || `Job ${value.status}`}\n`); return 1;
    }
    return 0;
  } catch (error) {
    if (parsed.json) stdout.write(`${JSON.stringify({ error: error.message || 'Command failed', ...(acceptedJob ? { job_id: acceptedJob.job_id, tab_id: acceptedJob.tab_id } : {}) })}\n`);
    stderr.write(`Error: ${error.message || 'Command failed'}${acceptedJob ? `\nInspect the accepted job with: image-gen jobs get ${acceptedJob.job_id}` : ''}\n`); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
