# WS Protocol — Optimization Findings

## Purpose

Analysis of how the TUI and Web UI handle WebSocket messages today, identifying
optimization opportunities from end to end — from server-side event emission
through protocol encoding to client-side state updates.

## Current data flow

```
EventV2.publish()
    │
    ▼
event-bridge.ts: events.listen(callback)
    │  callback fires per-event, calls conn.push()
    ▼
connection.ts: push() → Protocol.encode() [Brotli + MessagePack] → Queue.offer()
    │
    ▼
WebSocket frame → Client decode → handleMessage()
    │
    ├── TUI (sdk.tsx): handleEvent() → queue.push() → setTimeout(flush, 16ms)
    │       flush: batch(() => forEach(queue) → emitter.emit("event", e))
    │
    └── Web UI (server-ws.tsx): onEvent() → emitter.emit(directory, event)
            ⚠️ NO batching — each event is a separate SolidJS reactivity cycle
```

## Findings

### Finding 1 (CRITICAL): No server-side event batching

**What**: Every EventV2 event becomes a separate `conn.push()` → Brotli encode
→ WebSocket frame. During active streaming (text deltas arrive at
sub-100ms intervals), this creates dozens of tiny frames per second.

**Where**: `packages/opencode/src/server/ws/event-bridge.ts:16-32`

The bridge defines `BATCH_INTERVAL_MS = 16` on line 6 but never uses it.
Each event from `EventV2.listen()` is immediately pushed:

```ts
// current - every event becomes a separate frame
const unsubscribe = yield* events.listen((event) =>
  Effect.gen(function* () {
    yield* conn.push({ type: "push.event", ... })
  }),
)
```

**Impact**:
- 10 text deltas/sec = 10 Brotli compressions + 10 Queue offers + 10 WS frames
- Brotli compression overhead dominates for tiny payloads (< 64 bytes raw)
- Each frame has WebSocket framing overhead (2-10 bytes)
- Queue backpressure check runs per-event instead of per-batch

**Portion of total frames**: During streaming, `push.event` frames account for
~70-90% of all WS traffic. A single agent loop produces 5-20 events/sec
(text deltas, tool starts/completes, status updates).

**Fix**: Accumulate events over a 16ms window, flush as a single batched frame.

### Finding 2 (CRITICAL): Web UI lost SSE batching on WS migration

**What**: The legacy SSE handler (`server-sdk.tsx`) had sophisticated batching:
- 16ms micro-batch window (16ms)
- Coalescence: same-key events (e.g., same session status) replace previous
- Stale delta skipping: rapid `message.part.delta` for same part drops old
- `SolidJS batch()` wrapping for single reactivity cycle

The WS handler (`server-ws.tsx`) has **none** of this. Every `push.event` is
processed immediately:

```tsx
// server-ws.tsx:69-73 — no batching
ws.onEvent((event: WsPushEvent) => {
  const directory = event.directory ?? "global"
  emitter.emit(directory, event)  // fires individually
})
```

**Impact**: During active streaming, the Web UI takes a 3-10x hit in reactivity
cycles compared to the SSE path. Each text delta triggers component re-renders.

**Fix**: Raft the SSE batching logic (16ms window + RAF + `batch()` + coalesce)
into the WS handler. Identical pattern, different transport.

### Finding 3 (HIGH): No session metadata delta model

**What**: When a single session changes (status switch, new message, time
update), the only mechanism to update the UI's session list is through
`push.event` with `session.updated` / `session.status` events. The client
receives these events and must:
1. Decode the event
2. Route it through the event emitter
3. Find which session in the store it applies to
4. Merge properties

For a session list of 50 sessions, a single `session.updated` event triggers
O(n) work in the renderer.

**Proposed**: A `push.meta` frame that carries targeted patches:

```msgpack
{ type: "push.meta", sessions: {
  "ses_abc": { status: "busy", time: { updated: 1718123456789 } },
  "ses_def": { preview: "Here's your analysis...", messageCount: 42 },
}}
```

The client applies these as direct store patches: `setStore("sessions", idx, patch)`.

This sidesteps the event processing pipeline for metadata-only updates and
reduces rendering work to O(1) per changed session.

### Finding 4 (MEDIUM): Static data re-sent on every reconnect

**What**: `push.snapshot` page 1 includes config, MCP status, providers, and
projects. These rarely change but are re-sent on every reconnect. On reconnect,
the client already has these from the initial connect.

**Current snapshot** (`snapshot.ts:57-62`):
```ts
if (page === 0) {
  frame.config = config     // ~2-10 KiB
  frame.mcp = mcpStatus     // ~1-50 KiB (grows with MCP servers)
  frame.providers = providers
  frame.projects = projects
}
```

For a reconnect with 100 events missed, the client gets all this static data
again — plus 500 replay events — before seeing `caught-up`.

**Proposed**: Separate `push.static` frame sent once on initial connect.
Reconnect sends only `push.snapshot` (sessions) + replay events. If static
data changes during the connection, send a dedicated `push.static` update.

### Finding 5 (LOW): Per-frame Brotli for tiny events wastes CPU

**What**: Every `push.event` frame is Brotli-compressed individually. For
small text deltas (2-50 bytes), the Brotli encode/decode overhead exceeds
the raw payload size. Compression ratio is worse because there's no shared
dictionary across frames.

**Relationship to Finding 1**: Batching solves this naturally — a batch of
20 events compressed together shares dictionary state and amortizes the cost.

If batching is not viable for some frames, consider skipping Brotli for
frames under a configurable threshold (e.g., 64 bytes raw MessagePack).

### Finding 6 (LOW): Snapshot pagination is naive

**What**: `push.snapshot` sends 10 sessions per page. The client must receive
all pages. For 1,000 sessions, that's 100 frames. The client can't request
specific pages or cancel after visible sessions are rendered.

**Current** (`snapshot.ts:32-65`):
```ts
for (let page = 0; page < totalPages; page++) {
  yield* conn.push({ type: "push.snapshot", page, sessions: pageSessions, ... })
}
```

The protocol spec already acknowledges this as an open question (line 1307).
The recommendation was to stream all pages with client-side cancellation.

**Proposed**: Allow client to send `session.list` for paginated/cursor-based
queries beyond what `push.snapshot` provides. Snapshot pages 1-2 render the
visible portion; additional sessions are fetched on scroll.

### Finding 7 (NOTE): TUI batching is adequate

**What**: The TUI's event handling (`sdk.tsx:48-59`) already micro-batches
at 16ms with `batch()` wrapping. This is the same pattern as the legacy SSE
handler in the Web UI. The TUI is fine — the regression is Web UI only.

## Proposed protocol changes

### New message type: `push.batch`

```msgpack
// Server → Client
{ type: "push.batch", events: [
  { directory, project, workspace, payload: { id, type, properties } },
  { directory, project, workspace, payload: { id, type, properties } },
  ...
]}
```

**Server implementation** (event-bridge.ts):
```ts
const BATCH_WINDOW_MS = 16

export function bridge(conn: Connection, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const batch = yield* Ref.make<PushEvent[]>([])
    const events = yield* EventV2.Service

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const payload = EventV2.encodeKnownPayloadForFanout(event)
        if (!payload) return
        const ctx = yield* InstanceRef
        yield* Ref.update(batch, (arr) => [...arr, {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: (yield* WorkspaceRef) ?? event.location?.workspaceID,
          payload: { id: payload.id, type: payload.type, properties: payload.data },
        }])
      }),
    )

    // Flusher: drain batch every 16ms
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(BATCH_WINDOW_MS)
          const items = yield* Ref.getAndSet(batch, [])
          if (items.length === 0) continue
          if (items.length === 1) {
            yield* conn.push({ type: "push.event", ...items[0] })
          } else {
            yield* conn.push({ type: "push.batch", events: items })
          }
        }
      }),
      scope,
    )

    yield* Scope.addFinalizer(scope, unsubscribe)
  })
}
```

**Client handling** (SDK `ws/index.ts`):
```ts
if (msg.type === "push.batch") {
  // Fire all events in a single frame callback cycle
  for (const event of (msg as WsPushBatch).events) {
    for (const h of this.eventHandlers) h(event)
  }
}
```

**Client handling** (Web UI `server-ws.tsx`):
```ts
ws.onEvent((event: WsPushEvent) => {
  // Events from push.batch arrive in rapid succession — batch them
  eventQueue.push(event)
  if (!scheduled) {
    scheduled = true
    requestAnimationFrame(() => {
      batch(() => {
        for (const e of eventQueue) emitter.emit(e.directory, e)
        eventQueue.length = 0
      })
      scheduled = false
    })
  }
})
```

### New message type: `push.meta`

```msgpack
// Server → Client
{ type: "push.meta", sessions: {
  "ses_abc": { status: "busy", time: { updated: 1718123456789 } },
  "ses_def": { preview: "Here's the analysis...", messageCount: 42 },
}}
```

**Server**: Emitted by the event bridge when session metadata changes (status,
title, time, preview, message count). Batched alongside `push.batch` or sent
standalone.

**Client** (Web UI): `ws.onMeta((meta) => { ... })` handler that patches the
solid-js store directly — no event emitter routing needed.

### New message type: `push.static`

```msgpack
// Server → Client (on initial connect only)
{ type: "push.static", config: ..., mcp: ..., providers: ..., projects: ... }
```

**Server**: Sent exactly once on initial connect (before `push.snapshot`).
Not re-sent on reconnect. If static data changes, a separate `push.static`
update is sent with only the changed fields.

**Client**: Stores static data separately from session list. On reconnect,
session list is re-sent via `push.snapshot`; static data is not re-sent.

### Updated `push.snapshot`

After `push.static` separation, `push.snapshot` carries only sessions:

```msgpack
{ type: "push.snapshot", page: 1, totalPages: N, sessions: [SessionMeta, ...] }
```

Page 1 no longer carries config/mcp/providers/projects.

## Proposed non-protocol improvements

### 1. Web UI batching parity

Extract the batching logic from legacy `server-sdk.tsx:50-95` and apply it to
`server-ws.tsx`. Key elements:

- **16ms window**: `setTimeout(flush, 16)` or `requestAnimationFrame`
- **Redraw coalescence**: Newer event for same key replaces older in batch
- **SolidJS `batch()`**: Single reactivity cycle for the flush
- **Stale delta skip**: During batch, drop old `message.part.delta` for same
  (messageID, partID) in favor of the newest

### 2. Selective Brotli bypass

Skip Brotli for raw MessagePack frames under 64 bytes. The per-frame Brotli
overhead (dictionary build + header) is larger than the payload at that size.

```ts
// protocol.ts
const BROTLI_MIN_BYTES = 64

export async function encode(value: unknown): Promise<Uint8Array> {
  const packed = encodeMsgpack(value)
  if (packed.length < BROTLI_MIN_BYTES) return packed  // send raw
  return brotli.compress(packed, { quality: 4 })
}
```

The first byte of the frame indicates compression (0x00 = raw, 0x01 = Brotli).

### 3. Session list virtual scrolling awareness

When the client has many sessions (100+) and only the first 20 are visible,
the server should not push metadata updates for off-screen sessions at full
rate. There's no protocol change for this yet — it requires the client to
communicate its viewport. Defer to a future iteration.

## Priority ranking

| # | Finding | Priority | Protocol change | Impact |
|---|---------|----------|----------------|--------|
| 1 | Server-side event batching | **CRITICAL** | New `push.batch` type | 10-50x fewer frames during streaming, 3-5x better Brotli ratio, single client-side reactivity cycle |
| 2 | Web UI batching parity | **CRITICAL** | None (client-only) | 3-10x fewer SolidJS reactivity cycles, identical behavior to SSE path |
| 3 | Session metadata deltas | **HIGH** | New `push.meta` type | O(n) → O(1) per session metadata change, avoids event pipeline for metadata |
| 4 | Separate static data | **MEDIUM** | New `push.static` type + simplify `push.snapshot` | Reconnect payload 20-60% smaller, faster `caught-up` |
| 5 | Selective Brotli bypass | **LOW** | Frame header byte | Marginal CPU savings for tiny frames |
| 6 | Snapshot pagination API | **LOW** | `session.list` already exists | Avoid pushing 1,000 session snapshots for extreme project sizes |

## Validation strategy

1. **Server-side batch correctness**: Unit test that events accumulated over
   N ms are flushed as a single `push.batch` frame, that single events in a
   window still emit as `push.event`, and that zero-event windows produce
   no frame.
2. **Web UI reactivity count**: Profile render cycles during a streaming prompt
   before and after batching. Target: ≤ 17 renders/sec (one per RAF frame at
   60fps), down from 60-200/sec currently.
3. **Brotli ratio comparison**: Compare compressed size of 100 individual
   `push.event` frames vs 1 `push.batch` frame with 100 events. Expected
   reduction: 30-50% for the batch.
4. **Reconnect payload size**: Measure `push.snapshot` page 1 size before and
   after `push.static` separation.

## Open questions

1. **Batch window tuning**: 16ms matches the TUI pattern, but `requestAnimationFrame`
   (which adapts to display refresh rate) may be better for the Web UI. Should
   the server use a different window for different client types? Recommendation:
   use 16ms server-side; client can batch at RAF rate independently.

2. **`push.batch` vs `push.event` during non-streaming**: Should the server
   always batch, even for isolated events (1 event/window)? If so, is
   `push.event` deprecated in favor of a `push.batch` with 1 event? Recommendation:
   keep `push.event` for single events to avoid the array wrapper; use
   `push.batch` only when 2+ events accumulate.

3. **Backward compatibility**: Old clients don't handle `push.batch`.
   The `hello` response should include a `protocolVersion` or capabilities
   flag so the server knows whether to batch. Until then, logging/feature
   flag control.

4. **Coalescence server-side vs client-side**: The legacy SSE batching does
   coalescence client-side (same-key events replace). Server-side coalescence
   would reduce bandwidth further but requires the server to understand event
   deduplication semantics. Recommendation: keep coalescence client-side for
   now; server-side batching is for framing efficiency only.
