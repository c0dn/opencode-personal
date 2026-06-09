import type { Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"

export type SubagentStatus = "running" | "idle" | "completed" | "error"

export type SubagentRow = {
  sessionID: string
  parentID: string
  agent?: string
  title: string
  status: SubagentStatus
  spawnMessageID?: string
  busy: boolean
}

export type SubagentSource = {
  rootID: string
  messages: Record<string, Message[] | undefined>
  parts: Record<string, Part[] | undefined>
  sessions: Session[]
  status: Record<string, SessionStatus | undefined>
}

type ChildEntry = {
  spawnMessageID?: string
  description?: string
}

// Subagents are task-tool child sessions. The live status map only retains
// busy/retry entries (status.ts deletes idle sessions), so "absent from the
// status map" must be treated as idle/completed and the terminal state derived
// from the child's last assistant message, mirroring event-reducer self-heal.
export function deriveSubagentRows(source: SubagentSource): SubagentRow[] {
  const byId = new Map(source.sessions.map((session) => [session.id, session]))
  const children = collectChildren(source, byId)

  const rows: SubagentRow[] = []
  for (const [childID, entry] of children) {
    const session = byId.get(childID)
    const state = deriveStatus(childID, source)
    rows.push({
      sessionID: childID,
      parentID: session?.parentID ?? source.rootID,
      agent: session?.agent,
      title: session?.title?.trim() || entry.description || childID,
      status: state.status,
      spawnMessageID: entry.spawnMessageID,
      busy: state.busy,
    })
  }

  return rows.sort((a, b) => sortKey(a, byId).localeCompare(sortKey(b, byId)))
}

// v1 is intentionally flat: it collects only the DIRECT children of the root
// session (task parts in the root's messages + sessions whose parentID is the
// root). Grandchildren in deeper orchestration trees are not enumerated;
// recursive descendant loading is a documented follow-up (would need either
// client-side recursion over children or a server descendants endpoint).
function collectChildren(source: SubagentSource, byId: Map<string, Session>): Map<string, ChildEntry> {
  const children = new Map<string, ChildEntry>()

  for (const message of source.messages[source.rootID] ?? []) {
    for (const part of source.parts[message.id] ?? []) {
      const task = taskChild(part)
      if (!task) continue
      if (children.has(task.childID)) continue
      children.set(task.childID, { spawnMessageID: message.id, description: task.description })
    }
  }

  // Catch children that exist as sessions but whose spawning task part is not
  // visible yet (e.g. created event arrived before the message stream).
  for (const session of byId.values()) {
    if (session.parentID !== source.rootID) continue
    if (children.has(session.id)) continue
    children.set(session.id, {})
  }

  return children
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
