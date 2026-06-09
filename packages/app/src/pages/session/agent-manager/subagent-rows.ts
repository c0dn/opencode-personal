import type { Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"

export type SubagentStatus = "running" | "idle" | "completed" | "error"

export type SubagentRow = {
  sessionID: string
  parentID: string
  agent?: string
  title: string
  status: SubagentStatus
  spawnMessageID?: string
  depth: number
  busy: boolean
}

// Authoritative membership entry from the server descendants endpoint
// (GET /session/:id/descendants), depth relative to the root (direct child = 1).
export type DescendantEntry = { sessionID: string; depth: number }

export type SubagentSource = {
  rootID: string
  messages: Record<string, Message[] | undefined>
  parts: Record<string, Part[] | undefined>
  // Sessions used for parentID/title/agent. The caller merges the authoritative
  // server descendant sessions with the live sync store (store wins) so titles
  // and agents stay live while still covering not-yet-loaded deep sessions.
  sessions: Session[]
  status: Record<string, SessionStatus | undefined>
  // Authoritative descendant membership + depth from the server. Empty until the
  // resource resolves; local membership (parentID walk) covers the gap meanwhile.
  serverDescendants: DescendantEntry[]
}

type ChildEntry = {
  spawnMessageID?: string
  description?: string
}

// Enumerates the full descendant subtree (grandchildren and deeper) of the root
// session. Membership is the union of the authoritative server descendants and
// the locally-known descendants discovered by walking parentID over the sessions
// list, deduped by id. Depth prefers the server value; locally-only sessions use
// their parentID chain length. Status/title/busy stay live from the reactive
// store via deriveStatus.
export function deriveSubagentRows(source: SubagentSource): SubagentRow[] {
  const byId = new Map(source.sessions.map((session) => [session.id, session]))
  const spawn = collectSpawnAnchors(source)
  const depthByID = collectMembership(source, byId)

  const rows: SubagentRow[] = []
  for (const [childID, depth] of depthByID) {
    const session = byId.get(childID)
    const entry = spawn.get(childID)
    const state = deriveStatus(childID, source)
    rows.push({
      sessionID: childID,
      parentID: session?.parentID ?? source.rootID,
      agent: session?.agent,
      title: session?.title?.trim() || entry?.description || childID,
      status: state.status,
      spawnMessageID: entry?.spawnMessageID,
      depth,
      busy: state.busy,
    })
  }

  return rows.sort((a, b) => a.depth - b.depth || sortKey(a, byId).localeCompare(sortKey(b, byId)))
}

// Sorted list of locally-known descendant ids; used as the resource refetch key
// so descendants are only refetched when subtree membership changes, not on
// every status tick.
export function localDescendantSignature(sessions: Session[], rootID: string): string {
  return [...walkLocalDescendants(sessions, rootID).keys()].sort().join(",")
}

// Spawn anchors are only resolvable for DIRECT children: the task tool part that
// spawned them lives in the root session's own messages. Deeper levels leave
// spawnMessageID undefined (navigation still works by session id).
function collectSpawnAnchors(source: SubagentSource): Map<string, ChildEntry> {
  const spawn = new Map<string, ChildEntry>()
  for (const message of source.messages[source.rootID] ?? []) {
    for (const part of source.parts[message.id] ?? []) {
      const task = taskChild(part)
      if (!task) continue
      if (spawn.has(task.childID)) continue
      spawn.set(task.childID, { spawnMessageID: message.id, description: task.description })
    }
  }
  return spawn
}

function collectMembership(source: SubagentSource, byId: Map<string, Session>): Map<string, number> {
  const depthByID = walkLocalDescendants(source.sessions, source.rootID)

  // Server descendants are authoritative for both membership (adds deep sessions
  // not yet loaded locally) and depth (BFS, relative to root) — applied last so
  // the server depth wins over a locally computed chain depth.
  for (const entry of source.serverDescendants) {
    if (entry.sessionID === source.rootID) continue
    depthByID.set(entry.sessionID, entry.depth)
  }

  // Catch direct children that exist as sessions but whose record may be missing
  // from the walk inputs (defensive; normally already covered above).
  for (const session of byId.values()) {
    if (session.parentID !== source.rootID) continue
    if (depthByID.has(session.id)) continue
    depthByID.set(session.id, 1)
  }

  return depthByID
}

function walkLocalDescendants(sessions: Session[], rootID: string): Map<string, number> {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = childrenByParent.get(session.parentID)
    if (list) list.push(session.id)
    else childrenByParent.set(session.parentID, [session.id])
  }

  const depthByID = new Map<string, number>()
  const queue: Array<{ id: string; depth: number }> = (childrenByParent.get(rootID) ?? []).map((id) => ({
    id,
    depth: 1,
  }))

  while (queue.length) {
    const current = queue.shift()
    if (!current) break
    if (depthByID.has(current.id)) continue
    depthByID.set(current.id, current.depth)
    for (const child of childrenByParent.get(current.id) ?? []) {
      if (!depthByID.has(child)) queue.push({ id: child, depth: current.depth + 1 })
    }
  }

  return depthByID
}

function taskChild(part: Part): { childID: string; description?: string } | undefined {
  if (part.type !== "tool" || part.tool !== "task") return
  const state = part.state
  const metadata = "metadata" in state ? state.metadata : undefined
  const childID = metadata && typeof metadata.sessionId === "string" ? metadata.sessionId : undefined
  if (!childID) return
  const input = "input" in state ? state.input : undefined
  const description = input && typeof input.description === "string" ? input.description : undefined
  return { childID, description }
}

// Status is derived from the live store: busy/retry => running; otherwise the
// terminal state comes from the child's last assistant message (error / completed),
// else idle. Accepted limitation: a deep descendant whose messages are not loaded
// locally reads running reliably (from session_status), but completed/error may
// read as idle until that session is visited and its messages stream in.
function deriveStatus(childID: string, source: SubagentSource): { status: SubagentStatus; busy: boolean } {
  const type = source.status[childID]?.type
  if (type === "busy" || type === "retry") return { status: "running", busy: true }

  const last = lastAssistant(source.messages[childID])
  if (last?.error) return { status: "error", busy: false }
  if (typeof last?.time?.completed === "number") return { status: "completed", busy: false }
  return { status: "idle", busy: false }
}

function lastAssistant(messages: Message[] | undefined) {
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === "assistant") return message
  }
  return undefined
}

function sortKey(row: SubagentRow, byId: Map<string, Session>): string {
  const created = byId.get(row.sessionID)?.time?.created
  if (typeof created === "number") return created.toString().padStart(20, "0")
  return row.spawnMessageID ?? row.sessionID
}

export function resolveRootID(
  getSession: (id: string) => { parentID?: string } | undefined,
  id: string | undefined,
): string | undefined {
  if (!id) return undefined
  const seen = new Set<string>()
  const chain = [id]
  while (chain.length) {
    const current = chain[chain.length - 1]
    if (seen.has(current)) return current
    seen.add(current)
    const parent = getSession(current)?.parentID
    if (!parent) return current
    chain.push(parent)
  }
  return id
}
