import { Effect } from "effect"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Project } from "@/project/project"
import type { Connection } from "./connection"

const SNAPSHOT_PAGE_SIZE = 10

/**
 * Generate and push a paginated snapshot of all sessions + config + MCP + projects + providers.
 * Page 1 contains non-session data; subsequent pages contain only sessions.
 */
export function pushSnapshot(conn: Connection, directory?: string) {
  return Effect.gen(function* () {
    const sessionsSvc = yield* Session.Service
    const configSvc = yield* Config.Service
    const mcpSvc = yield* MCP.Service
    const providerSvc = yield* Provider.Service
    const projectSvc = yield* Project.Service

    // Gather all data
    const sessions = yield* sessionsSvc.list(directory ? { directory } : undefined)
    const config = yield* configSvc.get()
    const mcpStatus = yield* mcpSvc.status()
    const providers = yield* providerSvc.list()
    const projects = yield* projectSvc.list()

    const totalPages = Math.max(1, Math.ceil(sessions.length / SNAPSHOT_PAGE_SIZE))

    for (let page = 0; page < totalPages; page++) {
      const pageSessions = sessions.slice(page * SNAPSHOT_PAGE_SIZE, (page + 1) * SNAPSHOT_PAGE_SIZE)
      const sessionMeta = pageSessions.map((s) => ({
        id: s.id,
        parentID: s.parentID,
        title: s.title,
        path: s.directory,
        projectID: s.projectID,
        status: "idle" as const,
        time: s.time,
        preview: "",
        messageCount: 0,
        model: s.model?.id,
        agent: s.agent,
        color: undefined as string | undefined,
      }))

      const frame: Record<string, unknown> = {
        type: "push.snapshot",
        page: page + 1,
        totalPages,
        sessions: sessionMeta,
      }

      // Non-session data on page 1 only
      if (page === 0) {
        frame.config = config
        frame.mcp = mcpStatus
        frame.providers = providers
        frame.projects = projects
      }

      yield* conn.push(frame).pipe(Effect.catch(() => Effect.void))
    }
  })
}
