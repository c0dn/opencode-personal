import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AgentAttachment, FileAttachment, ReferenceAttachment, Source } from "@opencode-ai/core/session/prompt"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { DateTime } from "effect"
import { sanitizeTranscript } from "../../src/cli/cmd/export"
import { MessageID, SessionID } from "../../src/session/schema"
import { TranscriptV2Public } from "../../src/session/transcript-v2-public"

const providerID = ProviderV2.ID.make("test-provider")
const model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  variant: ModelV2.VariantID.make("default"),
}

describe("export sanitizer", () => {
  test("preserves the v2 envelope and canonical identifiers while redacting sensitive fields", () => {
    const sanitized = sanitizeTranscript(transcript())
    const encoded = TranscriptV2Public.encode(sanitized)
    const json = JSON.stringify(encoded)

    expect(encoded.version).toBe(2)
    expect(encoded.info.id).toBe("ses_export_sanitize")
    expect(encoded.messages.map((message) => message.id)).toEqual([
      "msg_user",
      "msg_synthetic",
      "msg_shell",
      "msg_assistant",
      "msg_compaction",
    ])
    expect(json).toContain("tool_call_1")
    expect(json).toContain('"status":"completed"')
    expect(json).toContain('"include":"msg_user"')
    expect(TranscriptV2Public.decode(encoded).messages).toHaveLength(5)

    for (const sensitive of [
      "Sensitive title",
      "/secret/worktree",
      "user secret prompt",
      "file:///secret.txt",
      "synthetic secret",
      "cat secret.txt",
      "shell secret output",
      "assistant secret text",
      "assistant secret reasoning",
      "tool secret output",
      "secret result",
      "snapshot-secret-start",
      "compaction secret summary",
    ]) {
      expect(json).not.toContain(sensitive)
    }
  })
})

function transcript(): TranscriptV2Public.Payload {
  return {
    version: 2,
    info: {
      id: SessionID.make("ses_export_sanitize"),
      slug: "export-sanitize",
      projectID: ProjectV2.ID.global,
      directory: "/secret/worktree",
      path: "secret/path",
      title: "Sensitive title",
      version: "test",
      summary: {
        additions: 1,
        deletions: 2,
        files: 1,
        diffs: [{ file: "secret.ts", patch: "secret diff", additions: 1, deletions: 2 }],
      },
      revert: { messageID: MessageID.make("msg_user"), snapshot: "secret revert snapshot", diff: "secret revert diff" },
      time: { created: 1, updated: 2 },
    },
    messages: [
      new SessionMessage.User({
        id: SessionMessage.ID.make("msg_user"),
        type: "user",
        text: "user secret prompt",
        files: [
          new FileAttachment({
            uri: "file:///secret.txt",
            mime: "text/plain",
            name: "secret.txt",
            description: "secret file description",
            source: new Source({ start: 0, end: 6, text: "source secret" }),
          }),
        ],
        agents: [new AgentAttachment({ name: "build", source: new Source({ start: 0, end: 5, text: "agent secret" }) })],
        references: [
          new ReferenceAttachment({
            name: "ref",
            kind: "local",
            uri: "file:///ref-secret",
            source: new Source({ start: 0, end: 3, text: "ref secret" }),
          }),
        ],
        time: { created: DateTime.makeUnsafe(10) },
      }),
      new SessionMessage.Synthetic({
        id: SessionMessage.ID.make("msg_synthetic"),
        type: "synthetic",
        sessionID: SessionID.make("ses_child"),
        text: "synthetic secret",
        time: { created: DateTime.makeUnsafe(20) },
      }),
      new SessionMessage.Shell({
        id: SessionMessage.ID.make("msg_shell"),
        type: "shell",
        callID: "shell_call_1",
        command: "cat secret.txt",
        output: "shell secret output",
        time: { created: DateTime.makeUnsafe(30), completed: DateTime.makeUnsafe(31) },
      }),
      new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant"),
        type: "assistant",
        agent: "build",
        model,
        content: [
          new SessionMessage.AssistantText({ type: "text", id: "txt_1", text: "assistant secret text" }),
          new SessionMessage.AssistantReasoning({
            type: "reasoning",
            id: "rsn_1",
            text: "assistant secret reasoning",
          }),
          new SessionMessage.AssistantTool({
            type: "tool",
            id: "tool_call_1",
            name: "bash",
            state: new SessionMessage.ToolStateCompleted({
              status: "completed",
              input: { command: "secret input" },
              content: [ToolOutput.text({ type: "text", text: "tool secret output" })],
              structured: { output: "structured secret" },
              result: "secret result",
            }),
            time: { created: DateTime.makeUnsafe(40), completed: DateTime.makeUnsafe(41) },
          }),
        ],
        snapshot: { start: "snapshot-secret-start", end: "snapshot-secret-end" },
        time: { created: DateTime.makeUnsafe(40), completed: DateTime.makeUnsafe(42) },
      }),
      new SessionMessage.Compaction({
        id: SessionMessage.ID.make("msg_compaction"),
        type: "compaction",
        reason: "manual",
        summary: "compaction secret summary",
        include: "msg_user",
        time: { created: DateTime.makeUnsafe(50) },
      }),
    ],
  }
}
