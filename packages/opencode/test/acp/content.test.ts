import { describe, expect, test } from "bun:test"
import type { ContentBlock } from "@agentclientprotocol/sdk"
import { pathToFileURL } from "node:url"
import type { TranscriptV2Display } from "../../src/session/transcript-v2-display"
import {
  contentBlockToParts,
  displayTranscriptToContentChunks,
  displayTranscriptToReplayParts,
  partsToContentChunks,
  promptContentToParts,
} from "../../src/acp/content"

describe("acp content conversion", () => {
  test("plain text block becomes a text part", () => {
    expect(contentBlockToParts({ type: "text", text: "hello" })).toEqual([{ type: "text", text: "hello" }])
  })

  test("assistant-only text audience becomes synthetic", () => {
    expect(
      contentBlockToParts({
        type: "text",
        text: "internal",
        annotations: { audience: ["assistant"] },
      }),
    ).toEqual([{ type: "text", text: "internal", synthetic: true }])
  })

  test("user-only text audience becomes ignored", () => {
    expect(
      contentBlockToParts({
        type: "text",
        text: "visible to user",
        annotations: { audience: ["user"] },
      }),
    ).toEqual([{ type: "text", text: "visible to user", ignored: true }])
  })

  test("image block with base64 data becomes a data URL file part", () => {
    expect(
      contentBlockToParts({
        type: "image",
        data: "AAAA",
        mimeType: "image/png",
        uri: "file:///tmp/screenshot.png",
      }),
    ).toEqual([
      {
        type: "file",
        url: "data:image/png;base64,AAAA",
        filename: "screenshot.png",
        mime: "image/png",
      },
    ])
  })

  test("image block with http URI becomes a file part", () => {
    expect(
      contentBlockToParts({
        type: "image",
        data: "",
        mimeType: "image/jpeg",
        uri: "http://example.com/assets/photo.jpg",
      }),
    ).toEqual([
      {
        type: "file",
        url: "http://example.com/assets/photo.jpg",
        filename: "photo.jpg",
        mime: "image/jpeg",
      },
    ])
  })

  test("resource_link file URL becomes a file part with name and fallback mime", () => {
    expect(
      contentBlockToParts({
        type: "resource_link",
        uri: "file:///tmp/notes.txt",
        name: "client-notes.txt",
      }),
    ).toEqual([
      {
        type: "file",
        url: "file:///tmp/notes.txt",
        filename: "client-notes.txt",
        mime: "text/plain",
      },
    ])
  })

  test("resource_link zed path becomes a file URL part", () => {
    expect(
      contentBlockToParts({
        type: "resource_link",
        uri: "zed://workspace?path=/tmp/project/src/app.ts",
        name: "app.ts",
        mimeType: "text/typescript",
      }),
    ).toEqual([
      {
        type: "file",
        url: pathToFileURL("/tmp/project/src/app.ts").href,
        filename: "app.ts",
        mime: "text/typescript",
      },
    ])
  })

  test("resource with text becomes a text part", () => {
    expect(
      contentBlockToParts({
        type: "resource",
        resource: {
          uri: "file:///tmp/context.txt",
          mimeType: "text/plain",
          text: "context",
        },
      }),
    ).toEqual([{ type: "text", text: "context" }])
  })

  test("resource with blob and mimeType becomes a data URL file part", () => {
    expect(
      contentBlockToParts({
        type: "resource",
        resource: {
          uri: "file:///tmp/report.pdf",
          mimeType: "application/pdf",
          blob: "JVBERg==",
        },
      }),
    ).toEqual([
      {
        type: "file",
        url: "data:application/pdf;base64,JVBERg==",
        filename: "report.pdf",
        mime: "application/pdf",
      },
    ])
  })

  test("data URL resource is preserved as a file part", () => {
    expect(
      contentBlockToParts({
        type: "resource",
        resource: {
          uri: "data:text/plain;base64,aGVsbG8=",
          mimeType: "text/plain",
          blob: "ignored",
        },
      }),
    ).toEqual([
      {
        type: "file",
        url: "data:text/plain;base64,aGVsbG8=",
        filename: "file",
        mime: "text/plain",
      },
    ])
  })

  test("unsupported blocks are ignored", () => {
    expect(promptContentToParts([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }])).toEqual([])
    expect(promptContentToParts([{ type: "unknown", text: "skip" } as unknown as ContentBlock])).toEqual([])
  })
})

describe("acp replay conversion", () => {
  test("replays text audience annotations", () => {
    expect(partsToContentChunks([{ type: "text", text: "cached", synthetic: true }])).toEqual([
      {
        content: {
          type: "text",
          text: "cached",
          annotations: { audience: ["assistant"] },
        },
      },
    ])
  })

  test("replays file and data URL parts as ACP content", () => {
    expect(
      partsToContentChunks([
        { type: "file", url: "file:///tmp/readme.md", filename: "readme.md", mime: "text/markdown" },
        { type: "file", url: "data:text/plain;base64,aGVsbG8=", filename: "note.txt", mime: "text/plain" },
      ]),
    ).toEqual([
      {
        content: {
          type: "resource_link",
          uri: "file:///tmp/readme.md",
          name: "readme.md",
          mimeType: "text/markdown",
        },
      },
      {
        content: {
          type: "resource",
          resource: {
            uri: pathToFileURL("note.txt").href,
            mimeType: "text/plain",
            text: "hello",
          },
        },
      },
    ])
  })
})

describe("acp display transcript fixture conversion", () => {
  test("converts user text, files, and local task requests", () => {
    expect(
      displayTranscriptToReplayParts([
        userDisplay({
          text: "review this",
          files: [{ uri: "file:///workspace/README.md", mime: "text/markdown", name: "README.md" }],
          taskRequests: [
            {
              type: "task-request",
              id: "evt_task_request",
              agent: "reviewer",
              command: "review",
              description: "Review the changes",
              prompt: "Check accessibility",
            },
          ],
        }),
      ]),
    ).toEqual([
      { type: "text", text: "review this" },
      { type: "file", url: "file:///workspace/README.md", mime: "text/markdown", filename: "README.md" },
      {
        type: "text",
        text: "Task request for reviewer\nCommand: review\nReview the changes\nCheck accessibility",
      },
    ])
  })

  test("converts assistant text, reasoning, tools, and patches without assistant retry metadata", () => {
    const parts = displayTranscriptToReplayParts([
      assistantDisplay({
        retries: [{ attempt: 1, error: { message: "retry me", isRetryable: true }, time: { created: 1 } } as unknown as NonNullable<TranscriptV2Display.DisplayAssistant["retries"]>[number]],
        error: { type: "unknown", message: "terminal error" },
        content: [
          { type: "text", id: "evt_text", text: "Done" },
          { type: "reasoning", id: "evt_reasoning", reasoningID: "reasoning-1", text: "Thinking" },
          toolDisplay("pending", { status: "pending", input: "raw input" }),
          toolDisplay("running", {
            status: "running",
            input: { cmd: "ls" },
            structured: { ok: true },
            content: [{ type: "text", text: "still running" }],
          }),
          toolDisplay("completed", {
            status: "completed",
            input: { cmd: "pwd" },
            structured: { cwd: "/workspace" },
            content: [
              { type: "text", text: "ok" },
              { type: "file", uri: "file:///workspace/out.txt", mime: "text/plain", name: "out.txt" },
            ],
          }),
          toolDisplay("error", {
            status: "error",
            input: { cmd: "false" },
            structured: {},
            content: [{ type: "text", text: "stderr" }],
            error: { type: "unknown", message: "failed" },
          }),
          { type: "patch", id: "evt_patch", hash: "abc123", files: ["src/app.ts", "README.md"] },
        ],
      }),
    ])

    expect(parts).toEqual([
      { type: "text", text: "Done" },
      { type: "reasoning", text: "Thinking" },
      { type: "text", text: "Tool Bash pending\nraw input" },
      { type: "text", text: 'Tool Bash running\n{"cmd":"ls"}' },
      { type: "text", text: "still running" },
      { type: "text", text: 'Tool Bash completed\n{"cmd":"pwd"}' },
      { type: "text", text: "ok" },
      { type: "file", url: "file:///workspace/out.txt", mime: "text/plain", filename: "out.txt" },
      { type: "text", text: 'Tool Bash error\n{"cmd":"false"}\nError: failed' },
      { type: "text", text: "stderr" },
      { type: "text", text: "Patch\nsrc/app.ts\nREADME.md" },
    ])
    expect(JSON.stringify(parts)).not.toContain("terminal error")
    expect(JSON.stringify(parts)).not.toContain("retry me")
  })

  test("converts shell, synthetic, compaction, agent switches, and model switches", () => {
    expect(
      displayTranscriptToReplayParts([
        { type: "agent-switched", id: "evt_agent", agent: "build", time: { created: 1 } },
        { type: "model-switched", id: "evt_model", model: modelDisplay(), time: { created: 2 } },
        { type: "shell", id: "evt_shell", callID: "call", command: "echo hi", output: "hi", time: { created: 3 } },
        { type: "synthetic", id: "evt_synthetic", sessionID: "ses_child", text: "background result", time: { created: 4 } },
        { type: "compaction", id: "evt_compaction", reason: "manual", summary: "summary", time: { created: 5 } },
      ]),
    ).toEqual([
      { type: "text", text: "Agent switched to build" },
      { type: "text", text: "Model switched to provider/model" },
      { type: "text", text: "Shell\n$ echo hi\nhi" },
      { type: "text", text: "background result", synthetic: true },
      { type: "text", text: "Compaction (manual)\nsummary" },
    ])
  })

  test("converts display transcript directly to ACP content chunks and omits empty text", () => {
    expect(
      displayTranscriptToContentChunks([
        userDisplay({ text: "", files: [] }),
        assistantDisplay({ content: [{ type: "text", id: "evt_empty", text: "" }] }),
        assistantDisplay({ content: [{ type: "text", id: "evt_visible", text: "visible" }] }),
      ]),
    ).toEqual([{ content: { type: "text", text: "visible" } }])
  })

  test("does not introduce raw legacy-looking message or part IDs", () => {
    const parts = displayTranscriptToReplayParts([
      userDisplay({
        id: "msg_should_not_render",
        text: "safe user text",
        taskRequests: [{ type: "task-request", id: "prt_should_not_render", prompt: "safe prompt", description: "safe description", agent: "build" }],
      }),
      assistantDisplay({
        id: "msg_assistant_should_not_render",
        content: [{ type: "text", id: "prt_text_should_not_render", text: "safe assistant text" }],
      }),
    ])

    expect(JSON.stringify(parts)).not.toContain("msg_")
    expect(JSON.stringify(parts)).not.toContain("prt_")
  })

  test("source-purity guard keeps fixture adapter unwired from legacy/session readers", async () => {
    const source = await Bun.file(new URL("../../src/acp/content.ts", import.meta.url)).text()
    const blocked = [
      "SessionLegacy",
      "MessageV2",
      "SessionV2",
      "Database",
      "Session.Service",
      "backfill",
      "session-replay",
      "session-data",
      "@opencode-ai/core/session/legacy",
    ]

    for (const value of blocked) {
      expect(source).not.toContain(value)
    }
  })
})

function userDisplay(input: Partial<TranscriptV2Display.DisplayUser>): TranscriptV2Display.DisplayUser {
  return {
    type: "user",
    id: "evt_user",
    text: "user",
    files: [],
    agents: [],
    references: [],
    time: { created: 1 },
    ...input,
  } as TranscriptV2Display.DisplayUser
}

function assistantDisplay(input: Partial<TranscriptV2Display.DisplayAssistant>): TranscriptV2Display.DisplayAssistant {
  return {
    type: "assistant",
    id: "evt_assistant",
    agent: "build",
    model: modelDisplay(),
    content: [],
    time: { created: 1 },
    ...input,
  } as TranscriptV2Display.DisplayAssistant
}

function toolDisplay(
  suffix: string,
  state: TranscriptV2Display.DisplayToolState,
): TranscriptV2Display.DisplayAssistantTool {
  return {
    type: "tool",
    id: `evt_tool_${suffix}`,
    callID: `call-${suffix}`,
    name: "bash",
    title: "Bash",
    provider: { executed: true },
    state,
    time: { created: 1 },
  }
}

function modelDisplay(): TranscriptV2Display.DisplayModelSwitched["model"] {
  return { providerID: "provider", id: "model", variant: "default" } as TranscriptV2Display.DisplayModelSwitched["model"]
}
