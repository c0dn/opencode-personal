import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "../session/schema"
import DESCRIPTION from "./subagent-list.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const SubagentListTool = Tool.define(
  "subagent_list",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const status = yield* SessionStatus.Service
          const callerID = ctx.sessionID
          const caller = yield* session.get(callerID)
          const callerDepth = yield* session.depthFromRoot(callerID)

          // Walk up to root
          let rootID = callerID
          let currentID: string | undefined = caller.parentID
          while (currentID) {
            rootID = SessionID.make(currentID)
            const parent = yield* session.get(rootID)
            currentID = parent.parentID
          }

          // Get root + all descendants
          const rootSession = yield* session.get(rootID)
          const descendantEntries = yield* session.descendants(rootID)
          const allStatuses = yield* status.list()

          const resolveStatus = (sessionID: string): string => {
            const s = allStatuses.get(SessionID.make(sessionID))
            if (s) return s.type
            return "unknown"
          }

          const resolveRelationship = (sessionID: string, entryDepth: number, entryParentID: string | undefined): string => {
            if (sessionID === callerID) return "self"
            if (sessionID === caller.parentID) return "parent"
            if (entryParentID === callerID) return "child"

            if (entryDepth < callerDepth) return "ancestor"
            if (entryDepth > callerDepth) return "descendant"

            if (entryParentID === caller.parentID) return "sibling"
            return "peer"
          }

          // Root session entry
          const rootEntry = {
            id: rootSession.id,
            agent: rootSession.agent ?? "unknown",
            status: resolveStatus(rootSession.id),
            title: rootSession.title,
            relationship: resolveRelationship(rootSession.id, 0, rootSession.parentID),
            depth: 0,
            parent_id: rootSession.parentID ?? null,
          }

          // Descendant entries
          const descendantResults = descendantEntries.map((entry) => ({
            id: entry.session.id,
            agent: entry.session.agent ?? "unknown",
            status: resolveStatus(entry.session.id),
            title: entry.session.title,
            relationship: resolveRelationship(entry.session.id, entry.depth, entry.session.parentID),
            depth: entry.depth,
            parent_id: entry.session.parentID ?? null,
          }))

          const results = [rootEntry, ...descendantResults]

          const output = JSON.stringify({ sessions: results }, null, 2)

          return {
            title: `${results.length} sessions in tree`,
            output,
            metadata: {
              count: results.length,
              root_id: rootID,
              caller_id: callerID,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
