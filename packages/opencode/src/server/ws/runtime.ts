import { Effect, Layer, ManagedRuntime } from "effect"
import { Session } from "@/session/session"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Project } from "@/project/project"
import { Todo } from "@/session/todo"
import { SessionStatus } from "@/session/status"
import { Command } from "@/command"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Vcs } from "@/project/vcs"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionShare } from "@/share/session"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceRef } from "@/effect/instance-ref"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"

const defaultCtx = { directory: process.cwd(), worktree: process.cwd(), project: { id: "global" } } as any

const handlerLayer = Layer.mergeAll(
  Database.defaultLayer,
  FSUtil.defaultLayer,
  Git.defaultLayer,
  Layer.effect(InstanceRef, Effect.succeed(defaultCtx)),
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  Todo.defaultLayer,
  MCP.defaultLayer,
  Config.defaultLayer,
  Provider.defaultLayer,
  Project.defaultLayer,
  SessionPrompt.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionShare.defaultLayer,
  Command.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  LSP.defaultLayer,
  Format.defaultLayer,
  Vcs.defaultLayer,
  Permission.defaultLayer,
  Question.defaultLayer,
)

export const handlerRuntime = ManagedRuntime.make(handlerLayer)
