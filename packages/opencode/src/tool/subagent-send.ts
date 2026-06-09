import { Effect, Schema } from "effect"
import { SessionInterAgent } from "@/session/inter-agent"
import { SessionID } from "../session/schema"
import DESCRIPTION from "./subagent-send.txt"
import * as Tool from "./tool"

const Delivery = Schema.Literals(["async", "interrupt"])

export const Parameters = Schema.Struct({
  target_session_id: Schema.String.annotate({
    description: "Target session ID — use subagent_list to discover IDs of sibling subagents",
  }),
  message: Schema.String.annotate({
    description: "Message body to deliver",
  }),
  delivery: Schema.optional(Delivery).annotate({
    description: '"async" delivers at the next safe turn boundary; "interrupt" cancels target work first and delivers immediately. Default: "async"',
  }),
})

export const SubagentSendTool = Tool.define(
  "subagent_send",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: { target_session_id: string; message: string; delivery?: "async" | "interrupt" },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const interAgent = yield* SessionInterAgent.Service

          const result = yield* interAgent.send({
            fromSessionID: ctx.sessionID,
            toSessionID: SessionID.make(params.target_session_id),
            message: params.message,
            delivery: params.delivery,
          })

          return {
            title: `Message sent to ${params.target_session_id}`,
            output: JSON.stringify(
              {
                status: "accepted",
                target_session_id: params.target_session_id,
                delivery: params.delivery ?? "async",
                mailbox_id: result.mailboxID,
              },
              null,
              2,
            ),
            metadata: {
              mailbox_id: result.mailboxID,
              target_session_id: params.target_session_id,
              delivery: params.delivery ?? "async",
            },
          }
        }).pipe(
          Effect.catchTags({
            "SessionInterAgent.SelfSendError": (error) =>
              Effect.succeed({
                title: "Cannot send message",
                output: `Cannot send message to yourself (session=${error.sessionID})`,
                metadata: { error: "self_send" },
              }),
            "SessionInterAgent.TargetNotFoundError": (error) =>
              Effect.succeed({
                title: "Target not found",
                output: `Target session not found: ${error.sessionID}. Use subagent_list to discover valid session IDs.`,
                metadata: { error: "target_not_found" },
              }),
            "SessionInterAgent.CrossRootError": (error) =>
              Effect.succeed({
                title: "Cross-root messaging not allowed",
                output: `Cross-root messaging not allowed: sender root=${error.senderRoot}, target root=${error.targetRoot}.`,
                metadata: { error: "cross_root" },
              }),
          }),
          Effect.orDie,
        ),
    }
  }),
)
