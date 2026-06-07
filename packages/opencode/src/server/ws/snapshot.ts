import { Effect } from "effect"
import { Session } from "@/session/session"
import type { Connection } from "./connection"

const SNAPSHOT_PAGE_SIZE = 10

/**
 * Generate and push a paginated snapshot of all sessions.
 * Static data (config, MCP, providers, projects) is sent separately via push.static.
 */
export function pushSnapshot(conn: Connection, directory?: string) {
  return Effect.gen(function* () {
    const sessionsSvc = yield* Session.Service

    const sessions = yield* sessionsSvc.list(directory ? { directory } : undefined)

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

      yield* conn.push({
        type: "push.snapshot",
        page: page + 1,
        totalPages,
        sessions: sessionMeta,
      }).pipe(Effect.catch(() => Effect.void))
    }
  })
}
