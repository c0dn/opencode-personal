import { Effect, Schema } from "effect"
import { SessionMailbox } from "@opencode-ai/core/session/mailbox"
import DESCRIPTION from "./mailbox-list.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  state: Schema.optional(SessionMailbox.State).annotate({
    description: 'Filter by state: "queued", "processing", "delivered", "failed", or "cancelled"',
  }),
  kind: Schema.optional(SessionMailbox.Kind).annotate({
    description: 'Filter by kind: "user", "inter_agent", or "control"',
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum messages to return. Default: 50",
  }),
})

export const MailboxListTool = Tool.define(
  "mailbox_list",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: { state?: string; kind?: string; limit?: number },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const mailbox = yield* SessionMailbox.Service
          const messages = yield* mailbox.list({
            toSessionID: ctx.sessionID,
            state: params.state as SessionMailbox.State | undefined,
            kind: params.kind as SessionMailbox.Kind | undefined,
            limit: params.limit ?? 50,
          })

          const results = messages.map((m) => ({
            id: m.id,
            from: m.fromSessionID ?? null,
            to: m.toSessionID,
            kind: m.kind,
            delivery: m.delivery,
            state: m.state,
            text: m.text,
            error: m.error ?? null,
            claim_id: m.claimID ?? null,
            time: {
              created: m.time.created,
              processing: m.time.processing ?? null,
              completed: m.time.completed ?? null,
            },
          }))

          const byState: Record<string, number> = {}
          for (const m of messages) {
            byState[m.state] = (byState[m.state] ?? 0) + 1
          }

          const output = JSON.stringify(
            {
              count: results.length,
              by_state: byState,
              messages: results,
            },
            null,
            2,
          )

          return {
            title: `${results.length} mailbox messages`,
            output,
            metadata: {
              count: results.length,
              by_state: byState,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
