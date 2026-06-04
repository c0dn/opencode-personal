# EventV2 Phase Test Plan

This plan is the phase-by-phase validation companion for
[`event-v2-migration.md`](./event-v2-migration.md). Keep tests close to the
code they exercise, prefer focused fixtures over broad integration setup, and
update this file when a phase changes scope.

## Common Commit Gate

Before each phase commit, run the phase-specific tests plus the package
typecheck:

```bash
bun --cwd packages/opencode test <phase-specific-test-file>
bun --cwd packages/opencode typecheck
```

Run additional compatibility or snapshot commands when the phase touches
generated SDK/OpenAPI output, CLI/TUI rendering, sync history, or durable
storage.

## Recommended Test Locations

| Area | Suggested locations |
| --- | --- |
| EventV2 service, encoding, replay, projectors | `packages/core/test/event-v2/` or existing core-adjacent test directories |
| Session identity, mailbox, prompt delivery, background agents | `packages/core/test/session/`, `packages/opencode/test/session/` |
| HTTP/SSE, sync, SDK/OpenAPI compatibility | `packages/opencode/test/server/`, `packages/opencode/test/openapi/`, SDK snapshot tests |
| CLI/TUI output compatibility | `packages/opencode/test/cli/`, `packages/opencode/test/tui/` |

Use the repo's existing test layout where a more specific convention already
exists. The paths above are intended as placement guidance, not a migration
requirement for unrelated tests.

## Phase 0 — EventV2 Contract Baseline

Likely files to add or extend:

- `packages/core/test/event.test.ts` or `packages/core/test/event-v2/contract.test.ts`
- `packages/opencode/test/server/httpapi-event.test.ts`
- `packages/opencode/test/server/session-messages.test.ts` if sync-history shape is exposed there

Required unit tests:

- encode/decode EventV2 data at persistence and fanout boundaries, including `DateTime`, branded IDs, and nested domain objects
- assert `EventTable` payloads are JSON-compatible values, not live domain objects
- assert stored and emitted timestamps use the numeric wire/storage contract
- decode replayed rows before listeners and projectors observe them

Required integration tests:

- publish through `EventV2Bridge` and verify encoded `GlobalBus` payload shape
- stream the same event through the HTTP/SSE route and verify the SSE event shape
- verify sync-history output uses the same encoded payload and timestamp contract

Regression, failure-injection, and concurrency cases:

- malformed persisted EventTable rows fail or skip predictably without poisoning later replay
- legacy experimental rows with ISO timestamps still replay or migrate through the compatibility path
- fanout encode failure for one listener/SSE event does not fail the durable publish path
- concurrent publish/replay preserves sequence ordering for the same aggregate

Smoke/manual checks:

- if the phase changes SSE or sync output, manually inspect one streamed event from a local server or recorded fixture before merging

Commit gate examples:

```bash
bun --cwd packages/core test test/event.test.ts
bun --cwd packages/opencode test test/server/httpapi-event.test.ts
bun --cwd packages/opencode typecheck
```

## Phase 1 — `evt_*` Transcript Identity

Likely files to add or extend:

- `packages/core/test/session/event-identity.test.ts`
- `packages/core/test/session/projector.test.ts`
- `packages/opencode/test/v2/session-message-updater.test.ts`
- canonical v2 session/message API tests near the current server tests

Required unit tests:

- user-message events create canonical user message IDs from the publishing `evt_*` ID or explicit stable event-carried entity ID
- assistant message, durable part, shell, compaction, and final tool-result events produce stable event-derived IDs
- parent, message, part, and tool-result references remain stable after encode/decode and replay
- legacy `msg_*` and `prt_*` IDs are never stored in canonical v2 transcript state or new public v2 payloads

Required integration tests:

- run a minimal prompt transcript through the session processor and compare canonical EventV2 identity with the rebuilt transcript
- replay the same event history into a fresh state and assert identical IDs and references
- verify v2 API consumers receive canonical v2 IDs; legacy API behavior is version-bound and not preserved by a v2-to-legacy adapter

Regression, failure-injection, and concurrency cases:

- duplicate replay of the same event does not allocate new message or part IDs
- mixed legacy/v2 transcript rows do not leak legacy IDs into canonical projector output
- concurrent final tool results in one assistant message keep distinct event-derived part/result IDs

Smoke/manual checks:

- inspect one real or fixture transcript containing text, tool, shell, and compaction entries when shell/compaction identity changes

Commit gate examples:

```bash
bun --cwd packages/core test test/session/event-identity.test.ts
bun --cwd packages/core test test/session/projector.test.ts
bun --cwd packages/opencode test test/v2/session-message-updater.test.ts
bun --cwd packages/opencode typecheck
```

## Phase 2 — Registry, SDK, OpenAPI, And Consumer Compatibility

Likely files to add or extend:

- `packages/core/test/event-v2/registry.test.ts`
- `packages/opencode/test/openapi/event-schemas.test.ts`
- SDK snapshot tests under the existing SDK test or generation location
- consumer tests in `packages/opencode/test/cli/`, `packages/opencode/test/tui/`, and server event tests where direct EventV2 subscriptions are added

Required unit tests:

- every published EventV2 definition is imported and registered exactly once
- registry ordering is stable and deterministic for generation
- event schema snapshots include type, version, data schema, and durability/live-only classification where exposed
- fail validation when a published event is missing from the registry

Required integration tests:

- regenerate or exercise OpenAPI/SDK event schema snapshots and verify no unexpected diff
- verify direct EventV2 subscriptions for migrated consumers receive the same encoded shape as SSE/SDK consumers
- assert `GlobalBus` is only a compatibility fanout and is not used as durable truth, a queue, or mailbox state

Regression, failure-injection, and concurrency cases:

- adding a new event without registry registration fails the registry test
- duplicate registration fails instead of silently changing generated output order
- concurrent subscribers cannot mutate shared event payload objects observed by other subscribers

Smoke/manual checks:

- inspect generated SDK/OpenAPI diffs before committing any approved schema change

Commit gate examples:

```bash
bun --cwd packages/core test test/event-v2/registry.test.ts
bun --cwd packages/opencode test test/openapi/event-schemas.test.ts
bun --cwd packages/opencode test test/server/httpapi-event.test.ts
bun --cwd packages/opencode typecheck
```

## Phase 3 — SessionMailbox Foundation

Likely files to add or extend:

- mailbox SQL/migration tests near `packages/core/test/database-migration.test.ts`
- `packages/core/test/session/mailbox.test.ts`
- EventV2 mailbox observation tests in `packages/core/test/event-v2/` or `packages/core/test/session/`

Required unit tests:

- enqueue preserves FIFO order per target session and queue family
- claim is atomic under concurrent runners and returns each queued row at most once
- state transitions cover queued, processing, delivered, failed, and cancelled
- claim, delivery, failure, retry, and cancellation paths are idempotent
- EventV2 mailbox observations are emitted for state changes but are not the mailbox source of truth

Required integration tests:

- persist mailbox rows through the real database layer and recover them after service restart/rebind
- run multiple mailbox consumers against the same session and prove only one runner owns a claimed row
- replay mailbox events and verify projected/observed state matches SQL state without replacing it

Regression, failure-injection, and concurrency cases:

- crash/failure after claim but before delivery leaves a recoverable processing row or failed state according to the service contract
- cancelling a queued or processing row is safe to repeat and cannot resurrect delivery
- concurrent enqueue while a runner is claiming preserves FIFO for unclaimed work
- projection-only state cannot make a queued message visible if the mailbox table says it is cancelled or delivered

Smoke/manual checks:

- inspect mailbox table rows in a temporary fixture database when adding or changing SQL schema

Commit gate examples:

```bash
bun --cwd packages/core test test/database-migration.test.ts
bun --cwd packages/core test test/session/mailbox.test.ts
bun --cwd packages/opencode typecheck
```

## Phase 4 — Mailbox-Backed `prompt_async`

Likely files to add or extend:

- `packages/opencode/test/server/session-actions.test.ts`
- `packages/opencode/test/server/session-messages.test.ts`
- `packages/core/test/session/mailbox.test.ts`
- runner or processor tests near existing session processor coverage

Required unit tests:

- busy target sessions enqueue only; they do not write a user message at send time
- runner safe-boundary claim creates exactly one user-message EventV2 event
- interrupt-send cancels or interrupts the active run, then wakes the runner to claim the queued entry
- sender metadata, target session, workspace/instance context, and permissions are preserved in the mailbox envelope
- idle target sessions either claim immediately or wake deterministically according to the chosen contract

Required integration tests:

- call `prompt_async` against a busy target and verify mailbox row, no immediate transcript write, later claim, and final transcript event
- call interrupt-mode `prompt_async` and verify active run cancellation/interruption plus queued prompt delivery
- verify prompts do not leak across sessions, workspaces, or instance contexts

Regression, failure-injection, and concurrency cases:

- repeated wakeups or retries do not duplicate mailbox delivery or user-message events
- failed runner claim returns the row to the correct retry/failed state without losing sender context
- concurrent async sends to the same target preserve FIFO and do not interleave prompt bodies
- duplicate request/idempotency key does not enqueue duplicate prompts when the API exposes one

Smoke/manual checks:

- manually exercise one busy-session async prompt flow if CLI/TUI behavior changes are user-visible

Commit gate examples:

```bash
bun --cwd packages/core test test/session/mailbox.test.ts
bun --cwd packages/opencode test test/server/session-actions.test.ts
bun --cwd packages/opencode test test/server/session-messages.test.ts
bun --cwd packages/opencode typecheck
```

## Phase 5 — BackgroundAgent Replacement

Likely files to add or extend:

- `packages/opencode/test/background/job.test.ts`
- `packages/opencode/test/tool/task.test.ts`
- `packages/opencode/test/server/session-actions.test.ts`
- `packages/core/test/session/mailbox.test.ts`
- new background-agent tests under `packages/opencode/test/background/` if the replacement gets a new service

Required unit tests:

- parent/child session relationship is durable and queryable after restart/rebind
- cancellation stops both durable job state and the child runner; repeated cancellation is idempotent
- parent/child operations enforce authorization and reject unrelated sessions
- `task_send` creates an authorized mailbox envelope with sender metadata and target child/parent routing
- background completion publishes explicit background events but does not synthesize a parent auto-prompt injection

Required integration tests:

- `task background=true` starts a child session, records lifecycle state, and returns immediately
- cancel a running background child and verify runtime runner stop, durable cancelled state, and background EventV2 cancellation event
- send `task_send` from parent to child and child to parent through `SessionMailbox` and verify FIFO delivery

Regression, failure-injection, and concurrency cases:

- cancelled child cannot later deliver stale completion into the parent
- unauthorized `task_send` cannot enqueue mailbox rows or publish background events
- duplicate completion/cancellation events do not duplicate parent notifications or mailbox deliveries
- background runner failure records failed state and does not leave a processing mailbox row stuck forever

Smoke/manual checks:

- manually inspect the CLI/TUI background notification flow if user-facing task output changes

Commit gate examples:

```bash
bun --cwd packages/opencode test test/background/job.test.ts
bun --cwd packages/opencode test test/tool/task.test.ts
bun --cwd packages/opencode test test/server/session-actions.test.ts
bun --cwd packages/opencode typecheck
```

## Phase 6 — Incremental Event Ungating

Likely files to add or extend:

- event-family tests near `packages/core/test/session/event-family.test.ts`
- `packages/opencode/test/effect/runtime-flags.test.ts`
- `packages/opencode/test/server/httpapi-event.test.ts`
- CLI/TUI duplicate-output tests under `packages/opencode/test/cli/` and `packages/opencode/test/tui/`

Required unit tests:

- each event family has an explicit publication matrix covering gated, ungated, durable, and live-only behavior
- persisted families meet encode/decode/replay requirements before ungating
- live-only families still satisfy schema and fanout contracts when exposed externally
- disabling a projector does not prevent safe EventV2 publication

Required integration tests:

- ungate one low-volume family at a time and verify SSE, direct EventV2, and `GlobalBus` compatibility output
- verify CLI/TUI consumers do not render duplicate output while both legacy and EventV2 bridge paths exist
- verify rollback by disabling the new projector or family consumer while publication remains harmless

Regression, failure-injection, and concurrency cases:

- durable events remain replayable when emitted while projectors are disabled
- live-only stream/progress events do not bloat durable EventTable history unless explicitly classified as durable
- concurrent legacy and EventV2 consumers do not double-ack, double-render, or double-notify
- per-family ungating does not accidentally enable unrelated experimental families

Smoke/manual checks:

- run a short CLI/TUI scenario for any family that changes visible stream, notification, or transcript output

Commit gate examples:

```bash
bun --cwd packages/opencode test test/effect/runtime-flags.test.ts
bun --cwd packages/opencode test test/server/httpapi-event.test.ts
bun --cwd packages/opencode test test/cli/run/stream.transport.test.ts
bun --cwd packages/opencode typecheck
```

## Phase 7 — Projectors And Legacy Cleanup

Likely files to add or extend:

- `packages/core/test/session/projector.test.ts`
- `packages/core/test/event-v2/projector-replay.test.ts`
- `packages/opencode/test/server/session-messages.test.ts`
- `packages/opencode/test/server/httpapi-event.test.ts`
- cleanup compatibility tests near `GlobalBus` bridge and runtime-flag tests

Required unit tests:

- projectors are idempotent when the same event is delivered or replayed more than once
- replay is deterministic from an empty projected state
- transaction rollback prevents partial projected state after projector failure
- projected transcript/session state matches legacy state for representative histories
- removing legacy flags and the `GlobalBus` bridge leaves direct EventV2 subscribers covered

Required integration tests:

- replay a full transcript history through projectors and compare server/session API output with legacy output
- sync replay produces the same durable state and SDK/OpenAPI schema snapshots remain stable
- remove or disable `GlobalBus` bridge compatibility in the tested path and verify migrated consumers still receive events

Regression, failure-injection, and concurrency cases:

- projector failure rolls back the current transaction without losing the underlying EventTable row
- restarting projection from sequence zero yields the same state as incremental live projection
- duplicate live delivery followed by replay does not create duplicate transcript entries
- rollback from a partially enabled projector family restores legacy/read-model parity

Smoke/manual checks:

- manually inspect one migrated session transcript and one background-agent transcript if legacy paths are deleted

Commit gate examples:

```bash
bun --cwd packages/core test test/session/projector.test.ts
bun --cwd packages/core test test/event-v2/projector-replay.test.ts
bun --cwd packages/opencode test test/server/session-messages.test.ts
bun --cwd packages/opencode test test/server/httpapi-event.test.ts
bun --cwd packages/opencode typecheck
```

## Maintenance Notes

- Add test files to the relevant phase section when implementation picks concrete
  filenames.
- Keep schema snapshots deterministic; registry-order changes should fail tests
  unless explicitly reviewed.
- Prefer failure-injection fixtures for malformed persisted rows over relying on
  production data samples.
- Do not use `GlobalBus` tests to prove durable behavior. Durable behavior must
  be asserted through EventV2 storage, replay, mailbox tables, or sync history as
  appropriate.

## V2 Transcript Consumer Migration — No Adapter Test Plan

This transcript-specific test plan supplements the EventV2 phases above. The
consumer migration target is a no-adapter v2 cutover: old clients move with
server versions, so tests should not preserve legacy HTTP wire shape, old
cursors, `parts(messageID)`, or synthetic legacy-compatible `msg_*` / `prt_*`
IDs.

### Shared rules

- Permanent tests assert canonical v2 semantic behavior directly.
- Transitional legacy-oracle tests may compare normalized legacy helper output
  against v2 helpers before a caller is cut over, but their filenames and plan
  notes must mark them as transitional.
- Post-cutover tests must use observable v2 gates, retries, or explicit errors
  for ambiguous/failed backfill instead of falling back to legacy readers.
- Core mapper/backfill fixtures stay in `packages/core/test/session/*`.
  Opencode consumer fixtures stay in `packages/opencode/test/session/*`; core
  tests must not import opencode test support.
- Every phase still needs plan-critic before implementation, focused package
  checks, `workplan_validate` when the workplan/specs change, and code-vet
  before commit.
- Pure helper tests and production wiring are separate gates. A helper test may
  be approved while caller wiring remains blocked by read/write boundary,
  not-ready behavior, or legacy ID dependency.
- Every transitional legacy-oracle helper test must name its retirement slice;
  do not let normalized parity tests become permanent compatibility contracts.

The `T*` phases below are transcript-specific groupings. They map to the more
granular commit-sized phases in `v2-transcript-migration-contract.md`: T3 covers
prompt and compaction gates, and T5 covers destructive plus display/payload
gates.

### Transcript phase T0 — Policy and fixture plan

Likely files to add or extend:

- `packages/opencode/specs/v2-transcript-migration-contract.md`
- `packages/opencode/specs/event-v2-test-plan.md`
- `.opencode/workplan/legacy-session-backfill.{json,md}`

Required checks:

- the contract states that old clients do not connect to newer servers
- no v2-to-legacy adapter, old cursor preservation, or legacy part-shape parity
  is planned
- fallback language is explicitly transitional only; post-cutover behavior is a
  v2 gate/error/retry policy
- permanent and transitional tests have separate ownership and retirement paths
- current blocker and read/write boundary tables distinguish stale historical
  findings from remaining blockers
- R0-R8 sequence is recorded as historical mapping, not a current next-safe-slice
  list; current gating comes from the blocker table, and R1 production title
  wiring still needs its own critic gate

Commit gate example:

```bash
bun --cwd packages/opencode typecheck
```

### Transcript phase T1 — Backfill safety gates

Likely files to add or extend:

- `packages/core/test/session/message-backfill.test.ts`
- `packages/core/test/session/message-backfill.contract.test.ts`
- `packages/core/test/session/session-v2-message-backfill.test.ts`
- `packages/opencode/test/server/httpapi-session.test.ts`

Required tests:

- deterministic canonical v2 IDs and no raw legacy IDs in encoded/public v2
  payloads
- marker/remediation, idempotency, partial retry, non-backfill preservation, and
  mixed equal-timestamp cutoff ambiguity
- patch, task request, snapshot-boundary, retry, tool, and compaction mapping
  coverage
- v2 HTTP route visibility for backfilled sessions

Commit gate example:

```bash
bun --cwd packages/core test test/session/message-backfill.test.ts test/session/message-backfill.contract.test.ts test/session/session-v2-message-backfill.test.ts
bun --cwd packages/core typecheck
bun --cwd packages/opencode test test/server/httpapi-session.test.ts
bun --cwd packages/opencode typecheck
```

### Transcript phase T2 — Leaf helper semantic tests

Likely files to add or extend:

- `packages/opencode/test/session/transcript-semantic.fixture.ts`
- `packages/opencode/test/session/message-v2-legacy-parity.transitional.test.ts`
- `packages/opencode/test/session/message-v2-model.test.ts`
- `packages/opencode/test/session/message-v2-context.test.ts`

Required tests:

- permanent v2 expected-output coverage for model messages and context filtering
- transitional normalized parity against `MessageV2` while the legacy helper
  still exists, with a retirement slice named for every oracle case
- user text/files/agents, assistant text/reasoning/tools/errors, patch ignore
  behavior, task request ignore behavior, compaction anchors/includes, latest
  terminal assistant, and same-timestamp ordering
- `PromptV2Title` pure helper tests before any title wiring: parent sessions,
  non-default titles, synthetic-only first users, taskRequests-only, mixed
  text/taskRequests, multiple real users, and ambiguous/not-ready backfill with
  no LLM call and no title mutation
- title production wiring is not part of this phase unless a separate critic gate
  defines skip/retry/error behavior and proves no hidden legacy dependency

Commit gate example:

```bash
bun --cwd packages/opencode test test/session/message-v2-legacy-parity.transitional.test.ts test/session/message-v2-model.test.ts test/session/message-v2-context.test.ts test/session/message-v2.test.ts
bun --cwd packages/opencode typecheck
```

### Transcript phase T3 — Prompt and compaction helper/cutover gates

Likely files to add or extend:

- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/session/compaction.test.ts`
- `packages/opencode/test/session/message-v2-model.test.ts`
- `packages/opencode/test/session/message-v2-context.test.ts`

Required tests:

- provider-visible prompt content matches the semantic fixture after v2 backfill
- task requests and patch content do not become direct provider intent
- pure `PromptV2LoopState` tests define exact v2-native predicates for
  assistant-after-user, terminal assistant, pending taskRequests, compaction
  requests, and same-timestamp ties
- prompt loop-control production cutover remains blocked until tests prove no
  legacy ID/write dependency and no conversion to `SessionLegacy.WithParts`
- completed compaction pairs, include translation, incomplete pair skipping, and
  ambiguous-backfill gate behavior are covered
- compaction residual-read tests name the exact source for summaries: current
  processor result, completed canonical compaction row, or unsupported/not-ready
- pruning/compacted-output mutation tests remain design-only until v2
  mutation/event source policy exists
- pure v2 process-selection helper tests cover normal selection delegation and
  overflow replay selection only by canonical visible user ID
- overflow process-selection tests cover no-replay reasons and canonical
  equal-timestamp ordering
- overflow process-selection tests cover prior and repeated compaction
  summaries/includes
- process-selection source-purity guard prevents DB, legacy, plugin,
  session-compaction, and provider/model conversion dependencies
- production compaction wiring remains blocked until canonical replay policy and
  post-cutover gates are explicit
- processor doom-loop live-state tests, when added, must cover repeated identical
  tool calls, provider-executed tools, pending/running/completed transitions,
  cancellation, and interruption without using legacy part IDs

Commit gate example:

```bash
bun --cwd packages/opencode test test/session/message-v2-model.test.ts test/session/message-v2-context.test.ts test/session/prompt.test.ts test/session/compaction.test.ts
bun --cwd packages/opencode typecheck
```

### Transcript phase T4 — Public v2 payload and old-wire deletion gates

Likely files to add or extend:

- `packages/opencode/test/server/httpapi-session.test.ts`
- `packages/opencode/test/server/httpapi-public-openapi.test.ts`
- generated SDK/OpenAPI validation when public schemas change

Required tests:

- v2 route ordering, v2 cursor pagination, canonical IDs, patch/taskRequests,
  snapshot boundaries, and no raw legacy IDs
- old legacy routes are removed or return explicit unsupported behavior only at
  the final cutover; do not test legacy cursor or part compatibility

Commit gate example:

```bash
bun --cwd packages/opencode test test/server/httpapi-session.test.ts test/server/httpapi-public-openapi.test.ts
bun --cwd packages/opencode typecheck
bun --cwd packages/sdk/js typecheck # only when generated SDK/OpenAPI changes
```

### Transcript phase T5 — Destructive and display/payload gates

Likely files to add or extend:

- `packages/opencode/test/session/summary-v2-parity.test.ts`
- `packages/opencode/test/session/revert-compact.test.ts`
- share/export/import/replay/ACP/TUI tests near existing owners

Required tests:

- summary/diff snapshot and assistant patch behavior
- revert/remove/update/fork target behavior, canonical ID operations, standalone
  snapshot unsupported-data gate, mutation policy, and rollback safety
- payload/display docs-only gate (`U7a`): update spec policy for the two output
  shapes, `PublicTranscriptPayloadV2` and `DisplayTranscriptV2`; no helper code,
  consumer source, generated SDK/OpenAPI, import/export/share, ACP/TUI, or replay
  changes are part of this gate
- payload/display helper-fixture gate: add fixtures for canonical ordering,
  exhaustiveness, explicit backfill/readiness metadata, hard-gating of mixed,
  failed, partial, ambiguous, and missing-source states, and no raw `msg_*` or
  `prt_*` IDs
- public payload schema gate: when schemas are introduced or changed, test the
  explicit `kind`/`version` envelope, redaction table, canonical IDs only,
  unknown/legacy payload typed import rejection, and SDK/OpenAPI snapshots when
  generated surfaces change
- display fixture gate: test local display ordering plus visibility for task
  requests, assistant patches, retries, rich errors, tool title/input/output and
  result metadata, reasoning, files, synthetic messages, compaction rows, and
  unknown future variants
- export-only v2 payload generation is complete through U7e (`export --format
  v2`, including control-row omission). The U7 parent remains in-progress:
  import, share, CLI session-data/stats/replay, ACP, TUI, and replay remain
  blocked until their own tests and readiness gates exist
- existing legacy import may remain transitional until cutover, but v2 import
  rejects unknown or legacy payloads with a typed error; do not add best-effort
  legacy-to-v2 payload migration unless a later approved slice defines it

Commit gate example:

```bash
bun --cwd packages/opencode test test/session/summary-v2-parity.test.ts test/session/revert-compact.test.ts
bun --cwd packages/opencode typecheck
```

For checkpoint docs after U7 export-only completion, no runtime tests are
required unless the docs tooling changes. Validate by reviewing the spec diff
and running `git diff --check` on the touched spec files; if the workplan is
edited, also run `workplan_validate`.

Remaining phase-9 blockers: U5 production loop-control remains NO-GO; U8
destructive/session mutation policy is still draft; U9 stop legacy remains
blocked until all consumers migrate or become explicitly unsupported.

### Transcript phase T6 — Stop legacy writes/readers

Likely files to add or extend:

- `packages/opencode/test/session/processor-effect.test.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/server/httpapi-session.test.ts`
- core backfill tests for old database migration regressions

Required tests:

- new runs write canonical v2 rows and no migrated consumer needs fresh legacy
  transcript rows
- `Session.messages/findMessage` and `MessageV2.page/get/parts` callers have
  explicit v2-native replacements or unsupported behavior; no hidden
  v2-to-legacy adapter remains
- v2 routes and migrated consumers still pass after legacy helper tests are
  deleted or replaced
- transitional oracle tests from R1-R7 are retired or replaced by permanent v2
  expected-output tests
- old local databases remain covered by backfill tests until the final storage
  removal plan is complete

Commit gate example:

```bash
bun --cwd packages/core test test/session/message-backfill.test.ts test/session/message-backfill.contract.test.ts test/session/session-v2-message-backfill.test.ts
bun --cwd packages/core typecheck
bun --cwd packages/opencode test test/session/processor-effect.test.ts test/session/prompt.test.ts test/server/httpapi-session.test.ts test/session/message-v2-model.test.ts test/session/message-v2-context.test.ts
bun --cwd packages/opencode typecheck
```
