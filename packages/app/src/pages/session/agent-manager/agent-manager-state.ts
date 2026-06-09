import { createMemo, createResource, type Accessor } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { deriveSubagentRows, localDescendantSignature, resolveRootID, type SubagentRow } from "./subagent-rows"

type Sync = ReturnType<typeof useSync>
type SDK = ReturnType<typeof useSDK>

export function createAgentManagerState(sync: Sync, sdk: SDK, rootID: Accessor<string | undefined>) {
  // Refetch the descendant tree only when the root changes or local subtree
  // membership changes (new/removed session) — NOT on every status/message tick.
  const resourceKey = createMemo(() => {
    const root = rootID()
    if (!root) return undefined
    return `${root}::${localDescendantSignature(sync.data.session, root)}`
  })

  const [descendants] = createResource(resourceKey, async (key) => {
    const root = key.split("::")[0]
    const result = await sdk.client.session.descendants({ sessionID: root }).catch(() => undefined)
    return result?.data ?? []
  })

  const rows = createMemo<SubagentRow[]>(() => {
    const root = rootID()
    if (!root) return []
    const server = descendants() ?? []
    return deriveSubagentRows({
      rootID: root,
      messages: sync.data.message,
      parts: sync.data.part,
      // Server descendant sessions fill in not-yet-loaded deep sessions; live
      // store sessions are appended last so they win in the id map.
      sessions: mergeSessions(server, sync.data.session),
      status: sync.data.session_status,
      serverDescendants: server.map((entry) => ({ sessionID: entry.session.id, depth: entry.depth })),
    })
  })

  const runningCount = createMemo(() => rows().filter((row) => row.status === "running").length)

  return { rows, runningCount }
}

export function createRootID(sync: Sync, sessionID: Accessor<string | undefined>) {
  return createMemo(() => resolveRootID((id) => sync.session.get(id), sessionID()))
}

function mergeSessions(server: Array<{ session: Session; depth: number }>, store: Session[]): Session[] {
  if (server.length === 0) return store
  return [...server.map((entry) => entry.session), ...store]
}
