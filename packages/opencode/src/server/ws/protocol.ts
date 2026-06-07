import { decode as decodeMsgPack, encode as encodeMsgPack } from "@msgpack/msgpack"

export const MAX_FRAME_SIZE = 4 * 1024 * 1024 // 4 MiB

/** Errors that can occur during protocol encode/decode. */
export type ProtocolError =
  | { _tag: "EncodeError"; message: string; cause: unknown }
  | { _tag: "DecodeError"; message: string; cause: unknown }
  | { _tag: "FrameTooLarge"; size: number; maxSize: number; message: string }

const BROTLI_QUALITY = 4

let brotliInstance: {
  compress(buf: Uint8Array, opts?: { quality?: number }): Uint8Array
  decompress(buf: Uint8Array): Uint8Array
} | undefined

async function getBrotli() {
  if (!brotliInstance) {
    const mod = await import("brotli-wasm")
    brotliInstance = await mod.default
  }
  return brotliInstance
}

/**
 * Encode a JS value to a compressed binary frame ready for WebSocket transmission.
 *
 * Pipeline: object → MessagePack encode → Brotli compress → Uint8Array
 */
export async function encode(value: unknown): Promise<Uint8Array | ProtocolError> {
  try {
    const brotli = await getBrotli()
    const packed = encodeMsgPack(value, { sortKeys: false })
    const compressed = brotli.compress(packed, { quality: BROTLI_QUALITY })
    if (compressed.byteLength > MAX_FRAME_SIZE) {
      return {
        _tag: "FrameTooLarge",
        size: compressed.byteLength,
        maxSize: MAX_FRAME_SIZE,
        message: `Frame size ${compressed.byteLength} exceeds max ${MAX_FRAME_SIZE}`,
      }
    }
    return compressed
  } catch (cause) {
    return {
      _tag: "EncodeError",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }
  }
}

/**
 * Decode a compressed binary frame from a WebSocket message back to a JS value.
 *
 * Pipeline: Uint8Array → Brotli decompress → MessagePack decode → object
 */
export async function decode(bytes: Uint8Array): Promise<unknown | ProtocolError> {
  try {
    const brotli = await getBrotli()
    if (bytes.byteLength > MAX_FRAME_SIZE) {
      return {
        _tag: "FrameTooLarge",
        size: bytes.byteLength,
        maxSize: MAX_FRAME_SIZE,
        message: `Frame size ${bytes.byteLength} exceeds max ${MAX_FRAME_SIZE}`,
      }
    }
    const decompressed = brotli.decompress(bytes)
    if (decompressed.byteLength > MAX_FRAME_SIZE * 4) {
      return {
        _tag: "FrameTooLarge",
        size: decompressed.byteLength,
        maxSize: MAX_FRAME_SIZE * 4,
        message: `Decompressed size ${decompressed.byteLength} exceeds max ${MAX_FRAME_SIZE * 4}`,
      }
    }
    return decodeMsgPack(decompressed)
  } catch (cause) {
    return {
      _tag: "DecodeError",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }
  }
}

/**
 * Check if a value is a ProtocolError.
 */
export function isProtocolError(value: unknown): value is ProtocolError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    ((value as ProtocolError)._tag === "EncodeError" ||
      (value as ProtocolError)._tag === "DecodeError" ||
      (value as ProtocolError)._tag === "FrameTooLarge")
  )
}

/**
 * Like encode() but throws on error. Use when the caller handles errors at a higher level.
 */
export async function encodeOrThrow(value: unknown): Promise<Uint8Array> {
  const result = await encode(value)
  if (isProtocolError(result)) {
    throw new Error(`Protocol encode failed: ${result._tag} - ${result.message}`)
  }
  return result
}

/**
 * Like decode() but throws on error. Use when the caller handles errors at a higher level.
 */
export async function decodeOrThrow(bytes: Uint8Array): Promise<unknown> {
  const result = await decode(bytes)
  if (isProtocolError(result)) {
    throw new Error(`Protocol decode failed: ${result._tag} - ${result.message}`)
  }
  return result
}
