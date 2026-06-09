import type { ModelMessage } from "ai"
import { Provider } from "@/provider/provider"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { errorMessage } from "@/util/error"
import { Effect } from "effect"

export type ImageReadConfig = NonNullable<ConfigV1.Info["image_read"]>

export interface DescribeImageInput {
  data: string // raw base64 bytes (no data: prefix)
  mime: string
  filename?: string
}

export interface ImageReadOverrideOptions {
  describeImage?: (
    input: DescribeImageInput,
    visionModel: Provider.Model,
  ) => Effect.Effect<string, never, Provider.Service>
  extractPdfText?: (input: { dataUrl: string; filename?: string }) => Effect.Effect<string, never>
}

const SYSTEM_PROMPT =
  "You are an image description tool. Describe the image in detail, focusing on text content, " +
  "visual elements, layout, diagrams, code, screenshots, and any details relevant to a software " +
  "development context. Be thorough but concise."

function mediaKind(mime: string): "image" | "pdf" | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

function extractBase64FromDataUrl(dataUrl: string): string | undefined {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  return match?.[2]
}

function extractMimeFromDataUrl(dataUrl: string): string | undefined {
  const match = dataUrl.match(/^data:([^;]+);/)
  return match?.[1]
}

// ---------------------------------------------------------------------------
// Default describe image implementation
// ---------------------------------------------------------------------------

function describeImageDefault(
  input: DescribeImageInput,
  visionModel: Provider.Model,
): Effect.Effect<string, never, Provider.Service> {
  return Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(visionModel)

    const label = input.filename ? `"${input.filename}"` : ""

    const result = yield* Effect.tryPromise(() => generateImageDescription(language, input)).pipe(
      Effect.timeout("30 seconds"),
    )

    return `[Image ${label} described by ${visionModel.name}:\n${result}]`.trim()
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        `ERROR: Failed to describe image with ${visionModel.name}: ${errorMessage(error)}`,
      ),
    ),
  )
}

async function generateImageDescription(
  language: any,
  input: DescribeImageInput,
): Promise<string> {
  const { generateText } = await import("ai")
  const resp = await generateText({
    model: language,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: input.filename
              ? `Describe this image (filename: "${input.filename}").`
              : "Describe this image in detail.",
          },
          {
            type: "image" as const,
            image: `data:${input.mime};base64,${input.data}`,
            mimeType: input.mime,
          } as any,
        ],
      },
    ],
  })
  return resp.text
}

// ---------------------------------------------------------------------------
// Default PDF text extraction implementation
// ---------------------------------------------------------------------------

function extractPdfTextDefault(input: {
  dataUrl: string
  filename?: string
}): Effect.Effect<string, never> {
  return Effect.tryPromise(() => extractPdfTextContent(input)).pipe(
    Effect.catch((error) =>
      Effect.succeed(`ERROR: Failed to extract PDF text: ${errorMessage(error)}`),
    ),
  )
}

async function extractPdfTextContent(input: {
  dataUrl: string
  filename?: string
}): Promise<string> {
  const base64 = extractBase64FromDataUrl(input.dataUrl)
  if (!base64) return "ERROR: Invalid PDF data URL (missing base64 content)."

  const bytes = Buffer.from(base64, "base64")
  const sizeMB = bytes.length / (1024 * 1024)
  if (sizeMB > 50) {
    const name = input.filename ? `"${input.filename}"` : ""
    return `ERROR: PDF ${name} exceeds 50MB limit for text extraction (${sizeMB.toFixed(1)}MB).`
  }

  const pdfjsLib = await import("pdfjs-dist")
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise

  const maxPages = Math.min(doc.numPages, 100)
  const pages: string[] = []
  const MAX_TEXT_BYTES = 500 * 1024 // 500KB
  let totalBytes = 0
  let truncated = false

  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items.map((item: any) => item.str ?? "").join(" ")
    const pageBytes = Buffer.byteLength(pageText, "utf8")

    if (totalBytes + pageBytes > MAX_TEXT_BYTES) {
      const remaining = MAX_TEXT_BYTES - totalBytes
      if (remaining > 0) {
        const truncatedPage = pageText.slice(
          0,
          Math.floor(remaining * (pageText.length / pageBytes)),
        )
        pages.push(truncatedPage)
      }
      truncated = true
      break
    }

    pages.push(pageText)
    totalBytes += pageBytes
  }

  let text = pages.join("\n\n")
  if (doc.numPages > 100) {
    text += `\n\n[PDF text extraction limited to first 100 pages (document has ${doc.numPages} pages)]`
  }
  if (truncated) {
    text = `[PDF text truncated: showing first ${(MAX_TEXT_BYTES / 1024).toFixed(0)}KB]\n\n${text}`
  }

  return text
}

// ---------------------------------------------------------------------------
// Resolve vision model from config
// ---------------------------------------------------------------------------

function resolveVisionModel(modelId: string): Effect.Effect<Provider.Model, string, Provider.Service> {
  if (!modelId.includes("/")) {
    return Effect.fail(
      `ERROR: Invalid image_read.model "${modelId}". Expected format: "provider/model" (e.g. "openai/gpt-4o").`,
    )
  }

  const parsed = Provider.parseModel(modelId)
  return Effect.gen(function* () {
    const provider = yield* Provider.Service
    const visionModel = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(
      Effect.catch((error) =>
        Effect.fail(
          `ERROR: Failed to resolve image_read model "${modelId}": ${errorMessage(error)}`,
        ),
      ),
    )
    if (!visionModel.capabilities.input.image) {
      return yield* Effect.fail(
        `ERROR: Configured image_read model "${modelId}" does not support image input. Update image_read.model to a vision-capable model.`,
      )
    }
    return visionModel
  })
}

// ---------------------------------------------------------------------------
// Type checks for message content parts (use any to avoid union complexity)
// ---------------------------------------------------------------------------

function isFilePart(part: unknown): part is { type: "file"; mediaType: string; filename?: string; data: string } {
  return typeof part === "object" && part !== null && (part as any).type === "file"
}

function isImagePart(part: unknown): part is { type: "image"; image: string } {
  return typeof part === "object" && part !== null && (part as any).type === "image"
}

function isToolResultPart(part: unknown): part is {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: { type: string; value: any[] }
} {
  return typeof part === "object" && part !== null && (part as any).type === "tool-result"
}

function isMediaItem(item: unknown): item is { type: "media"; mediaType: string; data: string } {
  return typeof item === "object" && item !== null && (item as any).type === "media"
}

// ---------------------------------------------------------------------------
// Main override function
// ---------------------------------------------------------------------------

export function overrideUnsupportedMedia(
  messages: ModelMessage[],
  activeModel: Provider.Model,
  imageReadConfig: ImageReadConfig,
  options?: ImageReadOverrideOptions,
): Effect.Effect<ModelMessage[], never, Provider.Service> {
  const describeImg = options?.describeImage ?? describeImageDefault
  const extractPdf = options?.extractPdfText ?? extractPdfTextDefault

  const pdfStrategy = imageReadConfig.pdf_strategy ?? "extract_text"
  const hasVisionModel = !!imageReadConfig.model
  const needsImageOverride = hasVisionModel && !activeModel.capabilities.input.image
  const needsPdfOverride = !activeModel.capabilities.input.pdf

  if (!needsImageOverride && !needsPdfOverride) return Effect.succeed(messages)

  return Effect.gen(function* () {
    // Resolve vision model once if configured
    const visionModel: Provider.Model | string | undefined = hasVisionModel
      ? yield* resolveVisionModel(imageReadConfig.model!).pipe(
          Effect.catch((error) => Effect.succeed(String(error))),
        )
      : undefined

    const result: ModelMessage[] = []

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        result.push(msg)
        continue
      }

      // Process user message file/image parts
      if (msg.role === "user") {
        let changed = false
        const newContent: any[] = []
        for (const part of msg.content) {
          if (isFilePart(part)) {
            const mime = part.mediaType
            const kind = mediaKind(mime)
            if (!kind) {
              newContent.push(part)
              continue
            }

            if (kind === "image" && needsImageOverride) {
              const description = yield* handleImageFilePart(part, visionModel, describeImg)
              newContent.push({ type: "text" as const, text: description })
              changed = true
              continue
            }

            if (kind === "pdf" && needsPdfOverride) {
              const description = yield* handlePdfFilePart(part, pdfStrategy, extractPdf)
              newContent.push({ type: "text" as const, text: description })
              changed = true
              continue
            }

            newContent.push(part)
          } else if (isImagePart(part)) {
            const dataUrl = String(part.image)
            const mime = extractMimeFromDataUrl(dataUrl)
            const kind = mime ? mediaKind(mime) : undefined
            if (kind === "image" && needsImageOverride) {
              const description = yield* handleImagePart(part, visionModel, describeImg)
              newContent.push({ type: "text" as const, text: description })
              changed = true
              continue
            }
            newContent.push(part)
          } else {
            newContent.push(part)
          }
        }
        result.push(changed ? { ...msg, content: newContent } : msg)
        continue
      }

      // Process tool and assistant message tool-result media
      if (msg.role === "tool" || msg.role === "assistant") {
        let changed = false
        const newContent: any[] = []
        for (const part of msg.content) {
          if (isToolResultPart(part) && part.output.type === "content") {
            const outputValue = part.output.value
            if (!Array.isArray(outputValue)) {
              newContent.push(part)
              continue
            }

            let valueChanged = false
            const newValue: any[] = []
            for (const item of outputValue) {
              if (isMediaItem(item)) {
                const mime = item.mediaType
                const kind = mediaKind(mime)
                if (!kind) {
                  newValue.push(item)
                  continue
                }

                if (kind === "image" && needsImageOverride) {
                  const filename = (item as any).filename as string | undefined
                  const description = yield* describeImg(
                    { data: item.data, mime, filename },
                    visionModel as Provider.Model,
                  )
                  newValue.push({ type: "text" as const, text: description })
                  valueChanged = true
                  continue
                }

                if (kind === "pdf" && needsPdfOverride) {
                  const dataUrl = `data:${mime};base64,${item.data}`
                  const filename = (item as any).filename as string | undefined
                  const description = yield* handlePdfMediaItem(dataUrl, pdfStrategy, filename, extractPdf)
                  newValue.push({ type: "text" as const, text: description })
                  valueChanged = true
                  continue
                }

                newValue.push(item)
              } else {
                newValue.push(item)
              }
            }
            newContent.push(
              valueChanged
                ? { ...part, output: { ...part.output, value: newValue } }
                : part,
            )
            if (valueChanged) changed = true
          } else {
            newContent.push(part)
          }
        }
        result.push(changed ? { ...msg, content: newContent } : msg)
        continue
      }

      // System or other roles — pass through unchanged
      result.push(msg)
    }

    return result
  })
}

// ---------------------------------------------------------------------------
// Internal helpers for processing specific part types
// ---------------------------------------------------------------------------

function handleImageFilePart(
  part: { filename?: string; data: string; mediaType: string },
  visionModel: Provider.Model | string | undefined,
  describeImg: NonNullable<ImageReadOverrideOptions["describeImage"]>,
): Effect.Effect<string, never, Provider.Service> {
  const rawBase64 = extractBase64FromDataUrl(part.data)

  if (typeof visionModel === "string") {
    return Effect.succeed(visionModel)
  }

  if (!visionModel) {
    return Effect.succeed(
      "ERROR: image_read.model is not configured. Cannot describe images with this model.",
    )
  }

  if (!rawBase64 || rawBase64.length === 0) {
    return Effect.succeed(
      `ERROR: Image ${part.filename ? `"${part.filename}"` : "file"} is empty or corrupted. Please provide a valid image.`,
    )
  }

  return describeImg(
    { data: rawBase64, mime: part.mediaType, filename: part.filename },
    visionModel,
  )
}

function handleImagePart(
  part: { image: string },
  visionModel: Provider.Model | string | undefined,
  describeImg: NonNullable<ImageReadOverrideOptions["describeImage"]>,
): Effect.Effect<string, never, Provider.Service> {
  const dataUrl = String(part.image)
  const rawBase64 = extractBase64FromDataUrl(dataUrl)
  const mime = extractMimeFromDataUrl(dataUrl) ?? "image/png"

  if (typeof visionModel === "string") {
    return Effect.succeed(visionModel)
  }

  if (!visionModel) {
    return Effect.succeed(
      "ERROR: image_read.model is not configured. Cannot describe images with this model.",
    )
  }

  if (!rawBase64 || rawBase64.length === 0) {
    return Effect.succeed("ERROR: Image file is empty or corrupted. Please provide a valid image.")
  }

  return describeImg({ data: rawBase64, mime, filename: undefined }, visionModel)
}

function handlePdfFilePart(
  part: { filename?: string; data: string; mediaType: string },
  pdfStrategy: string,
  extractPdf: NonNullable<ImageReadOverrideOptions["extractPdfText"]>,
): Effect.Effect<string, never> {
  if (pdfStrategy === "error") {
    const name = part.filename ? `"${part.filename}"` : "PDF file"
    return Effect.succeed(`ERROR: Cannot read ${name} \u2014 PDF input is not supported.`)
  }

  return extractPdf({ dataUrl: part.data, filename: part.filename }).pipe(
    Effect.map(
      (text) => `[PDF${part.filename ? ` "${part.filename}"` : ""} text content:\n\n${text}]`.trim(),
    ),
  )
}

function handlePdfMediaItem(
  dataUrl: string,
  pdfStrategy: string,
  filename: string | undefined,
  extractPdf: NonNullable<ImageReadOverrideOptions["extractPdfText"]>,
): Effect.Effect<string, never> {
  if (pdfStrategy === "error") {
    const name = filename ? `"${filename}"` : "PDF file"
    return Effect.succeed(`ERROR: Cannot read ${name} \u2014 PDF input is not supported.`)
  }

  return extractPdf({ dataUrl, filename }).pipe(
    Effect.map(
      (text) => `[PDF${filename ? ` "${filename}"` : ""} text content:\n\n${text}]`.trim(),
    ),
  )
}
