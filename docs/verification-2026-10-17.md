# Windows verification, 2026-10-17

The CLI/MCP coordinator and headless worker were verified with Node 24.11.0
and Microsoft Edge 155.0.4283.60. No dependencies were added.

- Pure suite: 30 tests, including real local IPC, concurrent detached startup,
  authentication rejection, restart recovery, independent CLI processes and a
  real MCP SDK stdio handshake/tool call with a synthetic browser driver.
- Browser suite: 40 tests using isolated contexts and routed fixtures. Includes
  simultaneous pipelines, per-tab cancellation, delayed/overlaid/replaced Send
  buttons, reference cancellation, conversation changes, repeated prompts,
  optimistic route changes and preserved refreshed login state.
- Real headless coordinator: a blue whale and red lighthouse generated with
  overlapping running intervals in different tabs. A third request reused the
  whale conversation and returned a yellow teapot. All three output exports
  matched their immutable artifact hashes and were visually inspected.
- Final ownership implementation: a fresh headless conversation generated and
  downloaded the requested purple origami butterfly, 1254 x 1254, 1933674 bytes,
  SHA-256 eea9c8b1b3dbec0a8f32da4334726955b05243078ce8ec118db73851dcaffa55.
  This exercised the unique metadata ID, optimistic local conversation URL,
  canonical server URL and pinned response turn in the actual ChatGPT UI.
- Syntax checks and git diff whitespace checks passed. Independent review
  covered scheduling, local IPC, cancellation, output ownership and adapters.

Live checks used the account's generation allowance. During development,
conservative ownership guards rejected valid optimistic route changes; those
attempts were not counted as successful downloads. The final implementation
and its regression fixtures account for both observed route transitions.

Unix paths and Node 18 were not executed locally. ChatGPT account limits and
future UI changes remain external constraints. Existing MCP processes require
reconnection to load version 3; a running v2 client retains its old behavior.
