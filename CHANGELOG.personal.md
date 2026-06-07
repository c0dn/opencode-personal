# Personal Fork Changelog

Changes specific to `c0dn/opencode-personal`, layered on top of upstream
`anomalyco/opencode`. Upstream features are tracked by upstream; this file only
records the personal patch stack and personal feature additions.

Versioning note: automated upstream mirrors are published as
`v<upstream-version>-c0dn.N`, and manual personal builds use
`<upstream-version>-c0dn.N`. Releases are built manually via
`personal-release.yml` and are Linux-only (`linux-x64`, `linux-arm64`).

## Unreleased

- No unreleased personal changes.

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
