import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createAgentManagerState, createRootID } from "./agent-manager-state"

// Single shared derivation for the active root session's subagents so the
// toolbar badge (runningCount) and the panel (rows) read from the SAME memo
// instead of each instantiating the full Session[] derivation independently.
export const { use: useAgentManager, provider: AgentManagerProvider } = createSimpleContext({
  name: "AgentManager",
  gate: false,
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const layout = useSessionLayout()
    const rootID = createRootID(sync, () => layout.params.id)
    return createAgentManagerState(sync, sdk, rootID)
  },
})
