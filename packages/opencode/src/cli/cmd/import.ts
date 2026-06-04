import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Session } from "@/session/session"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { ShareNext } from "@/share/share-next"
import { EOL } from "os"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { DateTime, Effect, Option, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { type PublicTranscriptPayloadV2, TranscriptV2PublicPayload } from "@/session/transcript-v2-public-payload"
import { Slug } from "@opencode-ai/core/util/slug"
import { eq, inArray } from "drizzle-orm"
import { SessionSchema } from "@opencode-ai/core/session/schema"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionLegacy.Info)
const decodePart = Schema.decodeUnknownSync(SessionLegacy.Part)
const encodeSessionMessage = Schema.encodeSync(SessionMessage.Message)
const decodeImportJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }
  | { type: "public_transcript_v2"; payload: PublicTranscriptPayloadV2 }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

export const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const share = yield* ShareNext.Service
  const fs = yield* AppFileSystem.Service
  const { db } = yield* Database.Service

  let exportData: ExportData | undefined

  const isUrl = file.startsWith("http://") || file.startsWith("https://")

  if (isUrl) {
    const slug = parseShareUrl(file)
    if (!slug) {
      const baseUrl = yield* Effect.orDie(share.url())
      process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
      process.stdout.write(EOL)
      return
    }

    const baseUrl = new URL(file).origin
    const req = yield* Effect.orDie(share.request())
    const headers = shouldAttachShareAuthHeaders(file, req.baseUrl) ? req.headers : {}

    const tryFetch = (url: string) =>
      Effect.tryPromise({
        try: () => fetch(url, { headers }),
        catch: (e) =>
          new CliError({
            message: `Failed to fetch share data: ${e instanceof Error ? e.message : String(e)}`,
          }),
      })

    const dataPath = req.api.data(slug)
    let response = yield* tryFetch(`${baseUrl}${dataPath}`)

    if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
      response = yield* tryFetch(`${baseUrl}/api/share/${slug}/data`)
    }

    if (!response.ok) {
      process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
      process.stdout.write(EOL)
      return
    }

    const shareData = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new CliError({ message: "Share data was not valid JSON" }),
    })
    if (!Array.isArray(shareData)) return yield* fail("Share data was not a valid array")
    const v2Item = shareData.find((item) => item.type === "public_transcript_v2")
    if (v2Item) {
      yield* importPublicTranscriptPayload(v2Item.payload, ctx, db)
      return
    }

    const transformed = transformShareData(shareData)

    if (!transformed) {
      process.stdout.write(`Share not found or empty: ${slug}`)
      process.stdout.write(EOL)
      return
    }

    exportData = transformed
  } else {
    const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch((error) => fail(`Failed to read import file: ${String(error)}`)))
    if (text === undefined) {
      process.stdout.write(`File not found: ${file}`)
      process.stdout.write(EOL)
      return
    }
    const decoded = decodeImportJson(text)
    if (Option.isNone(decoded)) return yield* fail(`Import file is not valid JSON: ${file}`)
    const localData = decoded.value
    if (hasV2EnvelopeMarker(localData)) {
      yield* importPublicTranscriptPayload(localData, ctx, db)
      return
    }
    if (!isLegacyExportShape(localData)) return yield* fail("Unsupported import payload shape")
    exportData = localData as NonNullable<typeof exportData>
  }

  if (!exportData) {
    process.stdout.write(`Failed to read session data`)
    process.stdout.write(EOL)
    return
  }

  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  for (const msg of exportData.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionLegacy.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? Date.now(),
        data: msgData as never,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    for (const part of msg.parts) {
      const partInfo = decodePart(part) as SessionLegacy.Part
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({
          id: partId,
          message_id: messageID,
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})

function importPublicTranscriptPayload(value: unknown, ctx: InstanceContext, db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const payload = yield* validatePublicTranscriptPayload(value)
    const messages = yield* convertPublicTranscriptPayload(payload)
    const { session, sessionRow, messageRows } = yield* constructV2ImportRows(payload, ctx, messages)

    yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const existingSession = yield* tx.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, session.id)).limit(1).get()
            if (existingSession) return yield* fail(`Session already exists: ${session.id}`)
            if (messageRows.length > 0) {
              const existingMessages = yield* tx
                .select({ id: SessionMessageTable.id })
                .from(SessionMessageTable)
                .where(inArray(SessionMessageTable.id, messageRows.map((row) => row.id)))
                .all()
              if (existingMessages.length > 0) {
                return yield* fail(`Session message already exists: ${existingMessages[0]!.id}`)
              }
            }
            yield* tx.insert(SessionTable).values(sessionRow).run()
            if (messageRows.length > 0) yield* tx.insert(SessionMessageTable).values(messageRows).run()
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catch((error) => (error instanceof CliError ? Effect.fail(error) : fail(`Failed to import v2 transcript: ${String(error)}`))))

    process.stdout.write(`Imported session: ${payload.session.id}`)
    process.stdout.write(EOL)
  })
}

function hasV2EnvelopeMarker(value: unknown) {
  return isRecord(value) && ("kind" in value || "version" in value)
}

function isLegacyExportShape(value: unknown) {
  return isRecord(value) && isRecord(value.info) && Array.isArray(value.messages)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validatePublicTranscriptPayload(value: unknown) {
  return Effect.try({
    try: () => {
      TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(value)
      return value as PublicTranscriptPayloadV2
    },
    catch: (error) => new CliError({ message: `Invalid v2 transcript import payload: ${error instanceof Error ? error.message : String(error)}` }),
  })
}

function convertPublicTranscriptPayload(payload: PublicTranscriptPayloadV2) {
  return Effect.try({
    try: () => TranscriptV2PublicPayload.publicTranscriptPayloadV2ToCanonicalMessages(payload),
    catch: (error) => new CliError({ message: `Invalid v2 transcript import payload: ${error instanceof Error ? error.message : String(error)}` }),
  })
}

function constructV2ImportRows(payload: PublicTranscriptPayloadV2, ctx: InstanceContext, messages: SessionMessage.Message[]) {
  return Effect.try({
    try: () => {
      const session = importedV2Session(payload, ctx)
      return {
        session,
        sessionRow: Session.toRow(session),
        messageRows: messages.map((message) => sessionMessageRow(session.id, message)),
      }
    },
    catch: (error) => new CliError({ message: `Invalid v2 transcript import payload: ${error instanceof Error ? error.message : String(error)}` }),
  })
}

function importedV2Session(payload: PublicTranscriptPayloadV2, ctx: InstanceContext): Session.Info {
  return Schema.decodeUnknownSync(Session.Info)({
    id: payload.session.id,
    slug: Slug.create(),
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
    title: payload.session.title,
    ...(payload.session.agent ? { agent: payload.session.agent } : {}),
    ...(payload.session.model ? { model: payload.session.model } : {}),
    version: payload.session.version,
    time: payload.session.time,
  }) as Session.Info
}

function sessionMessageRow(sessionID: Session.Info["id"], message: SessionMessage.Message): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeSessionMessage(message)
  const { id, type, ...data } = encoded
  return {
    id: SessionMessage.ID.make(id),
    session_id: SessionSchema.ID.make(sessionID),
    type,
    time_created: DateTime.toEpochMillis(message.time.created),
    data,
  }
}
