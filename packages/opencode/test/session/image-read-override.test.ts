import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { ModelMessage } from "ai"
import {
  overrideUnsupportedMedia,
  type ImageReadConfig,
  type ImageReadOverrideOptions,
} from "@/session/image-read-override"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function visionModel() {
  return ProviderTest.model({
    id: ModelV2.ID.make("gpt-4o"),
    providerID: ProviderV2.ID.make("openai"),
    name: "GPT-4o Vision",
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  })
}

function visionModelWithPdf() {
  return ProviderTest.model({
    id: ModelV2.ID.make("gpt-4o"),
    providerID: ProviderV2.ID.make("openai"),
    name: "GPT-4o Vision+PDF",
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: true },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  })
}

function noVisionModel() {
  return ProviderTest.model({
    id: ModelV2.ID.make("claude-haiku"),
    providerID: ProviderV2.ID.make("anthropic"),
    name: "Claude Haiku (no vision)",
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  })
}

function noPdfModel() {
  return ProviderTest.model({
    id: ModelV2.ID.make("claude-haiku"),
    providerID: ProviderV2.ID.make("anthropic"),
    name: "Claude Haiku (no PDF)",
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  })
}

function makeFakeProviderLayer(model: Provider.Model) {
  return ProviderTest.fake({ model }).layer
}

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCnRyYWlsZXIKPDwgL1Jvb3QgMyAwIFIgPj4K"

function userImageMessage(filename?: string): ModelMessage {
  return {
    role: "user",
    content: [{ type: "file", mediaType: "image/png", filename, data: IMAGE_DATA_URL }],
  }
}

function userPdfMessage(filename?: string): ModelMessage {
  return {
    role: "user",
    content: [{ type: "file", mediaType: "application/pdf", filename, data: PDF_DATA_URL }],
  }
}

function toolResultMediaMessage(role: "tool" | "assistant"): ModelMessage {
  return {
    role,
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        output: {
          type: "content",
          value: [{ type: "media", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }, { type: "text", text: "extra text after image" }],
        },
      },
    ],
  }
}

const DESCRIBED_TEXT = "[Image described by openai/gpt-4o:\nA small placeholder image]"
const PDF_EXTRACTED_TEXT = "This is the extracted PDF content."
const DESCRIBE_ERROR_TEXT = "ERROR: Image description service unavailable"

// ---------------------------------------------------------------------------
// Test 1: No-op when model has image support
// ---------------------------------------------------------------------------
const testNoOp = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testNoOp.effect("no-op when active model supports images", () =>
  Effect.gen(function* () {
    const active = visionModelWithPdf()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [userImageMessage("photo.png")]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toEqual(messages)
  }),
)

// ---------------------------------------------------------------------------
// Test 2: User image file part replaced with description
// ---------------------------------------------------------------------------
const testUserImage = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testUserImage.effect("replaces user image file part with text description when model lacks image support", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [userImageMessage("photo.png")]

    const describeImage: NonNullable<ImageReadOverrideOptions["describeImage"]> = () =>
      Effect.succeed(DESCRIBED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { describeImage })

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    expect(result[0].content).toHaveLength(1)
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toBe(DESCRIBED_TEXT)
  }),
)

// ---------------------------------------------------------------------------
// Test 3: User PDF file part replaced with extracted text
// ---------------------------------------------------------------------------
const testUserPdf = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testUserPdf.effect("replaces user PDF file part with extracted text when model lacks pdf support", () =>
  Effect.gen(function* () {
    const active = noPdfModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o", pdf_strategy: "extract_text" }
    const messages: ModelMessage[] = [userPdfMessage("doc.pdf")]

    const extractPdfText: NonNullable<ImageReadOverrideOptions["extractPdfText"]> = () =>
      Effect.succeed(PDF_EXTRACTED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { extractPdfText })

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    expect(result[0].content).toHaveLength(1)
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toContain('[PDF "doc.pdf" text content:')
    expect(part.text).toContain(PDF_EXTRACTED_TEXT)
  }),
)

// ---------------------------------------------------------------------------
// Test 4: Tool-role inline media replaced with description
// ---------------------------------------------------------------------------
const testToolMedia = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testToolMedia.effect("replaces tool-role inline image media with text description", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [toolResultMediaMessage("tool")]

    const describeImage: NonNullable<ImageReadOverrideOptions["describeImage"]> = () =>
      Effect.succeed(DESCRIBED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { describeImage })

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("tool")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("tool-result")
    expect(part.output.type).toBe("content")
    expect(part.output.value).toHaveLength(2)
    expect(part.output.value[0].type).toBe("text")
    expect(part.output.value[0].text).toBe(DESCRIBED_TEXT)
    expect(part.output.value[1].type).toBe("text")
  }),
)

// ---------------------------------------------------------------------------
// Test 5: Assistant-role inline media replaced with description
// ---------------------------------------------------------------------------
const testAssistantMedia = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testAssistantMedia.effect("replaces assistant-role inline image media with text description", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [toolResultMediaMessage("assistant")]

    const describeImage: NonNullable<ImageReadOverrideOptions["describeImage"]> = () =>
      Effect.succeed(DESCRIBED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { describeImage })

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("assistant")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("tool-result")
    expect(part.output.type).toBe("content")
    expect(part.output.value[0].type).toBe("text")
    expect(part.output.value[0].text).toBe(DESCRIBED_TEXT)
  }),
)

// ---------------------------------------------------------------------------
// Test 6: Invalid configured model — returns replacement error text
// ---------------------------------------------------------------------------

// getModel returns Effect.fail (not die) so Effect.catch can intercept it.
function layerGetModelFails(errorMsg: string) {
  return Layer.succeed(
    Provider.Service,
    Provider.Service.of({
      list: Effect.fn("list")(() => Effect.succeed({})),
      getProvider: Effect.fn("getProvider")(() =>
        Effect.succeed(ProviderTest.info()),
      ),
      getModel: Effect.fn("getModel")(() =>
        Effect.fail(
          new Provider.ModelNotFoundError({
            providerID: ProviderV2.ID.make("nonexistent"),
            modelID: ModelV2.ID.make("bogus"),
          }),
        ),
      ),
      getLanguage: Effect.fn("getLanguage")(() =>
        Effect.die(new Error("getLanguage not needed")),
      ),
      closest: Effect.fn("closest")(() => Effect.succeed(undefined)),
      getSmallModel: Effect.fn("getSmallModel")(() => Effect.succeed(undefined)),
      defaultModel: Effect.fn("defaultModel")(() => Effect.fail(new Provider.NoModelsError({ providerID: ProviderV2.ID.make("nonexistent") }))),
    }),
  )
}

const testInvalidModel = testEffect(layerGetModelFails("Model not found"))

testInvalidModel.effect("returns error text when configured vision model does not exist", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "nonexistent/bogus" }
    const messages: ModelMessage[] = [userImageMessage()]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toMatch(/ERROR: Failed to resolve image_read model/)
  }),
)

// ---------------------------------------------------------------------------
// Test 7: Configured model resolves but is non-vision — replacement error text
// ---------------------------------------------------------------------------
const testNonVisionModel = testEffect(
  makeFakeProviderLayer(
    ProviderTest.model({
      id: ModelV2.ID.make("my-nonvision"),
      capabilities: {
        ...ProviderTest.model().capabilities,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
      },
    }),
  ),
)

testNonVisionModel.effect("returns error text when configured model lacks image support", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/my-nonvision" }
    const messages: ModelMessage[] = [userImageMessage()]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toMatch(/ERROR: Configured image_read model/)
    expect(part.text).toMatch(/does not support image input/)
  }),
)

// ---------------------------------------------------------------------------
// Test 8: Injected describeImage returns failure text
// ---------------------------------------------------------------------------
const testDescribeImageFailure = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testDescribeImageFailure.effect("returns replacement error text when describeImage signals failure", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [userImageMessage("broken.png")]

    const describeImage: NonNullable<ImageReadOverrideOptions["describeImage"]> = () =>
      Effect.succeed(DESCRIBE_ERROR_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { describeImage })

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toBe(DESCRIBE_ERROR_TEXT)
  }),
)

// ---------------------------------------------------------------------------
// Test 9: PDF strategy "error" — returns error text, not pass-through
// ---------------------------------------------------------------------------
const testPdfStrategyError = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testPdfStrategyError.effect("returns error text when pdf_strategy is 'error'", () =>
  Effect.gen(function* () {
    const active = noPdfModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o", pdf_strategy: "error" }
    const messages: ModelMessage[] = [userPdfMessage("report.pdf")]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toContain('ERROR: Cannot read "report.pdf"')
    expect(part.text).toContain("PDF input is not supported")
  }),
)

// ---------------------------------------------------------------------------
// Test 10: PDF oversize truncation note
// ---------------------------------------------------------------------------
const testPdfOversize = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testPdfOversize.effect("returns truncation note when extractPdfText signals oversize PDF", () =>
  Effect.gen(function* () {
    const active = noPdfModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [userPdfMessage("big.pdf")]

    const extractPdfText: NonNullable<ImageReadOverrideOptions["extractPdfText"]> = () =>
      Effect.succeed("[PDF text truncated: showing first 488KB]\n\nsome partial content")

    const result = yield* overrideUnsupportedMedia(messages, active, config, { extractPdfText })

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toContain("truncated")
    expect(part.text).toContain("488KB")
  }),
)

// ---------------------------------------------------------------------------
// Test 11: Empty config — no image override, no-op when model supports pdf
// ---------------------------------------------------------------------------
const testEmptyConfig = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testEmptyConfig.effect("no override when image_read config is empty and model supports both image and pdf", () =>
  Effect.gen(function* () {
    const active = visionModelWithPdf()
    const config: ImageReadConfig = {}
    const messages: ModelMessage[] = [userImageMessage(), userPdfMessage()]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toEqual(messages)
  }),
)

// ---------------------------------------------------------------------------
// Test 12: Empty config with pdf-unsupported model — pdf still overridden
// ---------------------------------------------------------------------------
const testEmptyConfigPdfOverride = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testEmptyConfigPdfOverride.effect("overrides pdf even with empty config when model lacks pdf support", () =>
  Effect.gen(function* () {
    const active = noPdfModel()
    const config: ImageReadConfig = {}
    const messages: ModelMessage[] = [userPdfMessage("doc.pdf")]

    const extractPdfText: NonNullable<ImageReadOverrideOptions["extractPdfText"]> = () =>
      Effect.succeed(PDF_EXTRACTED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { extractPdfText })

    expect(result).toHaveLength(1)
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toContain(PDF_EXTRACTED_TEXT)
  }),
)

// ---------------------------------------------------------------------------
// Test 13: Non-base64 data URLs (http URLs) in file parts
// ---------------------------------------------------------------------------
const testHttpUrl = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testHttpUrl.effect("replaces http URL image file part with error text when model lacks image support", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", filename: "remote.png", data: "https://example.com/image.png" }],
      },
    ]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toHaveLength(1)
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    // HTTP URL cannot be base64-extracted → error about invalid image
    expect(part.text).toMatch(/ERROR: Image/)
    expect(part.text).toMatch(/is empty or corrupted/)
  }),
)

// ---------------------------------------------------------------------------
// Additional: image part (type "image") replacement
// ---------------------------------------------------------------------------
const testImagePart = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testImagePart.effect("replaces user image type part with text description", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "image" as any, image: IMAGE_DATA_URL }],
      },
    ]

    const describeImage: NonNullable<ImageReadOverrideOptions["describeImage"]> = () =>
      Effect.succeed(DESCRIBED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { describeImage })

    expect(result).toHaveLength(1)
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toBe(DESCRIBED_TEXT)
  }),
)

// ---------------------------------------------------------------------------
// Additional: messages array with multiple roles — only user/tool/assistant processed
// ---------------------------------------------------------------------------
const testMixedRoles = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testMixedRoles.effect("processes user image and tool media in a mixed message array", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [
      userImageMessage("photo.png"),
      { role: "system", content: "system context" },
      toolResultMediaMessage("tool"),
    ]

    const describeImage: NonNullable<ImageReadOverrideOptions["describeImage"]> = () =>
      Effect.succeed(DESCRIBED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { describeImage })

    expect(result).toHaveLength(3)

    // User message: image replaced
    expect((result[0].content as any[])[0].type).toBe("text")
    expect((result[0].content as any[])[0].text).toBe(DESCRIBED_TEXT)

    // System message: untouched
    expect(result[1]).toEqual(messages[1])

    // Tool message: media replaced
    const toolPart = (result[2].content as any[])[0]
    expect(toolPart.output.value[0].type).toBe("text")
    expect(toolPart.output.value[0].text).toBe(DESCRIBED_TEXT)
  }),
)

// ---------------------------------------------------------------------------
// Tool PDF media helper
// ---------------------------------------------------------------------------
function toolResultPdfMediaMessage(role: "tool" | "assistant"): ModelMessage {
  return {
    role,
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        output: {
          type: "content",
          value: [{ type: "media", mediaType: "application/pdf", data: "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCnRyYWlsZXIKPDwgL1Jvb3QgMyAwIFIgPj4K" }, { type: "text", text: "PDF read successfully" }],
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Test: Tool-role PDF media extract_text (handlePdfMediaItem)
// ---------------------------------------------------------------------------
const testToolPdfMedia = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testToolPdfMedia.effect("replaces tool-role inline PDF media with extracted text", () =>
  Effect.gen(function* () {
    const active = noPdfModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o", pdf_strategy: "extract_text" }
    const messages: ModelMessage[] = [toolResultPdfMediaMessage("tool")]

    const extractPdfText: NonNullable<ImageReadOverrideOptions["extractPdfText"]> = () =>
      Effect.succeed(PDF_EXTRACTED_TEXT)

    const result = yield* overrideUnsupportedMedia(messages, active, config, { extractPdfText })

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("tool")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("tool-result")
    expect(part.output.type).toBe("content")
    expect(part.output.value).toHaveLength(2)
    expect(part.output.value[0].type).toBe("text")
    expect(part.output.value[0].text).toMatch(/\[PDF\s+text content:/)
    expect(part.output.value[0].text).toContain(PDF_EXTRACTED_TEXT)
    expect(part.output.value[1].type).toBe("text")
  }),
)

// ---------------------------------------------------------------------------
// Test: Tool-role PDF media with pdf_strategy: error
// ---------------------------------------------------------------------------
const testToolPdfMediaError = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testToolPdfMediaError.effect("returns error text for tool-role inline PDF media when pdf_strategy is 'error'", () =>
  Effect.gen(function* () {
    const active = noPdfModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o", pdf_strategy: "error" }
    const messages: ModelMessage[] = [toolResultPdfMediaMessage("tool")]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("tool")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("tool-result")
    expect(part.output.value).toHaveLength(2)
    expect(part.output.value[0].type).toBe("text")
    expect(part.output.value[0].text).toContain("ERROR: Cannot read")
    expect(part.output.value[0].text).toContain("PDF input is not supported")
  }),
)

// ---------------------------------------------------------------------------
// Test: parseModel guard rejects bare model string without /
// ---------------------------------------------------------------------------
const testBareModelId = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testBareModelId.effect("returns error text when image_read.model has no provider prefix", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "barestring" }
    const messages: ModelMessage[] = [userImageMessage()]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toMatch(/ERROR: Invalid image_read\.model/)
    expect(part.text).toMatch(/barestring/)
    expect(part.text).toMatch(/Expected format.*provider\/model/)
  }),
)

// ---------------------------------------------------------------------------
// Additional: image file part with empty content → error text
// ---------------------------------------------------------------------------
const testEmptyImage = testEffect(
  makeFakeProviderLayer(visionModel()),
)

testEmptyImage.effect("returns error text for empty file data", () =>
  Effect.gen(function* () {
    const active = noVisionModel()
    const config: ImageReadConfig = { model: "openai/gpt-4o" }
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", filename: "empty.png", data: "data:image/png;base64," }],
      },
    ]

    const result = yield* overrideUnsupportedMedia(messages, active, config)

    expect(result).toHaveLength(1)
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toMatch(/ERROR: Image/)
    expect(part.text).toMatch(/empty or corrupted/)
  }),
)
