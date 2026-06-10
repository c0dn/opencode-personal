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
    inputs: DescribeImageInput[],
    visionModel: Provider.Model,
  ) => Effect.Effect<string[], never, Provider.Service>
  extractPdfText?: (input: { dataUrl: string; filename?: string }) => Effect.Effect<string, never>
}

const SYSTEM_PROMPT =
  "You are an image description tool. Describe each image in detail, focusing on text content, " +
  "visual elements, layout, diagrams, code, screenshots, and any details relevant to a software " +
  "development context. Be thorough but concise. " +
  "Preface each description with the image label exactly as given (e.g. \"[Image 1 of 3]:\")."

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
// Default describe image implementation (batched, cancellable)
// ---------------------------------------------------------------------------

function describeImageDefault(
  inputs: DescribeImageInput[],
  visionModel: Provider.Model,
): Effect.Effect<string[], never, Provider.Service> {
  if (inputs.length === 0) return Effect.succeed([])

  return Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(visionModel)
    const controller = new AbortController()

    const result = yield* Effect.tryPromise(() =>
      generateBatchedImageDescriptions(language, inputs, controller.signal),
    ).pipe(
      Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
      Effect.onError(() => Effect.sync(() => controller.abort())),
      Effect.timeout("30 seconds"),
    )

    const descriptions = result
      .map((desc, i) => {
        const fileLabel = inputs[i].filename ? `"${inputs[i].filename}"` : `image ${i + 1}`
        return `[Image ${fileLabel} described by ${visionModel.name}:\n${desc}]`.trim()
      })

    // Wrap in a batch marker so the caller can parse individual descriptions
    return descriptions
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        inputs.map((inp) =>
          `ERROR: Failed to describe image${inp.filename ? ` "${inp.filename}"` : ""} with ${visionModel.name}: ${errorMessage(error)}`,
        ),
      ),
    ),
  )
}

async function generateBatchedImageDescriptions(
  language: any,
  inputs: DescribeImageInput[],
  abortSignal?: AbortSignal,
): Promise<string[]> {
  const { generateText } = await import("ai")

  if (inputs.length === 1) {
    const input = inputs[0]
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
      abortSignal,
    })
    return [resp.text]
  }

  // Multiple images: send all in one message, ask for labeled descriptions
  const content: any[] = [
    {
      type: "text" as const,
      text: `Describe each of the following ${inputs.length} images. Label each description with the image number (e.g. "[Image 1 of ${inputs.length}]:").`,
    },
  ]
  for (let i = 0; i < inputs.length; i++) {
    content.push({
      type: "image" as const,
      image: `data:${inputs[i].mime};base64,${inputs[i].data}`,
      mimeType: inputs[i].mime,
    } as any)
  }
  const resp = await generateText({
    model: language,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content }],
    abortSignal,
  })

  return splitDescriptions(resp.text, inputs.length)
}

/**
 * Split a combined description response into per-image descriptions.
 * Tries to parse labeled sections like "[Image 1 of N]:" or "[Image 1]:".
 * Falls back to returning the full text as a single description if parsing fails.
 */
function splitDescriptions(text: string, count: number): string[] {
  if (count <= 1) return [text]

  // Try to split by labeled headers
  const labeled = new RegExp(`\\[Image \\d+(?: of ${count})?\\]`, "gi")
  const splits = text.split(labeled)
  // splits[0] is preamble (before first label), rest are descriptions between labels
  const descriptions: string[] = []
  let preamble = splits[0]?.trim()
  if (preamble) descriptions.push(preamble)

  for (let i = 1; i < splits.length; i += 1) {
    const desc = splits[i]
    if (desc === undefined) continue
    const trimmed = desc.trim().replace(/^:\s*/, "")
    if (trimmed) descriptions.push(trimmed)
  }

  // If we got roughly the right number, use parsed result
  if (descriptions.length === count) return descriptions

  // If we got more than expected, take the first `count` and merge the rest
  if (descriptions.length > count) {
    const extra = descriptions.slice(count).join("\n\n")
    const result = descriptions.slice(0, count)
    result[result.length - 1] = (result[result.length - 1] + "\n\n" + extra).trim()
    return result
  }

  // Fallback: return full text as one description, pad the rest
  const result: string[] = [text]
  for (let i = 1; i < count; i++) {
    result.push("")
  }
  return result
}

// ---------------------------------------------------------------------------
// Default PDF text extraction implementation (unchanged)
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
// Resolve vision model from config (unchanged)
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
// Image input collection — gathers all image DescribeImageInput objects
// from a message part, for later batch processing.
// ---------------------------------------------------------------------------

interface ImageCandidate {
  position: number // original index in the content array
  input: DescribeImageInput
}

function collectImageCandidates(
  content: unknown[],
  needsImageOverride: boolean,
): ImageCandidate[] {
  const candidates: ImageCandidate[] = []
  for (let i = 0; i < content.length; i++) {
    const part = content[i]
    if (isFilePart(part)) {
      const mime = part.mediaType
      if (mediaKind(mime) !== "image" || !needsImageOverride) continue
      const rawBase64 = extractBase64FromDataUrl(part.data)
      if (rawBase64?.length) {
        candidates.push({ position: i, input: { data: rawBase64, mime, filename: part.filename } })
      }
    } else if (isImagePart(part)) {
      if (!needsImageOverride) continue
      const dataUrl = String(part.image)
      const mime = extractMimeFromDataUrl(dataUrl)
      if (mediaKind(mime ?? "") !== "image") continue
      const rawBase64 = extractBase64FromDataUrl(dataUrl)
      if (rawBase64?.length) {
        candidates.push({ position: i, input: { data: rawBase64, mime: mime ?? "image/png" } })
      }
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Main override function (batched)
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
        const candidates = collectImageCandidates(msg.content, needsImageOverride)
        let changed = false
        const descriptions: (string | null)[] = Array(msg.content.length).fill(null)

        // Batch describe all images at once
        if (candidates.length > 0 && typeof visionModel !== "string") {
          const resolved = visionModel
          if (resolved) {
            const batchDescriptions = yield* describeImg(
              candidates.map((c) => c.input),
              resolved,
            )
            for (let i = 0; i < candidates.length; i++) {
              descriptions[candidates[i].position] = batchDescriptions[i]
            }
            changed = true
          } else {
            // visionModel is undefined — no vision model configured
            for (const c of candidates) {
              descriptions[c.position] =
                "ERROR: image_read.model is not configured. Cannot describe images with this model."
            }
            changed = true
          }
        } else if (candidates.length > 0) {
          // visionModel is an error string
          for (const c of candidates) {
            descriptions[c.position] = visionModel as string
          }
          changed = true
        }

        // Build new content array, replacing image parts with descriptions
        const newContent: any[] = []
        for (let i = 0; i < msg.content.length; i++) {
          const part = msg.content[i]
          if (descriptions[i] !== null) {
            newContent.push({ type: "text" as const, text: descriptions[i]! })
            continue
          }
          // Handle image file parts that need override but lack valid base64
          // (HTTP URLs, empty data). These weren't collected for batching.
          if (isFilePart(part) && needsImageOverride && mediaKind(part.mediaType) === "image") {
            newContent.push({
              type: "text" as const,
              text: `ERROR: Image ${part.filename ? `"${part.filename}"` : "file"} is empty or corrupted. Please provide a valid image.`,
            })
            changed = true
            continue
          }
          // Handle image-type parts with invalid/empty data URLs
          if (isImagePart(part) && needsImageOverride) {
            newContent.push({
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            })
            changed = true
            continue
          }
          if (isFilePart(part) && needsPdfOverride && mediaKind(part.mediaType) === "pdf") {
            const description = yield* handlePdfFilePart(part, pdfStrategy, extractPdf)
            newContent.push({ type: "text" as const, text: description })
            changed = true
            continue
          }
          // Pass-through non-image file parts, non-file parts, etc.
          newContent.push(part)
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

            // Collect media items that need image override
            const mediaCandidates: { index: number; input: DescribeImageInput }[] = []
            const pdfCandidates: { index: number; dataUrl: string; filename?: string }[] = []

            for (let i = 0; i < outputValue.length; i++) {
              const item = outputValue[i]
              if (isMediaItem(item)) {
                const mime = item.mediaType
                const kind = mediaKind(mime)
                if (kind === "image" && needsImageOverride) {
                  const filename = (item as any).filename as string | undefined
                  mediaCandidates.push({ index: i, input: { data: item.data, mime, filename } })
                } else if (kind === "pdf" && needsPdfOverride) {
                  const dataUrl = `data:${mime};base64,${item.data}`
                  const filename = (item as any).filename as string | undefined
                  pdfCandidates.push({ index: i, dataUrl, filename })
                }
              }
            }

            if (mediaCandidates.length === 0 && pdfCandidates.length === 0) {
              newContent.push(part)
              continue
            }

            // Batch describe tool-result images
            let partChanged = false
            const newValue: any[] = [...outputValue]
            if (mediaCandidates.length > 0 && typeof visionModel !== "string" && visionModel) {
              const batchDescriptions = yield* describeImg(
                mediaCandidates.map((c) => c.input),
                visionModel,
              )
              for (let i = 0; i < mediaCandidates.length; i++) {
                newValue[mediaCandidates[i].index] = { type: "text" as const, text: batchDescriptions[i] }
              }
              partChanged = true
            } else if (mediaCandidates.length > 0) {
              const errMsg = typeof visionModel === "string"
                ? visionModel
                : "ERROR: image_read.model is not configured. Cannot describe images with this model."
              for (const mc of mediaCandidates) {
                newValue[mc.index] = { type: "text" as const, text: errMsg }
              }
              partChanged = true
            }

            // Process PDFs in tool results (individual calls, not batched since
            // they use pdfjs-dist in-process extraction)
            for (const pc of pdfCandidates) {
              const description = yield* handlePdfMediaItem(pc.dataUrl, pdfStrategy, pc.filename, extractPdf)
              newValue[pc.index] = { type: "text" as const, text: description }
              partChanged = true
            }

            newContent.push(
              partChanged
                ? { ...part, output: { ...part.output, value: newValue } }
                : part,
            )
            changed = changed || partChanged
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
// Internal helpers for PDF processing (image processing moved to batch)
// ---------------------------------------------------------------------------

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
