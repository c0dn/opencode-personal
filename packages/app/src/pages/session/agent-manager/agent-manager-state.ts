import { createMemo, createResource, type Accessor } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { deriveSubagentRows, localDescendantSignature, resolveRootID, type SubagentRow } from "./subagent-rows"

type Sync = ReturnType<typeof useSync>
type SDK = ReturnType<typeof useSDK>

type ServerDescendant = { session: Session; depth: number }

export function createAgentManagerState(sync: Sync, sdk: SDK, rootID: Accessor<string | undefined>) {
  // Refetch the descendant tree only when the root changes or local subtree
  // membership changes (new/removed session) — NOT on every status/message tick.
  const resourceKey = createMemo(() => agentManagerResourceKey(rootID(), sync.data.session))

  const [descendants] = createResource(resourceKey, (key) => fetchDescendants(sdk, key.split("::")[0]))

  const rows = createMemo<SubagentRow[]>(() => deriveAgentManagerRows(rootID(), sync.data, descendants() ?? []))

  const runningCount = createMemo(() => rows().filter((row) => row.status === "running").length)

  return { rows, runningCount }
}

// Resource key that only changes when the root or local subtree membership
// changes. Status/title/message ticks must not change it, so the descendant
// tree is not refetched on every reactive update.
export function agentManagerResourceKey(rootID: string | undefined, sessions: Session[]): string | undefined {
  if (!rootID) return undefined
  return `${rootID}::${localDescendantSignature(sessions, rootID)}`
}

// Fetches the authoritative descendant tree; an error (offline/404) degrades to
// an empty server list so membership falls back to the local parentID walk.
export async function fetchDescendants(sdk: SDK, root: string): Promise<ServerDescendant[]> {
  const result = await sdk.client.session.descendants({ sessionID: root }).catch(() => undefined)
  return result?.data ?? []
}

// Reactive rows derivation: merges the authoritative server descendants with the
// live store sessions (store wins) and derives status/title/busy from sync.data.
export function deriveAgentManagerRows(
  rootID: string | undefined,
  data: Sync["data"],
  server: ServerDescendant[],
): SubagentRow[] {
  if (!rootID) return []
  return deriveSubagentRows({
    rootID,
    messages: data.message,
    parts: data.part,
    // Server descendant sessions fill in not-yet-loaded deep sessions; live
    // store sessions are appended last so they win in the id map.
    sessions: mergeSessions(server, data.session),
    status: data.session_status,
    serverDescendants: server.map((entry) => ({ sessionID: entry.session.id, depth: entry.depth })),
  })
}

export function createRootID(sync: Sync, sessionID: Accessor<string | undefined>) {
  return createMemo(() => resolveRootID((id) => sync.session.get(id), sessionID()))
}

function mergeSessions(server: Array<{ session: Session; depth: number }>, store: Session[]): Session[] {
  if (server.length === 0) return store
  return [...server.map((entry) => entry.session), ...store]
}
