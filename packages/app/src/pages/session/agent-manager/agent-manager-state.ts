import { createMemo, type Accessor } from "solid-js"
import { useSync } from "@/context/sync"
import { deriveSubagentRows, resolveRootID, type SubagentRow } from "./subagent-rows"

type Sync = ReturnType<typeof useSync>

export function createAgentManagerState(sync: Sync, rootID: Accessor<string | undefined>) {
  const rows = createMemo<SubagentRow[]>(() => {
    const root = rootID()
    if (!root) return []
    return deriveSubagentRows({
      rootID: root,
      messages: sync.data.message,
      parts: sync.data.part,
      sessions: sync.data.session,
      status: sync.data.session_status,
    })
  })

  const runningCount = createMemo(() => rows().filter((row) => row.status === "running").length)

  return { rows, runningCount }
}

export function createRootID(sync: Sync, sessionID: Accessor<string | undefined>) {
  return createMemo(() => resolveRootID((id) => sync.session.get(id), sessionID()))
}
