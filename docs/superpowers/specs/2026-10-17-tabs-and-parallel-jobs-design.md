# Tab selection and parallel image jobs

Status: approved by the user on 2026-10-17. Implementation follows the shared
CLI + MCP coordinator option.

## Goal and constraints

Provide a reliable local image-generation tool for one user and several agents.
Keep the existing Node.js, Edge CDP, ChatGPT session and image export pipeline.
Expose the same operations through both a CLI and MCP.

The required consistency rule is strict: a result belongs to one job, one tab,
and the submitted prompt's response. A timeout or missing result must fail.
Generation latency is controlled by ChatGPT; control operations should return
without waiting for image generation. No cloud deployment or paid API is added.
Default concurrent generation limit is two, configurable by the user.

## Alternatives

1. **Shared local coordinator with CLI and MCP adapters (recommended).** One
   background process owns tab reservations and job state. Independent clients
   can share it, query jobs, and cancel their work. This adds a process lifecycle
   but avoids coordinating every job through separate clients' file locks.
2. **Direct CLI and MCP adapters with locks per tab.** Fewer moving parts for
   synchronous requests, but durable asynchronous jobs, cancellation and recovery
   require cooperation between many independent worker processes.
3. **MCP only.** A smaller interface, but terminal users cannot inspect tabs or
   control jobs without a separate MCP client. Multiple MCP clients still need
   shared coordination.

Proposed choice: option 1. The coordinator runs as a user process, starts on
demand, and requires no installed Windows service or external infrastructure.

## Interfaces

The existing `image-gen-mcp` executable and `mcp-server.mjs` remain supported.
A new `image-gen` executable provides these commands:

```text
image-gen login
image-gen tabs list --json
image-gen tabs create --name hero
image-gen generate --prompt "..." --tab <tab_id> --output hero.png
image-gen generate --prompt "..." --new-tab --output hero.png
image-gen jobs list --json
image-gen jobs get <job_id>
image-gen jobs wait <job_id>
image-gen jobs cancel <job_id>
```

Generation waits by default in the CLI. `--async` returns a job identifier.
JSON output supports scripts, and progress goes to stderr.

MCP exposes `list_tabs`, `create_tab`, `start_generation`, `get_job`, `list_jobs`,
`wait_job`, and `cancel_job`. Keep `generate_image` as a compatible synchronous
wrapper, adding optional `tab_id` and `new_tab` arguments. New calls without a
target allocate a fresh dedicated tab; they never pick the first open tab.
Specifying both a tab ID and a new-tab request is an input error.

Tab IDs use browser target identities, not changing page-array indices. Tab
listings include the title, conversation URL, managed status and active job ID.
Job results include `job_id`, `tab_id`, status and the exact output path.

## Components and data flow

- **CLI adapter:** argument parsing, JSON/text output and waiting.
- **MCP adapter:** tool schemas and responses, including existing image and
  transparency reporting.
- **Coordinator:** job registry, tab reservations, capacity, cancellation and
  recovery. One coordinator owns a configured browser endpoint.
- **Browser adapter:** connect, list/create tabs, submit the prompt, match the
  response, upload references and download the exact image.
- **State store:** atomic local job metadata and coordinator discovery.

Clients communicate with the coordinator through local IPC: a Windows named
pipe or Unix-domain socket. Discovery and authentication material stays in
user-local runtime state, outside tracked source files. The implementation must
verify platform access controls and authenticate connections before accepting
browser commands. There is no unauthenticated network listener.

The coordinator starts once even if clients connect concurrently. Restarting an
MCP adapter does not silently resubmit or cancel an already accepted job.

## Ownership and scheduling

Every accepted request gets a unique job ID before browser work begins. The
coordinator atomically reserves its chosen tab. Jobs targeting different tabs
may generate concurrently up to the capacity limit. Jobs targeting the same tab
are serialized in submission order. Reusing a conversation is explicit.

For a new-tab job, create that job's own tab before submission. For an existing
tab, respect the selected conversation; fail if it is closed, navigated away or
already generating outside coordinator control. Never retarget a failed job to
another tab automatically.

State transitions are `queued -> running -> succeeded | failed | cancelled`.
Queued jobs can be cancelled without touching the browser. Cancelling a running
job targets only its own tab and response; it does not kill Edge or stop another
tab's job. Capacity is released only after that cancellation is acknowledged.

Output defaults include the job ID. Conflicting explicit output paths are
rejected while another active job owns that path. Save via an atomic file
replacement and keep the response image bytes associated with the same job.

## Correctness and recovery

Preserve the existing fixes for localized composers, explicit send-button
submission and request-specific result ownership. The response's turn identity
must match the job's submitted prompt. A refreshed old blob URL, uploaded
reference, unrelated network response or unstable preview is never a result.

Do not automatically retry submission after a disconnect: the prompt might
already have reached ChatGPT. Persist enough metadata to mark interrupted work
accurately and report an actionable failure instead of duplicating generation.
The first implementation marks jobs interrupted by coordinator termination as
failed; it does not pretend to resume them. Surviving tab activity is checked
before assigning subsequent work to those tabs.

Profile data, cookies, prompts, runtime job records and generated files must not
be committed. Preserve the upstream license and attribution in the fork.

## Verification

- Keep all 21 current regression checks.
- Test two concurrent clients, duplicate coordinator startup and stable tab IDs.
- Test overlapping work on separate tabs and serialization on the same tab.
- Test cancellation, a closed/navigated/busy tab, disconnected clients,
  coordinator termination and conflicting output paths.
- Test CLI parsing and MCP schemas against the same service operations.
- Run two simultaneous real generations with visibly different prompts in
  different tabs; verify the saved files against their own response images.
- Repeat a request in an existing conversation to check that old images remain
  excluded and no stale output is reported after a failure.

Keep pure unit/process tests runnable without a logged-in browser. Put live
browser integration checks behind a separate explicit test command.

## Implementation discoveries

These do not change the requested scope: verify named-pipe/socket access
controls, singleton startup and abrupt-crash cleanup on Windows; verify current
ChatGPT stop controls and behavior under concurrent requests; preserve a stable
API for transparency reports and existing MCP configurations. ChatGPT's account
limits remain external constraints and must be surfaced as job errors.

# User-requested headless amendment

Generation launches a separate headless Microsoft Edge by default with the saved
ChatGPT storage state and login User-Agent. The visible dedicated auth browser
is used only for login, and can be closed after session saving. The worker never
opens a login window automatically. Missing/expired login directs the user to
the explicit login command. A refreshed session is applied between active jobs
without replacing worker tabs. IMAGE_GEN_HEADLESS=0 retains visible CDP mode for
debugging; the setting applies when the coordinator starts. This amendment
supersedes the original generation connection description above. Stable target
IDs and tab selection apply to the worker's own tabs in the default mode.
