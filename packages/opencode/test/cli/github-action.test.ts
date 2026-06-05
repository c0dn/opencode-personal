import { test, expect, describe } from "bun:test"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { createGitHubSessionEventDisplay, extractResponseText, formatPromptTooLargeError } from "../../src/cli/cmd/github"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// Helper to create minimal valid parts
function createTextPart(text: string): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "text" as const,
    text,
  }
}

function createReasoningPart(text: string): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "reasoning" as const,
    text,
    time: { start: 0 },
  }
}

function createToolPart(
  tool: string,
  title: string,
  status: "completed" | "running" = "completed",
): SessionLegacy.Part {
  if (status === "completed") {
    return {
      id: PartID.ascending(),
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      type: "tool" as const,
      callID: "c1",
      tool,
      state: {
        status: "completed",
        input: {},
        output: "",
        title,
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }
  }
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "tool" as const,
    callID: "c1",
    tool,
    state: {
      status: "running",
      input: {},
      time: { start: 0 },
    },
  }
}

function createStepStartPart(): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "step-start" as const,
  }
}

function createStepFinishPart(): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "step-finish" as const,
    reason: "done",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("extractResponseText", () => {
  test("returns text from text part", () => {
    const parts = [createTextPart("Hello world")]
    expect(extractResponseText(parts)).toBe("Hello world")
  })

  test("returns last text part when multiple exist", () => {
    const parts = [createTextPart("First"), createTextPart("Last")]
    expect(extractResponseText(parts)).toBe("Last")
  })

  test("returns text even when tool parts follow", () => {
    const parts = [createTextPart("I'll help with that."), createToolPart("todowrite", "3 todos")]
    expect(extractResponseText(parts)).toBe("I'll help with that.")
  })

  test("returns null for reasoning-only response (signals summary needed)", () => {
    const parts = [createReasoningPart("Let me think about this...")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for tool-only response (signals summary needed)", () => {
    // This is the exact scenario from the bug report - todowrite with no text
    const parts = [createToolPart("todowrite", "8 todos")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for multiple completed tools", () => {
    const parts = [
      createToolPart("read", "src/file.ts"),
      createToolPart("edit", "src/file.ts"),
      createToolPart("bash", "bun test"),
    ]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for running tool parts (signals summary needed)", () => {
    const parts = [createToolPart("bash", "", "running")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("throws on empty array", () => {
    expect(() => extractResponseText([])).toThrow("no parts returned")
  })

  test("returns null for step-start only", () => {
    const parts = [createStepStartPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for step-finish only", () => {
    const parts = [createStepFinishPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for step-start and step-finish", () => {
    const parts = [createStepStartPart(), createStepFinishPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns text from multi-step response", () => {
    const parts = [
      createStepStartPart(),
      createToolPart("read", "src/file.ts"),
      createTextPart("Done"),
      createStepFinishPart(),
    ]
    expect(extractResponseText(parts)).toBe("Done")
  })

  test("prefers text over reasoning when both present", () => {
    const parts = [createReasoningPart("Internal thinking..."), createTextPart("Final answer")]
    expect(extractResponseText(parts)).toBe("Final answer")
  })

  test("prefers text over tools when both present", () => {
    const parts = [createToolPart("read", "src/file.ts"), createTextPart("Here's what I found")]
    expect(extractResponseText(parts)).toBe("Here's what I found")
  })
})

describe("formatPromptTooLargeError", () => {
  test("formats error without files", () => {
    const result = formatPromptTooLargeError([])
    expect(result).toBe("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
  })

  test("formats error with files (base64 content)", () => {
    // Base64 is ~33% larger than original, so we multiply by 0.75 to get original size
    // 400 KB base64 = 300 KB original, 200 KB base64 = 150 KB original
    const files = [
      { filename: "screenshot.png", content: "a".repeat(400 * 1024) },
      { filename: "diagram.png", content: "b".repeat(200 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toStartWith("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
    expect(result).toInclude("Files in prompt:")
    expect(result).toInclude("screenshot.png (300 KB)")
    expect(result).toInclude("diagram.png (150 KB)")
  })

  test("lists all files when multiple present", () => {
    // Base64 sizes: 4KB -> 3KB, 8KB -> 6KB, 12KB -> 9KB
    const files = [
      { filename: "img1.png", content: "x".repeat(4 * 1024) },
      { filename: "img2.jpg", content: "y".repeat(8 * 1024) },
      { filename: "img3.gif", content: "z".repeat(12 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toInclude("img1.png (3 KB)")
    expect(result).toInclude("img2.jpg (6 KB)")
    expect(result).toInclude("img3.gif (9 KB)")
  })
})

describe("createGitHubSessionEventDisplay", () => {
  test("returns final text from direct v2 text ended event data", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    expect(
      display({
        type: SessionEvent.Text.Ended.type,
        data: { sessionID: SessionID.make("ses_test"), text: "Done" },
      }),
    ).toEqual({ type: "text", text: "Done" })
  })

  test("ignores events from other sessions", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    expect(
      display({
        type: SessionEvent.Text.Ended.type,
        data: { sessionID: SessionID.make("ses_other"), text: "Ignored" },
      }),
    ).toBeUndefined()
  })

  test("prints completed tools from cached called event data", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    expect(
      display({
        type: SessionEvent.Tool.Called.type,
        data: {
          sessionID: SessionID.make("ses_test"),
          callID: "call_1",
          tool: "bash",
          input: { command: "bun test" },
        },
      }),
    ).toBeUndefined()

    expect(
      display({
        type: SessionEvent.Tool.Success.type,
        data: {
          sessionID: SessionID.make("ses_test"),
          callID: "call_1",
          title: "bun test",
        },
      }),
    ).toMatchObject({ type: "tool", tool: "Shell", title: "bun test" })
  })

  test("uses cached tool input when success title is missing", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    display({
      type: SessionEvent.Tool.Called.type,
      data: {
        sessionID: SessionID.make("ses_test"),
        callID: "call_1",
        tool: "read",
        input: { filePath: "README.md" },
      },
    })

    expect(
      display({
        type: SessionEvent.Tool.Success.type,
        data: { sessionID: SessionID.make("ses_test"), callID: "call_1" },
      }),
    ).toMatchObject({ type: "tool", tool: "Read", title: '{"filePath":"README.md"}' })
  })

  test("uses cached tool input when success title is empty", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    display({
      type: SessionEvent.Tool.Called.type,
      data: {
        sessionID: SessionID.make("ses_test"),
        callID: "call_1",
        tool: "read",
        input: { filePath: "README.md" },
      },
    })

    expect(
      display({
        type: SessionEvent.Tool.Success.type,
        data: { sessionID: SessionID.make("ses_test"), callID: "call_1", title: "" },
      }),
    ).toMatchObject({ type: "tool", tool: "Read", title: '{"filePath":"README.md"}' })
  })

  test("ignores tool success without cached called event", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    expect(
      display({
        type: SessionEvent.Tool.Success.type,
        data: { sessionID: SessionID.make("ses_test"), callID: "call_1", title: "late" },
      }),
    ).toBeUndefined()
  })

  test("ignores unrelated event types", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    expect(
      display({
        type: "session.next.model.switched",
        data: { sessionID: SessionID.make("ses_test") },
      }),
    ).toBeUndefined()
  })

  test("cleans pending tool calls on failed events", () => {
    const display = createGitHubSessionEventDisplay(SessionID.make("ses_test"))

    display({
      type: SessionEvent.Tool.Called.type,
      data: {
        sessionID: SessionID.make("ses_test"),
        callID: "call_1",
        tool: "bash",
        input: { command: "bun test" },
      },
    })
    display({
      type: SessionEvent.Tool.Failed.type,
      data: { sessionID: SessionID.make("ses_test"), callID: "call_1" },
    })

    expect(
      display({
        type: SessionEvent.Tool.Success.type,
        data: { sessionID: SessionID.make("ses_test"), callID: "call_1", title: "late" },
      }),
    ).toBeUndefined()
  })
})
