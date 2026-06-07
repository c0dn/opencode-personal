import { decode as decodeMsgPack, encode as encodeMsgPack } from "@msgpack/msgpack"

export const MAX_FRAME_SIZE = 4 * 1024 * 1024 // 4 MiB

/** Errors that can occur during protocol encode/decode. */
export type ProtocolError =
  | { _tag: "EncodeError"; message: string; cause: unknown }
  | { _tag: "DecodeError"; message: string; cause: unknown }
  | { _tag: "FrameTooLarge"; size: number; maxSize: number; message: string }

const BROTLI_QUALITY = 4
const BROTLI_THRESHOLD = 64
const MARKER_RAW = 0x00
const MARKER_BROTLI = 0x01

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
 * Encode a JS value to a binary frame ready for WebSocket transmission.
 *
 * Pipeline: object → MessagePack encode → (skip Brotli if < 64 bytes) → marker byte + payload
 * Marker: 0x00 = raw MessagePack, 0x01 = Brotli-compressed
 */
export async function encode(value: unknown): Promise<Uint8Array | ProtocolError> {
  try {
    const packed = encodeMsgPack(value, { sortKeys: false })

    // Tiny frames: skip Brotli (overhead > savings)
    if (packed.length < BROTLI_THRESHOLD) {
      if (packed.length + 1 > MAX_FRAME_SIZE) {
        return {
          _tag: "FrameTooLarge",
          size: packed.length + 1,
          maxSize: MAX_FRAME_SIZE,
          message: `Frame size ${packed.length + 1} exceeds max ${MAX_FRAME_SIZE}`,
        }
      }
      const frame = new Uint8Array(packed.length + 1)
      frame[0] = MARKER_RAW
      frame.set(packed, 1)
      return frame
    }

    const brotli = await getBrotli()
    const compressed = brotli.compress(packed, { quality: BROTLI_QUALITY })
    if (compressed.byteLength + 1 > MAX_FRAME_SIZE) {
      return {
        _tag: "FrameTooLarge",
        size: compressed.byteLength + 1,
        maxSize: MAX_FRAME_SIZE,
        message: `Frame size ${compressed.byteLength + 1} exceeds max ${MAX_FRAME_SIZE}`,
      }
    }
    const frame = new Uint8Array(compressed.length + 1)
    frame[0] = MARKER_BROTLI
    frame.set(compressed, 1)
    return frame
  } catch (cause) {
    return {
      _tag: "EncodeError",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }
  }
}

/**
 * Decode a binary frame from a WebSocket message back to a JS value.
 *
 * Pipeline: marker byte check → (raw skip or Brotli decompress) → MessagePack decode → object
 * Legacy frames without a 0x00/0x01 marker are treated as Brotli-compressed.
 */
export async function decode(bytes: Uint8Array): Promise<unknown | ProtocolError> {
  try {
    if (bytes.byteLength > MAX_FRAME_SIZE) {
      return {
        _tag: "FrameTooLarge",
        size: bytes.byteLength,
        maxSize: MAX_FRAME_SIZE,
        message: `Frame size ${bytes.byteLength} exceeds max ${MAX_FRAME_SIZE}`,
      }
    }

    const marker = bytes[0]
    if (marker === MARKER_RAW) {
      const payload = bytes.slice(1)
      return decodeMsgPack(payload)
    }
    // MARKER_BROTLI or legacy (no marker): decompress as Brotli
    const compressed = marker === MARKER_BROTLI ? bytes.slice(1) : bytes
    const brotli = await getBrotli()
    const decompressed = brotli.decompress(compressed)
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
