# image-gen: CLI + MCP

This fork adds a shared local coordinator, explicit tabs, async jobs and parallel generation. **Generation uses headless Edge by default.** The visible dedicated browser is used for login.

## Setup

Requires Node.js 18+, Microsoft Edge, and a ChatGPT account with image generation.

```sh
git clone https://github.com/ART1KZ/image-gen.git
cd image-gen
npm install
npm run login
```

Complete login until the composer appears. The script saves `chatgpt-storage.json`; afterward you can close the window. Generation launches a separate headless Edge with the saved session and login User-Agent. Your daily browser remains separate. If login expires, run login again. Keep the gitignored session file and `edge-auth-profile/` private.

## CLI

```sh
node cli.mjs tabs list --json
node cli.mjs tabs create --name illustrations --json
node cli.mjs generate --prompt "A blue origami whale" --output ./whale.png
node cli.mjs generate --prompt "A red lighthouse" --new-tab --async --json
node cli.mjs generate --prompt "Make it smaller" --tab TAB_ID --output ./small.png
node cli.mjs jobs list --json
node cli.mjs jobs get JOB_ID --json
node cli.mjs jobs wait JOB_ID --json
node cli.mjs jobs cancel JOB_ID --json
```

Use `image-gen` after installing/linking this package, or `node cli.mjs` from the checkout. Generation creates a new managed tab unless `--tab` selects a stable ID. Reuse a tab for edits in the same conversation. Headless tabs are listed through CLI/MCP, not as desktop windows. Closed or unrelated tabs fail without silently switching targets.

Two jobs in different tabs can run simultaneously by default. The same tab has a FIFO queue shared by every CLI/MCP client. Each job owns an immutable artifact and reserves its active output path. A later export cannot change an earlier job's inline result.

Use `--async` to get an ID immediately, repeated `--reference-image /absolute/path.png` for references, and `--transparent-background` for alpha. Output alternatives: `--output-dir`, `--filename`.

Statuses: queued, running, succeeded, failed, cancelled. A running cancellation has `cancel_requested: true` until the browser confirms the owned response stopped. Failure to confirm produces an error. Interrupted jobs fail on coordinator restart and are never replayed automatically.

## MCP

Register an absolute entrypoint path:

```json
{"mcpServers":{"image-gen":{"command":"node","args":["C:/Users/YOU/image-gen/mcp-server.mjs"]}}}
```

Reconnect clients after upgrading; old processes retain old code.

| Tool | Purpose |
|---|---|
| list_tabs / create_tab | List stable IDs or create a named tab |
| start_generation | Start once and return a job ID |
| get_job / list_jobs | Inspect progress and outputs |
| wait_job | Wait a bounded interval; may return an unfinished job |
| cancel_job | Request cancellation |
| generate_image | Compatible synchronous generation, inline PNG and alpha report |

Legacy parameters remain: prompt, filename, output_dir, transparent_background, reference_images. Explicit tab selection is also supported. Async start supports output_path. Relative paths resolve against the calling client's working directory.

For parallel assets, start jobs in separate tabs and wait for their IDs. To refine an asset, use its tab_id. Inspect a slow job rather than automatically duplicating it. Copy `skills/chatgpt-image-gen/` into your agent's skills directory for the bundled workflow.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| IMAGE_GEN_HEADLESS | 1 | Set 0 to attach to visible Edge for debugging |
| IMAGE_GEN_MAX_PARALLEL | 2 | Coordinator concurrency |
| IMAGE_GEN_PROFILE_DIR | checkout edge-auth-profile | Login profile and coordinator identity |
| IMAGE_GEN_CDP_PORT | 9222 | Visible login/debug endpoint |
| IMAGE_GEN_STORAGE_STATE | checkout chatgpt-storage.json | Saved session and login User-Agent |
| IMAGE_GEN_STATE_DIR | user-local image-gen directory | State/artifacts base |
| IMAGE_GEN_CHATGPT_EMAIL | optional | Preferred account-picker email |

The daemon starts lazily, detached with no terminal window. Browser mode and capacity apply at daemon startup, not per request. `--headed` is a debugging startup option. Share profile/state settings across clients; changing only the state directory does not create a new browser namespace.

Local IPC uses an authenticated Windows named pipe or Unix socket and a private credential, with no HTTP endpoint. State contains prompts and paths. Artifacts currently have no automatic retention cleanup.

## Image correctness and transparency

Only the exact prompt's new completed response is eligible. The image URL must stabilize before download. Ambiguity or timeout fails instead of substituting an older result. Transparent requests return TRANSPARENCY_REPORT and a checkerboard .preview.png. A soft bottom shadow can be valid alpha: inspect the report instead of repeatedly regenerating.

## Verification and troubleshooting

```sh
npm test
npm run test:browser
```

Default tests use fake drivers and local IPC: no login, browser or image spending. Browser fixtures use a separate context in the dedicated CDP browser and routed synthetic pages. `test/live/verify.mjs` is an explicit opt-in test that spends three image generations.

Missing/expired login: run login until the composer appears. Browser challenges: refresh login in the visible window; diagnose with a fresh headed coordinator. Rate limits still apply. Updating from v2 requires reconnecting every MCP client before cross-client scheduling applies.

Windows is verified. Unix IPC is implemented; browser/login support on other platforms needs separate verification. ChatGPT DOM changes can require selector updates.

[MIT](./LICENSE). Fork of [nothariharan/image-gen](https://github.com/nothariharan/image-gen). Not affiliated with OpenAI, Microsoft, or Anthropic.
