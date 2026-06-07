# WebSocket Binary Protocol — Unified Transport

## Purpose

Replace the current multi-transport architecture (HTTP REST + SSE for real-time + separate
PTY WebSocket) with a single multiplexed WebSocket connection carrying all UI-facing session
data, events, PTY I/O, MCP status, and configuration over MessagePack binary frames. This
eliminates the round-trip overhead of 8+ REST calls per session view and reduces payload size
by 30–50% versus JSON SSE.

## Goals

- **Single persistent connection**: One WebSocket serves all server→client push, client→server
  requests, and PTY terminal I/O for the UI-facing transport.
- **Binary encoding with Brotli compression**: MessagePack-encoded frames compressed
  with Brotli (application layer) on top of WebSocket `permessage-deflate` (transport
  layer). Raw `Uint8Array` for large content: tool outputs, PTY buffers, file contents.
  Expected 60–80% size reduction vs current JSON SSE.
- **Request/response multiplexing**: Client-generated `requestID` allows concurrent requests
  over a single connection.
- **Push-based session state**: On connect, the server pushes full metadata for every session
  in the project (name, path, color, activity status, last message preview). The client
  maintains a live store updated in real-time — no REST round-trips when clicking a session.
- **Efficient reconnect**: Reconnect replays only durable session events missed since the last
  known `EventV2.Cursor` (per-session aggregate), then re-synchronizes current state snapshots
  for non-durable UI context — no full REST re-fetch of every session.
- **Controlled resource usage**: Per-connection bounded queues, maximum frame sizes, and
  slow-consumer protection prevent one misbehaving client from exhausting server memory.

## Non-goals

- Replacing the internal `EventV2` pub/sub system. The WS transport is a *client-facing*
  adapter layer sourced from the existing event bus and service layer. It translates
  internal events into wire frames without altering the event system itself.
- Changing the `EventV2` persistence model, database schema, or cursor semantics.
- Supporting Server-Sent Events from within the WS protocol. SSE remains available for
  control-plane workspace sync; it is not used for UI-facing transport once WS is active.
- Protocol-level encryption (depends on TLS at the WebSocket transport layer).
- Binary protocol for MCP server-to-server transport (MCP transport remains unchanged).
- Replacing control-plane workspace sync (`/global/event`, `/sync/history`, `/sync/steal`).
  These endpoints remain as REST/SSE for cross-instance synchronization.

### Architecture: thin adapter over EventV2

The WS transport is designed as a *presentation adapter*, not a rewrite of the event system.
This keeps the change surface small for upstream merges:

- The server-side WS handlers call existing `Session.Service`, `MCP.Service`, `Pty.Service`,
  etc. unchanged. No service API changes are needed.
- The event bridge subscribes to `EventV2.listen()` — the same listener API used by the
  existing `EventV2Bridge` → `GlobalBus` → SSE path. It produces the same envelope shape.
- All WS message types map 1:1 to existing HTTP endpoint handlers. A future change to the
  core event layer (new event types, schema changes) requires only updating the WS adapter's
  event bridge — not the protocol itself.

## Current state

### Transport architecture

The current client transport uses three separate channels:

| Channel | Protocol | Direction | Purpose |
|---------|----------|-----------|---------|
| HTTP REST (~70 endpoints) | JSON | Request/response | Session CRUD, messages, MCP status, config, providers, files, commands, agents, skills, LSP, permissions, questions |
| SSE (`/event`, `/global/event`, `/api/event`) | JSON text/event-stream | Server→Client | Real-time events (session lifecycle, message updates, V2 streaming deltas) |
| PTY WebSocket (`/pty/:ptyID/connect`) | Raw bytes | Bidirectional | Terminal I/O |

### Request count per session view (current vs target)

**Current (REST+SSE)** — loading a single session:

1. `GET /global/event` — SSE connection (open-ended)
2. `GET /session/:id` — session metadata
3. `GET /session/:id/message` — message list (paginated)
4. `GET /session/:id/todo` — todo items
5. `GET /session/:id/diff` — VCS diff summary
6. `GET /session/:id/children` — child sessions
7. `GET /mcp` — MCP server status
8. `GET /config` — configuration

Total: **8+ round-trips** per session view, plus pagination for large conversations.
Connecting to a new project repeats steps 2–8 for every session you click.

**Target (WS push-all model)** — the entire project state arrives on connect:

1. WebSocket connect to `/ws` → server pushes session list, MCP status, config, project list
   **in a single connection handshake**.
2. Session metadata for **all sessions** in the project arrives as push events and stays
   live (activity indicators, status changes, new/deleted sessions).
3. When the user clicks a session: messages are either already pre-fetched in the background,
   or loaded via a single `session.messages` WS request.
4. Non-changing data (project name, path, color, provider list) is pushed once on connect
   and updated only when it actually changes.

Total: **0 round-trips** on session click (metadata already present), **1 request**
for messages if not pre-fetched. Session metadata updates arrive as push events in
real-time without any polling.

### Event flow

```
LLM Loop → EventV2.publish() → DB (durable sync events) + PubSub (all events)
                                       ↓
                                    notify()
                                       ↓
                listeners (EventV2Bridge) → GlobalBus.emit("event")
                                       ↓
                          SSE Handler (Stream.callback → unbounded Queue)
                                       ↓
                        Client (SSE read loop with reconnect)
```

### EventV2 cursor model (facts)

- `EventV2.Cursor` is a branded non-negative integer (`NonNegativeInt`), **not** a timestamp.
  Source: `packages/core/src/event.ts:21-26`.
- `aggregateEvents({ aggregateID, after?: Cursor })` replays events for a single aggregate
  where `seq > after`, ordered by ascending `seq`. Source: `event.ts:587-609`.
- Only **durable sync events** are persisted with `seq` numbers and are replayed via
  `aggregateEvents`. Ephemeral events (deltas) are not stored.
  Source: `event.ts:420-433`, `packages/core/src/session/event.ts`.
- Each session has its own aggregate ID (the `sessionID`) for its durable events.
  Source: `packages/core/src/session/event.ts` — sync events carry `sessionID` as
  their aggregate field.
- The global event DB table `EventTable` has columns `id`, `aggregate_id`, `seq`, `type`,
  `data` (JSON). No global timestamp column. Source: `packages/core/src/event/sql.ts:10-20`.

### Key files

| File | Role |
|------|------|
| `packages/opencode/src/bus/global.ts` | `GlobalBus` — process-wide EventEmitter bridging EventV2 to SSE |
| `packages/opencode/src/event-v2-bridge.ts` | EventV2 listener → GlobalBus fanout (`{ directory, project, workspace, payload: { id, type, properties } }`) |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` | Instance SSE stream (unbounded queue) |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` | Global SSE stream (callback-based) |
| `packages/server/src/groups/v2/event.ts` | v2 SSE route definition |
| `packages/core/src/event.ts` | `EventV2` — durable event engine, `aggregateEvents()`, cursor model |
| `packages/core/src/event/sql.ts` | EventTable Drizzle schema |
| `packages/core/src/session/message.ts` | `SessionMessage` types |
| `packages/core/src/session/event.ts` | V2 session event definitions (`session.next.*` durable + ephemeral) |
| `packages/sdk/js/src/v2/gen/client/client.gen.ts` | Generated HTTP+SSE client |
| `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts` | SSE parser with retry |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/pty.ts` | PTY WebSocket (Effect `Socket` upgrade pattern) |
| `packages/app/src/context/server-sdk.tsx` | Web UI SSE consumer with batching/coalescing/reconnect |
| `packages/app/src/context/server-sync.tsx` | Web UI sync orchestrator |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts` | Auth middleware (Basic `Authorization`, `auth_token` query param) |
| `packages/opencode/src/server/cors.ts` | CORS/origin validation helpers |
| `packages/opencode/src/control-plane/workspace.ts` | Remote workspace sync consumer (SSE + `/sync/*`) |

## Target architecture

### Transport: single WebSocket at `/ws`

One persistent WebSocket connection carries all UI-facing server→client push, client→server
requests, and PTY terminal I/O. Existing services (`Session.Service`, `MCP.Service`, etc.)
are called directly from WS message handlers — no restructuring of the internal service layer.

The existing Effect `Socket` service (`effect/unstable/socket/Socket`) provides the transport.
The PTY handler already demonstrates `request.upgrade`, `socket.runRaw`, scoped `writer`, and
`CloseEvent` patterns that the new transport reuses.

```
Client                                            Server
  |                                                  |
  |--- [HTTP GET /ws?auth_token=...] upgrade ------> |
  |      Origin: validated                            |
  |                                                  |
  |<-- { type: "hello", serverVersion } -----------  | (auth + scope decided)
  |                                                  |
  |--- { type: "sync.catchup", cursors: {...} } -->  | (optional: per-aggregate cursors)
  |                                                  |
  |<-- durable events (replayed per session agg) ---  |
  |<-- { type: "push.snapshot", sessions: [...],    |
  |      config: {...}, projects: [...],             |
  |      mcp: {...}, providers: [...] } -----------  |
  |      ^-- full metadata for ALL sessions          |
  |          in the project at connect time           |
  |<-- { type: "caught-up" } ----------------------   |
  |                                                  |
  |=========== Normal operation ===================  |
  |                                                  |
  |<-- { type: "push.event", ... } ----------------  | (session metadata changes, activity, etc.)
  |<-- { type: "push.event", ... } ----------------  | (message deltas for open sessions)
  |                                                  |
  |--- { type: "session.messages", requestID, ... }->| (explicit load when opening a session)
  |<-- { type: "response", requestID, data } -----   |
  |                                                  |
  |--- { type: "ping" } ---------------------------> |
  |<-- { type: "pong" } --------------------------   |
  |                                                  |
  |=========== Disconnect =========================  |
  |                                                  |
  |--- [WebSocket reconnect] /ws?auth_token=... ---> |
  |<-- { type: "hello" } -------------------------   |
  |--- { type: "sync.catchup", cursors } ----------> |
  |<-- replayed events + snapshot -----------------   |
  |<-- { type: "caught-up" } ---------------------   |
  |=========== Normal operation resumed ===========  |
```

### Protocol framing

**One MessagePack object per WebSocket message. No inner length prefix.** WebSocket
already delivers messages as complete frames — adding a 4-byte prefix is redundant.

- The WebSocket uses `binaryType: "arraybuffer"` and `permessage-deflate` compression
  (enabled by default via the server's WebSocket upgrade negotiation).
- Each WS message is a single self-contained MessagePack-encoded object.
- The Effect `Socket.runRaw` handler receives `Uint8Array` frames, which are passed
  directly to the MessagePack decoder.
- Maximum inbound frame size: **4 MiB** (configurable). Frames exceeding this close
  the connection with code `1009` (message too big).
- Outbound frames for large payloads (file reads, tool outputs > 1 MiB) use a chunked
  envelope:

  ```msgpack
  { type: "chunk.start", chunkID: string, totalChunks: uint, payloadType: string }
  { type: "chunk.data", chunkID: string, index: uint, data: Uint8Array }
  { type: "chunk.end", chunkID: string }
  ```

### Push-based session model

Instead of the current lazy-load pattern (8+ REST calls when clicking a session), the
WS transport pushes session state eagerly and keeps it live:

#### On connect: paginated snapshot

The server sends `push.snapshot` frames containing session metadata, paginated at
**10 sessions per frame**. For a project with 50 sessions, the server sends 5
snapshot frames. This keeps each frame small and allows the client to render the
first page of sessions immediately while later pages arrive:

```msgpack
// Page 1 (first 10 sessions)
{ type: "push.snapshot",
  page: 1,
  totalPages: 5,
  sessions: [{
    id: SessionID,
    parentID?: SessionID,
    title: string,
    path: string,             // project directory
    projectID: string,
    status: "idle" | "busy",
    time: { created: number, updated: number, archived?: number },
    preview: string,          // last message preview (first ~200 chars)
    messageCount: number,
    model?: string,           // active model name (for display)
    agent?: string,           // active agent name (for display)
    color?: string,           // project color
    hasUnread?: boolean,
  }],
  projects: ProjectInfo[],    // sent on page 1 only
  config: Config,             // sent on page 1 only
  mcp: McpStatus,             // sent on page 1 only
  providers: ProviderList,    // sent on page 1 only
}
```

Non-session data (projects, config, MCP, providers) is included **only in page 1**.
Subsequent pages contain only the `sessions` array. This avoids redundant
retransmission of rarely-changing data.

This means the Web UI can render the session list immediately after connect with
every session's name, activity indicator, preview, and project color — zero
additional round-trips.

#### Live metadata updates

As sessions change, the server pushes metadata deltas as `push.event` frames using
the existing `session.created`, `session.updated`, `session.deleted` event types
(already emitted by the session service — no new event types needed):

```msgpack
{ type: "push.event", directory, project, workspace,
  payload: { type: "session.updated", properties: { sessionID, info: { time: { updated } } } } }
```

The client merges these into its local session store. Activity indicators update
in real-time without polling.

#### Message loading

Messages are loaded on demand when a session is opened. The server **pre-fetches**
messages for sessions likely to be opened, so they render immediately on click:

- **Desktop Web**: Pre-fetch messages for all sessions currently open in browser
  tabs, plus any session with an active (running) agent loop.
- **Mobile / single-tab**: Pre-fetch messages for sessions the user has recently
  clicked on (tracked client-side as "recently viewed"), plus any session with an
  active agent loop.

The server tracks which sessions have been requested for pre-fetch via a
`session.subscribe` message:

```msgpack
// Client → Server: request pre-fetch for these sessions
{ type: "session.subscribe", sessionIDs: string[] }

// Client → Server: stop pre-fetch for these sessions
{ type: "session.unsubscribe", sessionIDs: string[] }
```

1. Client connects, receives paginated snapshot with session metadata.
2. Client sends `session.subscribe` for open tabs + running sessions.
3. Server begins pushing `push.event` frames for subscribed sessions (message
   deltas, tool results, etc.).
4. User clicks session `ses_abc` — if subscribed, messages are already present
   from pre-fetched events. If not subscribed, client sends `session.messages`
   request, then `session.subscribe`.
5. When user closes a tab or navigates away, client sends `session.unsubscribe`.
   Server stops pre-fetching for that session.

#### Non-changing data

Project names, paths, colors, provider lists, and config rarely change. On connect,
the server pushes the full current state in `push.snapshot`. After that, updates
arrive only when the data actually changes (via `push.event` for `project.created`,
`config.updated`, etc.). The client never needs to poll or re-request this data.

### Message types

Every message has a `type` field. Requests carry a client-generated `requestID`.
Responses echo it. Server push messages have no `requestID`.

#### Event envelope

Server push events use the **existing GlobalBus shape** exactly, since both the Web UI
and TUI already have reducers for it. This avoids defining a new event contract:

```msgpack
// Standard push event (same shape as current SSE payloads)
{ type: "push.event", directory?: string, project?: string, workspace?: string, payload: { id: string, type: string, properties: object } }

// Sync events (workspace replay)
{ type: "push.event", ..., payload: { type: "sync", syncEvent: { id, type, seq, aggregateID, data } } }
```

This maps 1:1 to what `EventV2Bridge` currently emits on `GlobalBus`:
`packages/opencode/src/event-v2-bridge.ts:50-55`.

No separate `push.session.*`, `push.message.*` message types are needed. The existing
Web UI reducer (`event-reducer.ts:104-305`) and TUI sync (`sync.tsx`) process events
by `payload.type` — those reducer paths stay unchanged.

**Derived push types are NOT sent.** The server sends `push.event` only. Clients apply
events through their existing reducer logic. This avoids event duplication and ordering
ambiguity.

#### Client → Server (Requests)

```msgpack
// ===== Connection lifecycle =====

// Bootstrap: initial state snapshot for one directory (first connection)
{ type: "boot", requestID: string, directory?: string }

// Reconnect catchup with per-aggregate cursor state
{ type: "sync.catchup", cursors: { [aggregateID: string]: lastSeq: number } }

// Keepalive
{ type: "ping" }


// ===== Sessions =====

{ type: "session.list", requestID, cursor?: string, limit?: number, directory?: string }
{ type: "session.get", requestID, sessionID }
{ type: "session.create", requestID, idempotencyID: string, directory?: string, forkFrom?: SessionID, init?: boolean }
{ type: "session.delete", requestID, sessionID, idempotencyID: string }
{ type: "session.update", requestID, sessionID, patch, idempotencyID: string }
{ type: "session.fork", requestID, sessionID, idempotencyID: string }
{ type: "session.share", requestID, sessionID }
{ type: "session.unshare", requestID, sessionID }
{ type: "session.summarize", requestID, sessionID }
{ type: "session.revert", requestID, sessionID, messageID, idempotencyID: string }
{ type: "session.unrevert", requestID, sessionID, messageID, idempotencyID: string }
{ type: "session.children", requestID, sessionID }
{ type: "session.context", requestID, sessionID }
{ type: "session.messages", requestID, sessionID, cursor?, limit?, order?: "asc" | "desc" }
{ type: "session.todo", requestID, sessionID }
{ type: "session.diff", requestID, sessionID }
{ type: "session.status", requestID, sessionID }
{ type: "session.abort", requestID, sessionID }
{ type: "session.init", requestID, sessionID, idempotencyID: string }

// Pre-fetch subscription: server pushes events for these sessions
{ type: "session.subscribe", sessionIDs: string[] }
{ type: "session.unsubscribe", sessionIDs: string[] }

// Prompt: admits input, returns admitted ID immediately; execution follows via push events
{ type: "session.prompt", requestID, idempotencyID: string, sessionID, prompt: Prompt, delivery?: "steer" | "queue", resume?: boolean }

// Synchronous operations that return immediately
{ type: "session.command", requestID, idempotencyID: string, sessionID, command: string }
{ type: "session.shell", requestID, idempotencyID: string, sessionID, command: string, ... }


// ===== Messages =====

{ type: "message.get", requestID, sessionID, messageID }
{ type: "message.delete", requestID, sessionID, messageID, idempotencyID: string }
{ type: "message.part.delete", requestID, sessionID, messageID, partID, idempotencyID: string }
{ type: "message.part.update", requestID, sessionID, messageID, partID, idempotencyID: string, patch }


// ===== MCP =====

{ type: "mcp.status", requestID }
{ type: "mcp.connect", requestID, name: string }
{ type: "mcp.disconnect", requestID, name: string }
{ type: "mcp.auth", requestID, name: string }               // POST /mcp/:name/auth
{ type: "mcp.auth.callback", requestID, name: string, ... } // POST /mcp/:name/auth/callback
{ type: "mcp.auth.authenticate", requestID, name: string }  // POST /mcp/:name/auth/authenticate
{ type: "mcp.auth.remove", requestID, name: string }        // DELETE /mcp/:name/auth


// ===== Configuration =====

{ type: "config.get", requestID }
{ type: "config.update", requestID, config, idempotencyID: string }
{ type: "config.providers", requestID }


// ===== Providers =====

{ type: "provider.list", requestID }
{ type: "provider.auth", requestID }                        // GET /provider/auth status
{ type: "provider.authorize", requestID, providerID }       // POST /provider/:id/oauth/authorize
{ type: "provider.callback", requestID, providerID, ... }   // POST /provider/:id/oauth/callback


// ===== Authentication =====

{ type: "auth.put", requestID, providerID, ... }
{ type: "auth.delete", requestID, providerID }


// ===== Project / workspace =====

{ type: "project.list", requestID }
{ type: "project.current", requestID }                      // GET /project/current
{ type: "project.directories", requestID, projectID }
{ type: "project.update", requestID, projectID, patch, idempotencyID: string }
{ type: "project.init", requestID, idempotencyID: string }  // POST /project/git/init
{ type: "project.reload", requestID }                       // POST /project/reload
{ type: "path.get", requestID, directory }


// ===== Files =====

{ type: "file.read", requestID, path: string }
{ type: "file.find", requestID, query: string }
{ type: "file.find.file", requestID, query: string }
{ type: "file.find.symbol", requestID, query: string }
{ type: "file.status", requestID, path: string }


// ===== VCS =====

{ type: "vcs.status", requestID, directory }
{ type: "vcs.diff", requestID, directory, raw?: boolean }
{ type: "vcs.apply", requestID, directory, patch, idempotencyID: string }


// ===== Commands, agents, skills, LSP, formatters =====

{ type: "command.list", requestID, directory }
{ type: "agent.list", requestID, directory }
{ type: "skill.list", requestID, directory }
{ type: "lsp.status", requestID, directory }
{ type: "formatter.status", requestID, directory }


// ===== PTY =====

{ type: "pty.list", requestID }
{ type: "pty.shells", requestID }                           // GET /pty/shells
{ type: "pty.get", requestID, ptyID }
{ type: "pty.create", requestID, command, args?, env?, size?, idempotencyID: string }
{ type: "pty.update", requestID, ptyID, size }
{ type: "pty.resize", requestID, ptyID, size }
{ type: "pty.close", requestID, ptyID }
{ type: "pty.connect-token", requestID, ptyID }             // POST /pty/:id/connect-token

// Fire-and-forget (no requestID, no response needed)
{ type: "pty.input", ptyID, data: Uint8Array }


// ===== Permissions & questions =====

{ type: "permission.list", requestID }
{ type: "permission.reply", requestID, permissionRequestID, reply, idempotencyID: string }
{ type: "question.list", requestID }
{ type: "question.reply", requestID, questionRequestID, reply, idempotencyID: string }
{ type: "question.reject", requestID, questionRequestID, idempotencyID: string }


// ===== TUI control =====

{ type: "tui.append", requestID, text: string }             // POST /tui/append-prompt
{ type: "tui.submit", requestID, text: string }             // POST /tui/submit-prompt
{ type: "tui.clear", requestID }                            // POST /tui/clear-prompt
{ type: "tui.execute", requestID, command: string }         // POST /tui/execute-command
{ type: "tui.select", requestID, sessionID }                // POST /tui/select-session
{ type: "tui.publish", requestID, event }                   // POST /tui/publish
{ type: "tui.show-toast", requestID, toast }                // POST /tui/show-toast
{ type: "tui.open-help", requestID }
{ type: "tui.open-sessions", requestID }
{ type: "tui.open-themes", requestID }
{ type: "tui.open-models", requestID }
{ type: "tui.control.next", requestID }                     // GET /tui/control/next
{ type: "tui.control.response", requestID, ... }            // POST /tui/control/response


// ===== Instance & global =====

{ type: "global.health", requestID }                        // GET /global/health
{ type: "global.config", requestID }                        // GET /global/config
{ type: "global.config.update", requestID, config, idempotencyID: string }
{ type: "global.dispose", requestID }                       // POST /global/dispose
{ type: "global.upgrade", requestID }                       // POST /global/upgrade
{ type: "instance.dispose", requestID }                     // POST /instance/dispose


// ===== Experimental =====

{ type: "experimental.console", requestID }
{ type: "experimental.console.orgs", requestID }
{ type: "experimental.console.switch", requestID, org }
{ type: "experimental.tool", requestID }
{ type: "experimental.tool.ids", requestID }
{ type: "experimental.worktree", requestID }
{ type: "experimental.worktree.create", requestID, ... }
{ type: "experimental.worktree.delete", requestID, ... }
{ type: "experimental.worktree.reset", requestID, ... }
{ type: "experimental.resource", requestID }                // MCP resources
{ type: "experimental.workspace", requestID }
{ type: "experimental.workspace.status", requestID }
{ type: "experimental.workspace.create", requestID, ... }
{ type: "experimental.workspace.delete", requestID, id }
{ type: "experimental.workspace.sync-list", requestID, ... }
{ type: "experimental.workspace.warp", requestID, ... }
{ type: "experimental.workspace.adapter", requestID }
{ type: "experimental.session", requestID }
```

#### Server → Client (Push / Events)

```msgpack
// Connection lifecycle
{ type: "hello", serverVersion: string }

// Full snapshot of all sessions + config + projects + MCP + providers
// Sent on first connect and after sync.catchup
{ type: "push.snapshot",
  sessions: SessionMeta[],     // all sessions in the project
  projects: ProjectInfo[],
  config: Config,
  mcp: McpStatus,
  providers: ProviderList }

// After sync.catchup + push.snapshot complete
{ type: "caught-up" }

// Standard push event (same envelope as current SSE)
{ type: "push.event", directory?: string, project?: string, workspace?: string, payload: { id: string, type: string, properties: object } }

// Sync event (workspace replay — same shape as current SSE)
{ type: "push.event", ..., payload: { type: "sync", syncEvent: { id, type, seq, aggregateID, data } } }

// PTY output
{ type: "push.pty.output", ptyID, data: Uint8Array }
{ type: "push.pty.closed", ptyID }

// Server lifecycle
{ type: "push.server.disposed" }

// Keepalive response
{ type: "pong" }
```

#### Server → Client (Responses)

```msgpack
// Every request gets exactly one response frame
{ type: "response", requestID: string, ok: true, data?: any }
{ type: "response", requestID: string, ok: false, error: { code: string, message: string } }
```

### MessagePack encoding guidelines

1. Object values use MessagePack maps (field names as string keys).
2. Binary content (PTY output, file reads, tool output blobs) uses MessagePack `bin 8/16/32`
   type. This avoids base64 encode/decode overhead.
3. TypeScript `undefined` fields are omitted from maps (MessagePack has no `undefined`).
4. `null` is encoded explicitly where the protocol requires it.
5. Timestamps are encoded as integer milliseconds (consistent with existing
   `V2Schema.DateTimeUtcFromMillis`).
6. `EventV2.Cursor` (sequence numbers) are encoded as integers.
7. One MessagePack object per WebSocket frame. No inner framing, no multi-message packing.
8. Maximum frame size: **4 MiB**. Larger payloads use the chunked envelope
   (`chunk.start`/`chunk.data`/`chunk.end`).

### Compression

Two-layer compression:

1. **Application layer — Brotli**: Each MessagePack-encoded frame is compressed
   with Brotli (quality 4, default) before transmission as a binary WebSocket
   frame. The client decompresses with Brotli before MessagePack decoding.
   Brotli provides 20–40% better compression than deflate for text-heavy
   payloads like streaming text deltas and tool call results.

2. **Transport layer — `permessage-deflate`**: Enabled at the WebSocket upgrade
   handshake. Provides an additional compression pass for already-Brotli-compressed
   data (marginal gain for binary, helps fallback text frames).

Combined effect: MessagePack reduces JSON overhead by 30–50% (compact integer
encoding, no repeated keys). Brotli adds another 30–50% on top of that for
structured event payloads. Expected total size reduction vs current JSON SSE:
**60–80%**.

Brotli library: use the `brotli-wasm` package for isomorphic Node.js / browser
support (WASM-based, ~20 KiB gzipped). The encoder runs server-side; the decoder
runs in both the TUI (Node.js) and Web UI (browser).

### Request/response multiplexing

The client maintains a `Map<requestID, { resolve, reject, timer }>`. The server echoes
the `requestID` in the response frame. This supports concurrent requests over a single
connection.

```ts
// Client-side (conceptual)
class WsClient {
  private pending = new Map<string, PendingRequest>()
  private counter = 0n

  request<T>(type: string, payload: Record<string, unknown>, opts?: { timeout?: number }): Promise<T> {
    const requestID = `req_${this.counter++}`
    const frame = msgpack.encode({ type, requestID, ...payload })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID)
        reject(new TimeoutError(requestID, type))
      }, opts?.timeout ?? 60_000)
      this.pending.set(requestID, { resolve, reject, timer, type })
      this.send(frame)
    })
  }

  private handleResponse(msg: WsResponse) {
    if (msg.type !== "response") return
    const pending = this.pending.get(msg.requestID)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(msg.requestID)
    if (msg.ok) pending.resolve(msg.data)
    else pending.reject(new ServerError(msg.error.code, msg.error.message))
  }
}
```

**Timeout categories (server-side awareness not required):**

| Operation class | Client timeout | Behavior on timeout |
|----------------|---------------|---------------------|
| Admit-only (prompt, command, shell) | 30s | Server admits input; client receives push events for execution |
| Read-only (list, get, status) | 30s | Retry safe — no side effects |
| Long-running (summarize, compact) | 120s | Server completes asynchronously; client re-queries state |
| Mutating (create, delete, update, apply) | 60s | Must use idempotency key (see below) |

### Idempotency for mutating requests

Mutating requests carry an `idempotencyID: string`. The server stores recently processed
idempotency IDs (per-connection or globally, configurable TTL of 5 minutes) and returns
the cached response for duplicate IDs.

This prevents duplicate mutations when:
- A disconnect occurs after the server commits but before the response arrives.
- The client reconnects and re-issues pending requests.

**Safe to retry without idempotency**: All read-only operations (`*.list`, `*.get`,
`*.status`, `*.read`).

**Require idempotencyID**: `session.create`, `session.delete`, `session.update`,
`session.prompt`, `session.command`, `session.shell`, `session.revert`, `session.unrevert`,
`session.fork`, `session.init`, `vcs.apply`, `config.update`, `project.init`, `project.update`,
`pty.create`, `message.delete`, `message.part.delete`, `permission.reply`, `question.reply`,
`question.reject`.

**Never auto-retried**: The client does NOT automatically re-issue pending mutating requests
after reconnect. Instead, on reconnect, the client calls `sync.catchup` with cursors and the
server re-sends current state. The client reconciles — if a `session.create` was issued but
the session appears in the snapshot, the local pending request is resolved.

### Reconnect protocol

#### Client-side state across reconnects

The client tracks per-session cursor state (in memory; persisted to `sessionStorage` for the
Web UI across page loads):

```ts
interface ReconnectState {
  // Per-session-aggregate: last known EventV2.Cursor (seq number)
  cursors: Map<SessionID, number>
  // Set of session IDs the client is tracking
  trackedSessions: Set<SessionID>
}
```

#### Reconnect flow

1. **Client stores** `ReconnectState` before disconnect.

2. **On reconnect to `/ws`**:
   - Server validates auth and sends `{ type: "hello", serverVersion }`.
   - Client sends `{ type: "sync.catchup", cursors: { [sessionID]: lastSeq, ... } }`.

3. **Server catchup**:
   - For each session in `cursors`, calls `EventV2.aggregateEvents({ aggregateID: sessionID, after: cursor })`.
     This replays only durable events (step starts/ends, tool completions, message creations)
     with `seq > cursor`.
   - Sends each replayed event as `{ type: "push.event", ... }`.
   - For non-durable state (ephemeral text deltas, current prompt status, todo status,
     session metadata), sends the same paginated `push.snapshot` frames used at initial
     connect (10 sessions per page, projects/config/mcp/providers on page 1 only).
   - Sends `{ type: "caught-up" }`.

4. **Client reconciliation**:
   - Applies replayed durable events against local state (deduplicating by event `id`).
   - Replaces ephemeral state with the snapshot (snapshot is authoritative for non-durable data).
   - Resolves any pending request promises whose mutations are now reflected in state.

5. **Active prompts**: The server-side agent loop continues during disconnect. On reconnect,
   the client receives the current message stream via the snapshot (current messages + status).
   No prompt re-submission needed.

#### Replay limits

- Maximum replay events per session: **500** (configurable). If a session has more missed
  events, the server sends only the snapshot (full current `SessionMessage[]`) and the
  client replaces its local message state entirely.
- Maximum total replay duration: **30 seconds** (server-side timeout). If replay would exceed
  this, the server truncates to snapshot-only.
- Chunked replay: Events are sent in batches of 50, yielding between batches to avoid
  blocking the WS writer.

### Backpressure and resource limits

#### Per-connection limits

| Resource | Limit | Exceeded behavior |
|----------|-------|-------------------|
| Pending requests (in-flight) | 16 | New requests rejected with error response |
| Inbound frame size | 4 MiB | Connection closed with code 1009 |
| Outbound queue capacity | 256 frames | New push events dropped for this connection; `push.server.overflow` sent; connection closed if persistent |
| Heartbeat interval | 15s ping, 45s timeout | Connection closed with code 1001 |

#### Server-wide limits

| Resource | Default | Configurable |
|----------|---------|-------------|
| Max concurrent WS connections | 100 | `WS_MAX_CONNECTIONS` |
| Max reconnect replay events per session | 500 | `WS_MAX_REPLAY_EVENTS` |
| Replay timeout | 30s | `WS_REPLAY_TIMEOUT_MS` |
| Idempotency ID TTL | 5 min | `WS_IDEMPOTENCY_TTL_MS` |

#### Slow-consumer protection

If the outbound queue for a connection grows beyond 75% capacity, a backpressure signal is
applied: non-critical events (PTY output, file content pushes) are dropped first. If the
queue reaches capacity, the connection is closed with code 1013 (try again later), and the
client must reconnect.

The writer loop uses bounded Effect `Queue` with `Queue.offer` (not `offerUnsafe`), so
the publisher can detect backpressure instead of silently growing unbounded memory.

### State machine

```
DISCONNECTED
    │
    ▼ (user action / auto)
CONNECTING
    │
    ├── timeout / error ──→ DISCONNECTED (exponential backoff: 250ms → 1s → 4s → 16s, max 60s)
    │
    ▼ (WebSocket open + hello received)
HANDSHAKE
    │
    ▼ (catchup complete or skipped)
CONNECTED
    │
    ├── ping timeout (45s no pong) ──→ RECONNECTING
    ├── socket close (server-initiated) ──→ RECONNECTING
    ├── outbound queue overflow ──→ RECONNECTING
    │
    ▼
RECONNECTING
    │
    ├── max retries (10) / user stop ──→ DISCONNECTED
    │
    ▼ (backoff → CONNECTING)
```

## API coverage matrix

Below is the full coverage of existing HTTP API endpoints mapped to WS transport
status. "WS" = implemented in WS protocol. "REST*" = permanently REST/SSE-only.

### packages/opencode instance API

| HTTP route | WS message type | Status |
|------------|----------------|--------|
| `GET /session` | `session.list` | WS |
| `GET /session/status` | `session.status` | WS |
| `GET /session/:id` | `session.get` | WS |
| `GET /session/:id/children` | `session.children` | WS |
| `GET /session/:id/todo` | `session.todo` | WS |
| `GET /session/:id/diff` | `session.diff` | WS |
| `GET /session/:id/message` | `session.messages` | WS |
| `GET /session/:id/message/:msgID` | `message.get` | WS |
| `POST /session` | `session.create` | WS |
| `DELETE /session/:id` | `session.delete` | WS |
| `PATCH /session/:id` | `session.update` | WS |
| `POST /session/:id/fork` | `session.fork` | WS |
| `POST /session/:id/abort` | `session.abort` | WS |
| `POST /session/:id/init` | `session.init` | WS |
| `POST /session/:id/share` | `session.share` | WS |
| `POST /session/:id/unshare` | `session.unshare` | WS |
| `POST /session/:id/summarize` | `session.summarize` | WS |
| `POST /session/:id/message` | `session.prompt` | WS |
| `POST /session/:id/prompt_async` | `session.prompt` (admit-only) | WS |
| `POST /session/:id/command` | `session.command` | WS |
| `POST /session/:id/shell` | `session.shell` | WS |
| `POST /session/:id/revert` | `session.revert` | WS |
| `POST /session/:id/unrevert` | `session.unrevert` | WS |
| `POST /session/:id/permissions/:pid` | `permission.reply` | WS |
| `DELETE /session/:id/message/:msgID` | `message.delete` | WS |
| `DELETE /session/:id/message/:msgID/part/:partID` | `message.part.delete` | WS |
| `PATCH /session/:id/message/:msgID/part/:partID` | `message.part.update` | WS |
| `GET /mcp` | `mcp.status` | WS |
| `POST /mcp` | `mcp.connect` | WS |
| `POST /mcp/:name/auth` | `mcp.auth` | WS |
| `POST /mcp/:name/auth/callback` | `mcp.auth.callback` | WS |
| `POST /mcp/:name/auth/authenticate` | `mcp.auth.authenticate` | WS |
| `DELETE /mcp/:name/auth` | `mcp.auth.remove` | WS |
| `POST /mcp/:name/connect` | `mcp.connect` | WS |
| `POST /mcp/:name/disconnect` | `mcp.disconnect` | WS |
| `GET /config` | `config.get` | WS |
| `PATCH /config` | `config.update` | WS |
| `GET /config/providers` | `config.providers` | WS |
| `GET /provider` | `provider.list` | WS |
| `GET /provider/auth` | `provider.auth` | WS |
| `POST /provider/:id/oauth/authorize` | `provider.authorize` | WS |
| `POST /provider/:id/oauth/callback` | `provider.callback` | WS |
| `PUT /auth/:id` | `auth.put` | WS |
| `DELETE /auth/:id` | `auth.delete` | WS |
| `GET /find` | `file.find` | WS |
| `GET /find/file` | `file.find.file` | WS |
| `GET /find/symbol` | `file.find.symbol` | WS |
| `GET /file` | `file.read` | WS |
| `GET /file/content` | `file.read` | WS |
| `GET /file/status` | `file.status` | WS |
| `POST /instance/dispose` | `instance.dispose` | WS |
| `GET /path` | `path.get` | WS |
| `GET /vcs` | `vcs.status` | WS |
| `GET /vcs/status` | `vcs.status` | WS |
| `GET /vcs/diff` | `vcs.diff` | WS |
| `GET /vcs/diff/raw` | `vcs.diff (raw: true)` | WS |
| `POST /vcs/apply` | `vcs.apply` | WS |
| `GET /command` | `command.list` | WS |
| `GET /agent` | `agent.list` | WS |
| `GET /skill` | `skill.list` | WS |
| `GET /lsp` | `lsp.status` | WS |
| `GET /formatter` | `formatter.status` | WS |
| `GET /project` | `project.list` | WS |
| `GET /project/current` | `project.current` | WS |
| `POST /project/git/init` | `project.init` | WS |
| `POST /project/reload` | `project.reload` | WS |
| `PATCH /project/:id` | `project.update` | WS |
| `GET /project/:id/directories` | `project.directories` | WS |
| `GET /permission` | `permission.list` | WS |
| `POST /permission/:id/reply` | `permission.reply` | WS |
| `GET /question` | `question.list` | WS |
| `POST /question/:id/reply` | `question.reply` | WS |
| `POST /question/:id/reject` | `question.reject` | WS |
| `GET /event` | `push.event` (via WS) | WS |
| `GET /pty/shells` | `pty.shells` | WS |
| `GET /pty` | `pty.list` | WS |
| `POST /pty` | `pty.create` | WS |
| `GET /pty/:id` | `pty.get` | WS |
| `PUT /pty/:id` | `pty.update` | WS |
| `DELETE /pty/:id` | `pty.close` | WS |
| `POST /pty/:id/connect-token` | `pty.connect-token` | WS |
| `GET /pty/:id/connect` | `push.pty.output` (via WS main connection) | WS |
| `POST /tui/append-prompt` | `tui.append` | WS |
| `POST /tui/open-help` | `tui.open-help` | WS |
| `POST /tui/open-sessions` | `tui.open-sessions` | WS |
| `POST /tui/open-themes` | `tui.open-themes` | WS |
| `POST /tui/open-models` | `tui.open-models` | WS |
| `POST /tui/submit-prompt` | `tui.submit` | WS |
| `POST /tui/clear-prompt` | `tui.clear` | WS |
| `POST /tui/execute-command` | `tui.execute` | WS |
| `POST /tui/show-toast` | `tui.show-toast` | WS |
| `POST /tui/publish` | `tui.publish` | WS |
| `POST /tui/select-session` | `tui.select` | WS |
| `GET /tui/control/next` | `tui.control.next` | WS |
| `POST /tui/control/response` | `tui.control.response` | WS |
| `GET /experimental/console` | `experimental.console` | WS |
| `GET /experimental/console/orgs` | `experimental.console.orgs` | WS |
| `POST /experimental/console/switch` | `experimental.console.switch` | WS |
| `GET /experimental/tool` | `experimental.tool` | WS |
| `GET /experimental/tool/ids` | `experimental.tool.ids` | WS |
| `GET /experimental/worktree` | `experimental.worktree` | WS |
| `POST /experimental/worktree` | `experimental.worktree.create` | WS |
| `DELETE /experimental/worktree` | `experimental.worktree.delete` | WS |
| `POST /experimental/worktree/reset` | `experimental.worktree.reset` | WS |
| `GET /experimental/resource` | `experimental.resource` | WS |

### packages/opencode global API & packages/server v2 API

| HTTP route | WS message type | Status |
|------------|----------------|--------|
| `GET /global/event` | `push.event` (via WS) | WS |
| `GET /api/event` | `push.event` (via WS) | WS |
| `GET /global/health` | `global.health` | WS |
| `GET /global/config` | `global.config` | WS |
| `PATCH /global/config` | `global.config.update` | WS |
| `POST /global/dispose` | `global.dispose` | WS |
| `POST /global/upgrade` | `global.upgrade` | WS |

### Permanently REST/SSE-only

| HTTP route | Reason |
|------------|--------|
| `GET /global/event` (remote sync) | Control-plane workspace sync uses SSE for cross-instance streaming |
| `POST /sync/start` | Cross-instance session sync |
| `POST /sync/replay` | Cross-instance event replay |
| `POST /sync/steal` | Cross-instance ownership transfer |
| `POST /sync/history` | Cross-instance catchup cursor list |
| `POST /experimental/control-plane/move-session` | Control-plane operation |
| `GET /experimental/workspace/*` | Remote workspace management |
| `POST /experimental/workspace/*` | Remote workspace management |
| `GET /ui/*` | UI project-view and settings (non-API) |
| `GET /doc` | OpenAPI docs |
| `GET /*` | UI fallback / static assets |

### v2 API endpoints (packages/server)

| HTTP route | WS message type | Status |
|------------|----------------|--------|
| `GET /api/health` | `global.health` | WS |
| `GET /api/agent` | `agent.list` | WS |
| `GET /api/session` | `session.list` | WS |
| `POST /api/session/:id/prompt` | `session.prompt` | WS |
| `POST /api/session/:id/compact` | `session.summarize` | WS |
| `POST /api/session/:id/wait` | no direct WS equivalent — push events signal idle | WS |
| `GET /api/session/:id/context` | `session.context` | WS |
| `GET /api/session/:id/message` | `session.messages` | WS |
| `GET /api/model` | `config.providers` | WS |
| `GET /api/provider` | `provider.list` | WS |
| `GET /api/provider/:id` | `provider.list` (filtered) | WS |
| `GET /api/permission/request` | `permission.list` | WS |
| `GET /api/session/:id/permission/request` | `permission.list` (session-scoped) | WS |
| `POST /api/session/:id/permission/request/:rid/reply` | `permission.reply` | WS |
| `GET /api/permission/saved` | `permission.list` (saved) | WS |
| `DELETE /api/permission/saved/:id` | WS (via dedicated message type if needed) | deferred |
| `GET /api/fs/read` | `file.read` | WS |
| `GET /api/fs/list` | `file.find` | WS |
| `GET /api/command` | `command.list` | WS |
| `GET /api/skill` | `skill.list` | WS |
| `GET /api/event` | `push.event` (via WS) | WS |
| `GET /api/question/request` | `question.list` | WS |
| `POST /api/session/:id/question/request/:rid/reply` | `question.reply` | WS |
| `POST /api/session/:id/question/request/:rid/reject` | `question.reject` | WS |

## Server implementation

New module: `packages/opencode/src/server/ws/`

```
server/ws/
  index.ts              -- public API: WsTransport.layer, WsTransport.Service
  transport.ts          -- HTTP upgrade handler at /ws, auth, origin check
  protocol.ts           -- MessagePack encode/decode, frame validation
  multiplex.ts          -- Dispatch table: message type → handler, response routing
  connection.ts         -- Per-connection state: writer, heartbeat, bounded queue, reconnect state
  session-handler.ts    -- Session CRUD, prompt admission, messages
  event-bridge.ts       -- EventV2 listener → WS push.event frames (reuses GlobalBus shape)
  mcp-handler.ts        -- MCP status, connect, disconnect, auth
  pty-handler.ts        -- PTY I/O over WS
  config-handler.ts     -- Config, providers
  file-handler.ts       -- File read, find, status
  vcs-handler.ts        -- VCS status, diff, apply
  project-handler.ts    -- Projects, directories
  permission-handler.ts -- Permissions, questions
  auth-handler.ts       -- Auth put/delete
  reconnect.ts          -- sync.catchup: per-aggregate cursor replay, snapshot generation
```

### Scope and auth

`/ws` is instance-scoped (same as the current HTTP API). Auth uses the existing
`auth_token` query parameter sent during the WebSocket upgrade handshake:

```
GET /ws?auth_token=<token>
Upgrade: websocket
Origin: <origin>
```

The upgrade handler validates:
1. `Origin` header against the server's CORS allowlist (reuses `CorsConfig`).
2. `auth_token` against the existing auth middleware.
3. Extract `directory` / `workspace` scope from the token.

Browser WebSocket clients cannot set custom headers, so the query parameter is the
only viable auth channel at upgrade time. For local TUI connections, the SDK client
passes the token from the existing SDK configuration.

### Event bridge: reusing GlobalBus shape

The WS event bridge subscribes to `EventV2.listen()` (same as the current bridge)
and produces `push.event` frames in the exact same envelope as the SSE path:

```ts
// server/ws/event-bridge.ts (conceptual)
const listener = events.listen((event) =>
  Effect.gen(function* () {
    const payload = EventV2.encodeKnownPayloadForFanout(event)
    if (!payload) return
    const conn = yield* WsConnection.current()
    yield* conn.push({
      type: "push.event",
      directory: event.location?.directory ?? conn.directory,
      project: conn.projectID,
      workspace: conn.workspaceID,
      payload: { id: payload.id, type: payload.type, properties: payload.data },
    })
  }),
)
```

This means the existing Web UI reducer (`event-reducer.ts` in `packages/app`) and
TUI sync (`sync.tsx`, `sync-v2.tsx`) need no changes — they process the same event
shapes regardless of transport.

### PTY integration

PTY I/O is multiplexed onto the main WS connection instead of using a separate
WebSocket. PTY output frames and input frames are routed by `ptyID`:

```msgpack
// Server → Client
{ type: "push.pty.output", ptyID, data: Uint8Array }
{ type: "push.pty.closed", ptyID }

// Client → Server (fire-and-forget)
{ type: "pty.input", ptyID, data: Uint8Array }
```

The existing PTY WebSocket endpoint (`/pty/:id/connect`) is kept during migration; it is removed in Phase 5 once the WS multiplexed PTY is stable.

## SDK implementation (packages/sdk/js)

New module: `packages/sdk/js/src/v2/ws/`

```
sdk/js/src/v2/ws/
  index.ts          -- public API: createOpencodeWsClient(config)
  transport.ts      -- WebSocket connection, state machine, heartbeat
  protocol.ts       -- MessagePack encode/decode, request/response multiplex
  reconnect.ts      -- Reconnect with backoff, cursor tracking, catchup
  types.ts          -- TypeScript types for all message shapes
```

Client API:

```ts
import { createOpencodeWsClient } from "@opencode-ai/sdk/v2/ws"

const client = createOpencodeWsClient({
  url: "ws://localhost:4096",
  authToken: "...",
  directory: "/home/user/project",
})

// Request/reply
const sessions = await client.request("session.list", { limit: 50 })
const msgs = await client.request("session.messages", { sessionID: "ses_abc", limit: 100 })

// Fire-and-forget
client.send({ type: "pty.input", ptyID: "pty_xyz", data: new Uint8Array(...) })

// Event subscription
const unsub = client.onEvent((event) => {
  if (event.payload.type === "session.next.text.delta") { ... }
})

// Disconnect
client.close()
```

The existing `createOpencodeClient` (HTTP+SSE) is **unchanged**. The WS client is a
separate factory. This avoids breaking any consumers and allows side-by-side comparison.

## Web UI adoption (packages/app)

The SSE listener and session-load pattern in `server-sdk.tsx` and `server-sync.tsx` is
replaced with a WS-backed context. The WS transport is **always-on** — no feature flag.

On connect, the client receives `push.snapshot` with metadata for **every session** in the
project. The session list renders immediately with activity indicators, previews, and colors.
No per-session REST calls are needed.

The existing `event-reducer.ts` and `directory-sync.ts` logic remains unchanged since the
`push.event` envelope shape is identical to the current SSE payload shape.

```tsx
// packages/app/src/context/server-ws.tsx (new, replaces server-sdk.tsx + server-sync.tsx)
const ws = createOpencodeWsClient({
  url: server.http.url.replace(/^http/, "ws"),
  authToken: server.token,
})

// Session store: populated by push.snapshot, updated by push.event
const [sessions, setSessions] = createStore<SessionMeta[]>([])

ws.onMessage((msg) => {
  if (msg.type === "push.snapshot") {
    setSessions(msg.sessions)   // full list on connect
    setConfig(msg.config)
    setMcp(msg.mcp)
    setProjects(msg.projects)
    setProviders(msg.providers)
  }
  if (msg.type === "push.event") {
    // Route through existing event reducer — zero changes needed
    emitter.emit(msg.directory, msg.payload)
  }
})

// When user clicks a session, messages may already be pre-fetched.
// If not, load on demand:
async function openSession(sessionID: string) {
  if (!messageStore.has(sessionID)) {
    const msgs = await ws.request("session.messages", { sessionID, limit: 100 })
    messageStore.set(sessionID, msgs.data)
  }
  setActiveSession(sessionID)
}
```

**Key differences from current model:**

| Aspect | Current (REST+SSE) | Target (WS push-all) |
|--------|-------------------|---------------------|
| Session list load | `GET /session` on every directory change | `push.snapshot` on connect, live updates after |
| Session click | 3–5 REST calls (messages, todo, diff, children) | Messages already present or 1 WS request |
| Activity indicators | Polling via status checks | Real-time via `push.event` (session.status) |
| Project metadata | REST call per project | `push.snapshot` at connect, `push.event` on change |
| Config/providers | REST calls | `push.snapshot` at connect, `push.event` on change |
| Reconnect | Re-establish SSE + re-fetch everything | WS reconnect + cursor catchup + snapshot |

## Implementation phases

### Phase 1: WebSocket endpoint + event bridge + snapshot + session read handlers

1. Add `packages/opencode/src/server/ws/` module:
   - `transport.ts`: Upgrade handler at `GET /ws?auth_token=...`. Enable `permessage-deflate`.
   - `protocol.ts`: MessagePack encode/decode, frame size validation.
   - `connection.ts`: Per-connection writer, bounded queue, heartbeat.
   - `event-bridge.ts`: EventV2 listener → `push.event` frames.
   - `snapshot.ts`: Generate `push.snapshot` with all session metadata, config, MCP, projects, providers.
   - `multiplex.ts`: Dispatch table, response routing.
   - `session-handler.ts`: Session list, get, messages, status, todo, diff, children.
   - `mcp-handler.ts`: MCP status.
   - `config-handler.ts`: Config.get, config.providers.
   - `project-handler.ts`: Project.list, provider.list.
   - `auth-handler.ts` / `cors.ts`: Upgrade-time auth validation.
2. Register `/ws` route in `server.ts` alongside existing routes.
3. **No REST endpoints removed or changed.**
4. **Validation**: Unit tests for protocol encode/decode, integration test for WS event
   delivery (push.event matches SSE event content), snapshot includes all sessions.

### Phase 2: Mutating handlers + idempotency

1. Add handlers for: session.create, delete, update, fork, share, unshare, revert,
   unrevert, prompt, command, shell, abort, summarize, init.
2. Implement idempotency store (per-connection `Map`, 5-min TTL).
3. **Validation**: Integration tests for each mutation → verify response, verify idempotency
   (double-send gives same response), verify push events follow.

### Phase 3: SDK client

1. Add `packages/sdk/js/src/v2/ws/` with transport, protocol, reconnect, types.
2. Export `createOpencodeWsClient` from `@opencode-ai/sdk/v2/ws`.
3. Implement reconnection with cursor tracking, catchup, and backoff.
4. Keep existing `createOpencodeClient` unchanged.
5. **Validation**: Integration tests with real opencode server, compare WS responses
   to REST responses for parity.

### Phase 4: Remaining handlers

1. File read, find, status.
2. VCS status, diff, apply.
3. Command, agent, skill, LSP, formatter list.
4. Provider list, authorize, callback.
5. Permission/questions list, reply, reject.
6. PTY create, list, I/O (multiplexed).
7. TUI control endpoints.
8. Experimental endpoints.
9. Global/instance endpoints (health, dispose, upgrade).
10. **Validation**: Full request/response parity check against REST endpoints.

### Phase 5: Web UI migration

1. Add `packages/app/src/context/server-ws.tsx` with WS-backed state management.
2. On connect, populate session store from `push.snapshot` — all sessions immediately visible
   with activity indicators, previews, colors.
3. Route `push.event` frames through existing event reducer (no reducer changes needed).
4. Replace REST queries with WS request/reply for remaining operations (message load on open,
   TODO, diff, children).
5. Session metadata updates arrive via `push.event` in real-time — no polling.
6. Remove SSE listener once WS is active.
7. Remove TanStack Query for operations now served by WS.
8. **Validation**: Web UI smoke tests — session list rendered immediately, prompt streaming,
   reconnect with cursor catchup, activity indicators update live.

### Phase 6: PTY unification + TUI migration

1. Route all PTY I/O through main WS connection.
2. Deprecate standalone PTY WS endpoint.
3. Update TUI SDK context (`cli/cmd/tui/context/sdk.tsx`) to use WS client.
4. **Validation**: TUI smoke tests.

### Phase 7: Deprecation

1. Once all clients (Web UI, TUI, SDK consumers) are on WS with proven parity:
   - Add deprecation headers to REST responses.
   - Remove REST endpoints in a future major version.
   - Keep `GET /health`, `GET /doc`, and permanently REST/SSE-only endpoints
     (workspace sync, `/global/event` for remote instances).

## Data model / state ownership

No changes. `EventV2` persists events identically. `SessionMessage` shape is unchanged.
The WS transport is purely a client-facing presentation layer reading from existing
services.

## Validation strategy

1. **Unit tests** (`packages/opencode/test/ws/`):
   - MessagePack round-trip for all WS message types.
   - Frame size limit enforcement.
   - Request/response multiplexing with concurrent requests.
   - Idempotency key deduplication.
   - Reconnect cursor tracking and catchup replay.
   - Heartbeat timeout detection.
   - Bounded queue backpressure.

2. **Integration tests** (`packages/opencode/test/ws/integration/`):
   - Full session lifecycle over WS: create → prompt → receive events → read messages.
   - Disconnect during active prompt, reconnect, verify catchup (durable events replayed,
     snapshot applied).
   - Multiple concurrent connections, each with their own sessions.
   - PTY I/O over multiplexed WS.
   - Binary payload size vs JSON equivalent (benchmark fixture).
   - Response parity: every WS response matches its REST counterpart for the same operation
     (runnable as a comparison test harness).

3. **Smoke tests** (TUI + Web UI):
   - Load session list over WS (renders immediately from push.snapshot).
   - Send prompt and observe streaming events.
   - Disconnect and reconnect mid-stream.
   - Verify no duplicate messages after reconnect.

4. **Benchmarks**:
   - MessagePack vs JSON payload size across 10,000 real event payloads (captured from
     production SSE streams).
   - WS round-trip latency (single request/reply) vs REST for session list, messages.
   - Session load time: WS (boot → snapshot → events) vs REST+SSE (N HTTP + SSE subscription).
   - Memory overhead per WS connection vs SSE + REST polling.

## Risks and tradeoffs

| Risk | Severity | Mitigation |
|------|----------|------------|
| WebSocket blocked by corporate proxy/firewall | Medium | Keep HTTP/SSE as degraded fallback; auto-detect WS availability with timeout and fall back |
| MessagePack decode errors on malformed frames | Low | Validate frame size before decode; close connection on protocol error with code 1003 |
| Connection drops during active prompt lose ephemeral deltas | Low | Server continues agent loop; reconnect replays durable events + snapshot of current messages |
| Memory pressure from buffered events for slow consumers | Medium | Bounded queue (256 frames); slow-consumer detection; close with code 1013 when full |
| Large event replay burst after long disconnect | Medium | Max 500 replay events per session; chunked replay with yields; fallback to full snapshot |
| Auto-retry of mutating requests duplicates side effects | Low | All mutating requests carry idempotencyID; client queries state on reconnect instead of retrying |
| PTY WS migration breaks existing terminal integrations | Medium | Phase PTY migration separately; keep standalone PTY WS endpoint during transition |
| Browser WebSocket auth limitations | Low | Query-param `auth_token` at upgrade time + `Origin` validation; same approach as PTY tickets |
| Increased server complexity (stateful WS vs stateless REST) | Medium | Per-connection state is scoped to fiber via Effect `Scope`; cleanup on close/interrupt |
| MessagePack library size in browser bundle | Low | `@msgpack/msgpack` is ~8 KiB gzipped; aliased through SDK |

## Open questions

1. **Snapshot pagination for extreme session counts**: A project with 10,000 sessions
   would produce 1,000 snapshot frames. Should the client request a specific page range,
   or should the server stream all pages with the client cancelling once the visible
   portion is rendered? Recommendation: stream all pages; client renders page 1
   immediately and continues receiving pages in the background. The `session.list`
   WS request remains available for explicit search/filter beyond the snapshot.

2. **Brotli quality tuning**: Default quality 4 balances compression ratio and CPU.
   Should the server dynamically adjust quality based on connection count or frame
   type? Recommendation: static quality 4 initially; measure CPU impact under load
   before tuning.
