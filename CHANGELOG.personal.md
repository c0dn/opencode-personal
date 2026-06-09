# Personal Fork Changelog

Changes specific to `c0dn/opencode-personal`, layered on top of upstream
`anomalyco/opencode`. Upstream features are tracked by upstream; this file only
records the personal patch stack and personal feature additions.

Versioning note: automated upstream mirrors are published as
`v<upstream-version>-c0dn.N`, and manual personal builds use
`<upstream-version>-c0dn.N`. Releases are built manually via
`personal-release.yml` and are Linux-only (`linux-x64`, `linux-arm64`).

## v1.16.2-c0dn.12 - 2026-06-09

### Added
- **Subagent-to-subagent messaging**: three new tools allow subagents to discover
  each other and communicate within the same orchestration tree, backed by the
  existing durable `SessionMailbox` store.

  **Tools**:
  - `subagent_list` — returns the full orchestration tree (all depths) with
    relationship labels (`self`, `parent`, `child`, `sibling`, `ancestor`,
    `descendant`, `peer`), `depth`, and `parent_id` for precise topology.
  - `subagent_send` — sends a message to any session in the same root tree.
    Supports `async` delivery (queued for next safe turn boundary) and
    `interrupt` delivery (cancels target's current run and delivers immediately).
    Messages appear in the target session as synthetic user messages wrapped in
    `<inter_agent_message from="ses_…">`. Sibling-to-sibling messages also inject
    a `<inter_agent_relay>` notification into the root parent session so the user
    can see all inter-agent traffic.
  - `mailbox_list` — inspects the mailbox queue for the current session.
    Filterable by state (`queued`, `processing`, `delivered`, `failed`,
    `cancelled`) and kind. Read-only debugging tool.

  **New service**:
  - `SessionInterAgent` (`packages/opencode/src/session/inter-agent.ts`) —
    validates same-root messaging (walks the `parentID` chain on both sender and
    target, rejects cross-root sends), enqueues durable `SessionMailbox` records,
    injects synthetic user messages for immediate delivery, notifies the root
    session on child-to-child communication, and supports interrupt delivery
    (cancel target → enqueue → wake).

- **Full-tree session discovery**: `Session.Interface` gained two new methods:
  - `descendants(rootID)` — BFS traversal returning all descendant sessions with
    their depth from root.
  - `depthFromRoot(sessionID)` — walks the parent chain to compute the session's
    absolute depth (0 = root). Used by `subagent_list` for relationship labeling
    and by the task tool for depth gating.

### Security
- **Backend child-session prompt guards**: the HTTP (`POST /session/:id/message`,
  `/prompt_async`, `/command`, `/shell`) and WebSocket (`session.prompt`,
  `session.command`, `session.shell`) routes now reject prompts targeting child
  subagent sessions with a 403 `ChildSessionPromptError`, matching the existing
  UI-side block. Internal orchestration paths (`task` resume, `subagent_send`)
  are unaffected.
- **Sender identity enforcement**: `subagent_send` derives the sender session ID
  from the tool execution context — never from user/agent input — preventing
  session spoofing.

### Config
- **`experimental.max_subagent_depth`** (default 3): caps how deep subagents can
  spawn via the `task` tool. Set in `opencode.json` under the `experimental`
  block. Example:
  ```jsonc
  { "experimental": { "max_subagent_depth": 5 } }
  ```
  The depth guard is enforced at spawn time: when the spawning session's depth
  from root reaches or exceeds the cap, `task` returns a descriptive error
  instead of creating the child.

### Tests
- 23 new tests (subagent_list 5, subagent_send 10, mailbox_list 4, guards 4).
- Full test suite: 428 pass, 0 fail, 0 regressions.
- `tsgo --noEmit`: 0 errors introduced (3 pre-existing layer-type noise on
  `app-runtime`, `httpapi/server`, `socketio/transport` — unchanged from
  upstream).

### Files changed
| File | Change |
|---|---|
| `packages/core/src/v1/config/config.ts` | + `experimental.max_subagent_depth` |
| `packages/opencode/src/server/httpapi/errors.ts` | + `ChildSessionPromptError` |
| `packages/opencode/src/server/httpapi/groups/session.ts` | error arrays |
| `packages/opencode/src/server/httpapi/handlers/session.ts` | `rejectChildSession` guard |
| `packages/opencode/src/server/ws/handlers.ts` | WS child-session guards |
| `packages/opencode/src/session/prompt.ts` | wire mailbox + inter-agent layers |
| `packages/opencode/src/session/session.ts` | `descendants()`, `depthFromRoot()` |
| `packages/opencode/src/tool/registry.ts` | register 3 new tools |
| `packages/opencode/src/tool/task.ts` | depth guard |
| `packages/opencode/src/session/inter-agent.ts` | **new** — SessionInterAgent service |
| `packages/opencode/src/tool/subagent-list.ts` + `.txt` | **new** |
| `packages/opencode/src/tool/subagent-send.ts` + `.txt` | **new** |
| `packages/opencode/src/tool/mailbox-list.ts` + `.txt` | **new** |
| `packages/opencode/test/tool/*.test.ts` (3 files) | **new** — 19 tests |
| `packages/opencode/test/server/subagent-prompt-guards.test.ts` | **new** — 4 tests |

## v1.16.2-c0dn.11 - 2026-06-08

### Changed
- **Resume picker defaults are now local-first**: `opencode resume` / `r`
  now searches sessions in the current folder by default, with `--global`
  to search across folders and `--attach` to resume through the local attach
  flow. The picker empty-state messaging was also tightened up so failed
  searches recover more cleanly.

### Fixed
- **Recent project lists scroll correctly again in the new home UI**: the
  desktop home project viewport now keeps its own vertical scrolling instead of
  expanding out of the container on large layouts.
- **Post-Socket.IO Web UI chatter is reduced**: model settings writes no longer
  trigger an immediate redundant `GET /ui/settings`, and normal server status
  indicators now derive health from the live Socket.IO connection state instead
  of polling `/global/health` every 10 seconds. Server version badges are now
  populated from the WS `hello` payload.

## v1.16.2-c0dn.10 - 2026-06-08

### Changed
- **WebSocket transport replaced with Socket.IO + MessagePack**: the entire
  hand-rolled binary WS protocol (MessagePack + Brotli custom framing, manual
  heartbeat/reconnect, duplicate `handlerRuntime`) has been replaced with
  first-party `socket.io` (v4.8.3) + `socket.io-msgpack-parser`. WebSocket
  remains the primary transport; Socket.IO polling provides the built-in HTTP
  fallback, eliminating the manual SSE fallback loops in the web app and TUI.

  **Server**:
  - New `Socket.IO Server` attaches to the existing `node:http` server on path
    `/socket.io/`, sharing the REST service graph via a captured
    `Effect.runtime()` — no separate `ManagedRuntime`, no duplicate layer graph.
  - RPC via Socket.IO `emit-with-ack` on the `"rpc"` channel, reusing the
    existing `WsMultiplex` handler table and idempotency cache unchanged.
  - Event push: 16ms `GlobalBus` → `socket.emit("push.event"|"push.batch")`
    with per-socket subscription filter, ported 1:1 from the old event bridge.
  - Auth via Socket.IO handshake middleware (`auth_token` + Origin validation).

  **Client**:
  - `WsClient` (~459→273 LOC) rewritten over `socket.io-client`; public API
    preserved byte-for-byte — `createOpencodeWsClient`, `request`/`send`,
    `onEvent`/`onSnapshot`/`onStateChange`, `createWsFetch` all unchanged.
  - Broadcasts now use `push.event`/`push.batch`/`push.meta`/`push.static`/
    `push.snapshot` event names emitted directly by the server per-socket
    (no Socket.IO rooms for fanout).
  - Dropped manual msgpack/Brotli framing, manual heartbeat, and manual
    reconnect — all handled natively by Socket.IO.

### Fixed
- **Production zero-response stall (2.5 GB RSS / heap-limit-exceeded)**: the
  separate `handlerRuntime` (`ws/runtime.ts`) built a **second** Effect service
  graph without the shared `memoMap`, eagerly constructing MCP/Provider/Database
  on first dispatch. If that build stalled (e.g. remote MCP connection), every
  dispatched WS request hung indefinitely while the server's synchronous
  `ping`→`pong` path still worked — exactly matching the HAR evidence. The new
  design shares the single REST graph via `Effect.runtime()`, eliminating the
  stall and the duplicate memory footprint.

### Removed
- Deleted `ws/{transport,event-bridge,protocol,snapshot,runtime}.ts`
- Stripped `ws/connection.ts` to interface-only (reused as a type import)
- Removed manual SSE fallback loops from `app/server-sdk.tsx` and
  `tui/context/sdk.tsx` (Socket.IO polling replaces them)
- Server SSE endpoints `/global/event` + `/event` kept intact for `run`/`acp`/`slack`

## v1.16.2-c0dn.9 - 2026-06-08

### Fixed
- **brotli-wasm crashes in embedded Web UI builds**: the dynamic `import("brotli-wasm")`
  in `WsClient` fails inside `opencode web`'s Bun-compiled embedded Web UI because
  the .wasm binary can't be instantiated. The `WebAssembly.instantiateStreaming`
  call produces a corrupted asset path, then the fallback `WebAssembly.instantiate`
  also fails.

  **Fix**: `WsClient.encode()` now falls back to raw (no compression) when brotli
  is unavailable. `WsClient.decode()` falls back to the browser's native
  `DecompressionStream("brotli")` when `brotli-wasm` isn't loaded, so server-encoded
  brotli frames can still be decoded. `getBrotli()` catches import failures and
  returns `null` instead of crashing.

## v1.16.2-c0dn.8 - 2026-06-08

### Fixed
- **WS event reliability for inactive tabs and background sessions**: multiple
  fixes across the WebSocket transport, SDK, and Web UI state layer so that
  permission prompts, terminal status, streaming output, and session history
  stay current even when the affected tab is not focused.

  **Server/SDK**:
  - Backpressure: outbound queue saturation now closes the connection instead of
    blocking indefinitely (Effect bounded `Queue.offer` was blocking, not
    returning false).
  - Permission WS mapping parity: `POST /permission/{requestID}/reply` and
    `POST /session/{sessionID}/permissions/{permissionID}` now route over WS
    with REST-compatible payloads and proper `NotFoundError` handling.
  - 11 new event-bridge subscription/batching tests covering empty/non-empty
    subscribed sets and 16 ms `push.batch` fanout.

  **Web client state**:
  - Event coalescing now preserves arrival order (tombstone + append instead of
    in-place replacement); permission/question events are never coalesced away.
  - 14 critical event types materialize child stores for inactive directories
    and dirty session prefetch caches so permission prompts, terminal status,
    and streaming updates apply even when no tab is viewing that directory.
  - Permission/question events trigger async session row warming.
  - Terminal-status self-healing: completed/errored assistant messages clear
    stale busy `session_status` when no permission/question blocker exists.
  - Hydration preservation: live WS message/part updates during `session.messages`
    fetch are preserved instead of being overwritten by older fetched state.
  - WS reconnect now triggers refresh planning via `planReconnectRefresh` for
    global and per-directory/bootstrap reconciliation.

### Validation
- opencode: typecheck clean, 63 WS tests pass (11 new event-bridge tests).
- sdk/js: 26 ws-fetch tests pass (2 new permission mapping tests).
- app: typecheck clean, 14 sync tests pass.
- Playwright smoke: WS connects, session creation + messaging + subagent
  spawning all functional with zero browser console errors.

## v1.16.2-c0dn.7 - 2026-06-08

### Fixed
- **Web and TUI clients now connect to the correct WS endpoint**: both clients
  built the socket URL by only swapping the scheme (`http` → `ws`), so a server
  URL like `https://opencode-main.c0dn.dev` became
  `wss://opencode-main.c0dn.dev` instead of `wss://opencode-main.c0dn.dev/ws`.
  That left the browser socket stuck at `pending` behind Cloudflare Tunnel while
  the Web UI silently continued on REST/SSE fallback.

  **Fix**: both clients now build the WS URL with `new URL("/ws", baseUrl)` and
  then switch the protocol to `ws:`/`wss:`. Validated by confirming local `101
  Switching Protocols`, then smoke-testing a real `WsClient` against the server:
  `sync.catchup`, `project.list`, and `session.list` all completed over WS.

## v1.16.2-c0dn.6 - 2026-06-08

### Fixed
- **WS transport hung on servers without an opencode project in CWD**: the per-request
  directory-aware dispatch introduced in v5 called `InstanceStore.load()` for *every*
  WS message — including `sync.catchup`, `ping`, and `hello` — using `process.cwd()`
  as the default directory. When the server process's CWD isn't a valid opencode
  project directory, `project.fromDirectory()` fails inside the Effect, and
  `handlerRuntime.runPromise()` never resolves. The client waits forever for a
  response that never arrives, and the WebSocket stream never establishes (stuck at
  `pending`).

  **Fix**: `InstanceStore.load()` is now only called when `msg.directory` is explicitly
  provided by the client (wsFetch always sends it). All other messages use the
  `handlerRuntime`'s safe global default context. Smoke-tested with a real `WsClient`:
  `sync.catchup`, `project.list`, and `session.list` all return cleanly over WS.

## v1.16.2-c0dn.5 - 2026-06-08

### Added
- **WS request transport** (`ws-fetch` facade, default-on): 29 REST endpoints now
  route over the shared event WebSocket instead of HTTP. Both TUI and Web UI
  always prefer WS for mapped calls when connected, falling back to REST
  transparently on disconnect or errors. Uses a single socket — no second
  connection.

#### Mapped endpoints (29)
| Group | Endpoints |
|---|---|
| Session reads | `list`, `get`, `status`, `todo`, `children`, `diff` |
| Session mutations | `create`, `delete`, `fork`, `abort`, `init`, `prompt`, `command`, `shell`, `revert`, `unrevert`, `summarize` |
| Messages | `delete`, `part.delete` |
| Static/read | `project.list`, `config.get`, `mcp.status`, `permission.list`, `question.list` |
| Control | `mcp.connect/disconnect`, `permission.reply`, `question.reply/reject` |

#### Intentionally on REST
`session.update`, `session.share/unshare`, `session.promptAsync`, `config.providers`,
`session.messages` — payload/return shape mismatches with the WS handler; will be
aligned in a follow-up.

- **Per-request directory-aware WS runtime**: the WS handler dispatch now resolves
  `InstanceContext` per-message via `InstanceStore.load()` (matching REST's
  `instance-context` middleware), so directory-scoped handlers like `config.get`
  and `mcp.status` return per-project results instead of the server's CWD.
  Messages without a `directory` field default to `process.cwd()` for backward
  compatibility.

- **Stats dashboard interaction**: keyboard navigation now works (it was
  completely unresponsive). Registered through the OpenTUI keymap in a dedicated
  `stats` mode instead of the raw `useKeyboard` hook (which ran after the keymap
  consumed the keys). `1`-`5` select tabs, `Tab`/`Shift+Tab` + `h`/`l` + arrows
  cycle tabs, `j`/`k` + arrows scroll, `r` cycles the time range
  (All -> 7d -> 30d), `q`/`Esc`/`Ctrl+C` quit. The header shows the active range
  and `opencode stats` precomputes all three ranges so switching needs no DB
  re-query.

### Changed
- **WebSocket is the default transport** for both events (push.snapshot/batch/meta/static)
  and requests (REST calls). SSE and REST HTTP remain as transparent fallback when
  the socket is unavailable. A single `WsClient` handles both flows — no separate
  event-vs-request connections.

- **Stats number formatting** scales past millions: token counts now render as
  `B` (billions) and `T` (trillions) instead of e.g. `16563.2M`.

### Fixed
- **WS handlers now forward all REST payload fields**: `session.prompt` accepts
  `model` as `{providerID, modelID}` (the SDK shape), `session.command` and
  `session.shell` forward `model`, `variant`, and `parts` that were previously
  dropped (silently losing image attachments). `session.delete` now returns
  `true` matching the REST handler.

- **Stats cost was undercounted** ("pricing seems off"): the dashboard summed the
  stored `session.cost`, but opencode persists `cost: 0` for many responses that
  still have token usage. Cost is now estimated from token usage x the model's
  models.dev price (reused from opencode's existing `ModelsDev` cache, no new
  fetch, offline-safe) whenever the stored cost is `0`/missing, and the Overview
  total and per-model/provider totals are derived from the same source so the
  tabs agree. The Overview prompt count is now a real query instead of `0`.
- **Stats dashboard loaded slowly** on large histories: the five stats queries
  now run concurrently and the per-session message-count N+1 correlated subquery
  was replaced with a single grouped join.
- **`opencode attach`** now opens the directory it was invoked from on a local
  attach (it previously opened `$HOME` when `--dir` was omitted); explicit remote
  URLs still defer to the server's default directory.
- Removed the dead, never-started Web UI WS provider (`context/server-ws.tsx`)
  now that the live WS event path lives in `context/server-sdk.tsx`.

## v1.16.2-c0dn.4 - 2026-06-07

### Added
- **Unified WebSocket transport** (`GET /ws`): Replaces the multi-transport
  architecture (HTTP REST + SSE + separate PTY WS) with a single multiplexed
  WebSocket using MessagePack + Brotli binary frames with selective raw bypass
  for sub-64-byte payloads.
- **100+ WS message types** covering all existing REST endpoints:
  session CRUD, prompt/command/shell, message deletion, MCP status, config,
  providers, project listing.
- **Push-based session state**: `push.snapshot` (paginated 10/page),
  `push.batch` (16ms event batching), `push.meta` (surgical session metadata
  patches), `push.static` (config/MCP/providers once on connect).
- **Per-connection event filtering**: `session.subscribe`/`unsubscribe` for
  session-level event culling. Empty subscribed set = all events pass.
- **Request idempotency**: 5-minute server-side idempotency cache keyed by
  `idempotencyID`, with probabilistic cleanup at 1000 entries. Safe retry for
  mutating requests.
- **Reconnect recovery**: Full session snapshot on reconnect, version-aware
  static data (config/MCP/providers) via DJB2 hash comparison to skip
  redundant pushes, automatic re-subscription to tracked sessions, and replay
  of in-flight request queue after reconnect.
- **Bounded backpressure**: 256-frame outbound queue with 4 MiB frame limit.
  Connection is closed when the queue is full.
- **WS heartbeat**: 15-second ping interval with 45-second timeout.
- **SDK client** (`packages/sdk/js/src/v2/ws/`): `WsClient` class with
  connect/reconnect, exponential backoff (250ms base, 60s max, 10 attempts),
  heartbeat, request multiplexing with configurable timeout, fire-and-forget
  send, `subscribe()`/`unsubscribe()` with reconnect tracking, event/snapshot/
  meta/static/hello/stateChange handlers.
- **Web UI WS context** (`packages/app/src/context/server-ws.tsx`): SolidJS
  context with 16ms event batching + coalescence by event key,
  `push.meta` surgical session store patches, `push.static` separation for
  config/MCP/providers, `loadMessages()` auto-subscribe, `activate()` for
  tab-switch subscribe/unsubscribe.
- **TUI WS integration**: Prefers WS for events with SSE fallback,
  `createEffect` subscribes to active session on navigation.
- **WS tests** (`packages/opencode/test/ws/`): 52 unit tests covering protocol
  encode/decode (26), connection lifecycle (13), multiplex dispatch (13).

### Changed
- **Server**: Registered WS route at `/ws` with auth token query parameter and
  Origin validation. Registered the unified transport as an Effect `HttpRouter`
  layer.
- **Event bridge**: Uses `GlobalBus.on("event")` (V1 event bus, downstream of
  the existing EventV2→GlobalBus bridge). Events accumulate synchronously in a
  native array with 16ms setTimeout drain, avoiding per-event Effect fiber
  overhead.
- **Handler runtime**: Uses a pre-built V1-only `ManagedRuntime` providing
  `Session`, `Config`, `MCP`, `Provider`, `Project`, and all other V1 services
  — no EventV2 dependency.
- **Dependencies**: Added `@msgpack/msgpack@3.1.3` and `brotli-wasm@3.0.1` to
  `packages/opencode` and `packages/sdk/js`.

### Removed
- **PTY server mode**: Deleted `groups/pty.ts`, `handlers/pty.ts`,
  `pty-ticket.ts`, PTY auth middleware, and 4 PTY-dependent test files.
  PTY endpoints no longer registered on the server.
- **PTY exerciser scenarios**: Removed 9 PTY scenarios and the
  `controlledPtyInput()` DSL helper from the HTTP API exerciser.
- **PTY OpenAPI error test**: Removed PTY resource/ticket error documentation
  test.

### Fixed
- **Scope lifecycle**: `Scope.close()` finalizer prevents fiber leaks on
  disconnect; drain/heartbeat/event listener fibers all cleaned up.
- **GlobalBus listener cleanup**: `GlobalBus.off("event", ...)` registered via
  `Scope.addFinalizer` on scope close.
- **Web UI unsubscribe tracking**: Fixed unsubscribe to use the tracking-aware
  `ws.unsubscribe()` method so reconnect re-subscription does not leak
  previously unsubscribed sessions.
- **Double subscription bookkeeping**: Removed duplicate `subscribedSessions`
  Set from Web UI context; all tracking consolidated in `WsClient.subscribed`.
- **Double snapshot push**: Consolidated initial state delivery into a single
  `sync.catchup` handler path, eliminating the double snapshot push on
  reconnect.
- **Static data on reconnect**: Version-aware static data push — client tracks
  `lastStaticHash` from DJB2 hash, skips redundant `push.static` on reconnect
  when version matches.
- **Request retention**: In-flight requests are moved to a retry queue on
  disconnect and replayed after successful reconnect, instead of being
  rejected.

## v1.16.2-c0dn.3 - 2026-06-06

### Fixed
- **LLM native fetch for WS**: Thread per-request fetch calls through the native
  transport layer so WebSocket connections can proxy LLM provider requests.
  Prevents "fetch is not defined" errors when running under the WS protocol
  without a polyfilled global fetch.

## v1.16.2-c0dn.2 - 2026-06-06

### Changed
- **CI**: Removed inherited upstream workflows that are not relevant to the
  personal fork.

### Fixed
- Re-applied project directory preservation fix for canonical project views.

## v1.16.2-c0dn.1 - 2026-06-05

### Changed
- Ported upstream v1.16.2 fixes.

### Fixed
- **App (v2 UI)**: Restored project sync so opened project directories persist
  across sessions.
- **App (v2 UI)**: Deduplicated project view opens to prevent duplicate tabs.
- **App (v2 UI)**: Handled canonical project view aliases so navigation to the
  same project by different route forms reuses the existing view.
- **App (v2 UI)**: Showed canonical project titles instead of raw directory names
  in the project list.
- **App (v2 UI)**: Preserved opened project directories across app restarts.

## v1.16.0-c0dn.1 - 2026-06-05

### Changed
- Synced the personal fork onto upstream `anomalyco/opencode` v1.16.0 while
  preserving the `c0dn/opencode-personal` installer/updater release channel,
  Linux-only artifacts, and blocked package-manager upgrades.
- Re-applied compatible upstream release-channel changes: curl upgrades now fall
  back from `bash` to `sh`, and Linux builds carry libc metadata through
  `OPENTUI_LIBC`.
- Hardened sync/release automation so upstream mirrors are skipped only when the
  expected Linux release assets exist, and personal releases are built from the
  validated merge SHA.
- Narrowed personal version normalization to strip only `-c0dn.N` suffixes for
  dependency compatibility, without treating arbitrary upstream prereleases as
  stable versions.

### Fixed
- Web (v2 UI): hid desktop titlebar session tabs on mobile/tablet widths while
  keeping desktop tabs and titlebar controls aligned.

## v1.15.13-c0dn.8 - 2026-06-05

### Fixed
- Web (v2 UI): restored titlebar session tabs by porting upstream tab handling
  and fixing project/new-session tab behavior.

## v1.15.13-c0dn.6 - 2026-06-04

### Added
- MCP: added Bifrost gateway configuration support, including default header
  handling, CLI/server wiring, tests, and documentation for the managed gateway
  setup.

### Fixed
- Session runtime: reverted the OpenAI websocket/session stream recovery and
  attempt replay stack that caused regressions around queued follow-up prompts
  and undo/redo flows.
- TUI/session sync: ported safe upstream fixes for live hydration, diff-viewer
  rendering, ACP session handling, read output, task-tool wording, and related
  regression coverage.

## v1.15.13-c0dn.5 - 2026-06-04

### Added
- TUI: `/tps` slash command (alias `/tokens-per-second`) that toggles a compact
  tokens-per-second indicator in the prompt footer. State persists via the
  `tps_display_visibility` KV key. Shows a live average while a response streams
  and keeps the final average after completion. TPS is computed as
  `(output + reasoning tokens) / generation seconds`, with a character-based `~`
  estimate fallback before provider token counts are available.
- Web (v2 UI): assistant message metrics popover. A help icon in the assistant
  message metadata row opens a compact panel showing average TPS
  (output + reasoning), latency, time to first token, generation time, token
  breakdown, cost, provider, model, agent, and finish/interrupted state. Fully
  client-side from existing sync data; no server/API/schema changes.
- Web (v2 UI): shared `Popover` gained backwards-compatible
  `onOpenAutoFocus`, `onCloseAutoFocus`, and `contentProps` so hover-open
  surfaces do not steal focus from the composer and can stay open while the
  pointer is over the content.

### Fixed
- Web: restored queued follow-up prompts by preserving `followup: "queue"` in
  app and server UI settings. Busy-session submissions in queue mode now enqueue
  instead of sending immediately.
- Web (v2 UI): preserved desktop session tabs across direct session URL visits
  and reloads by persisting titlebar session tabs per workspace while keeping
  subagent/child sessions out of the tab strip.
- Web (v2 UI): improved desktop session tab overflow, close, and keyboard
  navigation behavior so active/root tabs stay visible and non-active tab closes
  do not navigate away.
- Web (v2 UI): defaulted the session todo dock to collapsed on mobile when the
  user has not explicitly toggled it, while keeping desktop expanded by default.
- Web (v2 UI): kept mobile-only v2 session chrome out of v1 UI, including the
  floating project bar, mobile Session/Changes titlebar control, and mobile
  changes view path.
- Web (v2 UI): improved mobile project navigation with a less pill-like bottom
  bar, project status indicators for permissions/running/errors/unread sessions,
  and long-press/right-click project actions for Move left, Move right, and
  Close.
- Web (v2 UI): split project selection into Opened projects and Recent projects,
  with Recent collapsed by default and clearer section markers across desktop
  and mobile layouts.
- Web (v2 UI): reworked the mobile Session/Changes control into a box-style
  segmented control so long changed-file labels truncate cleanly instead of
  clipping.

## Baseline personal patches

These are the standing customizations that define this fork's release channel.
They are maintained across upstream syncs.

### Release channel
- CLI updater and installer pull from GitHub Releases of
  `c0dn/opencode-personal`.
- Package-manager upgrades (`npm`, `bun`, `pnpm`, `brew`, `scoop`, `choco`) are
  blocked for personal builds; only GitHub-release/curl upgrades are supported.
- Personal release builds are limited to `linux-x64` and `linux-arm64`.
- `OPENCODE_BUILD_TARGETS` filters CLI build targets.

### Automation
- `sync-upstream.yml` merges the latest upstream release tag into this fork's
  `dev`, runs typecheck/tests, pushes the validated merge, and mirrors it as
  `v<upstream-version>-c0dn.1` from the validated SHA when the expected Linux
  assets are not already published.
- `personal-release.yml` publishes manual Linux CLI builds and can be called by
  the upstream sync after a successful merge.
