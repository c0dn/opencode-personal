import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { Server as HttpServer } from "node:http"
import { Server as SocketIOServer } from "socket.io"
import { io as ioc, type Socket as ClientSocket } from "socket.io-client"
import msgpackParser from "socket.io-msgpack-parser"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

const BATCH_MS = 16

/**
 * Helper: create a Socket.IO server listening on an http.Server.
 * Returns a cleanup function.
 */
function createServerPair(): Promise<{
  server: HttpServer
  io: SocketIOServer
  port: number
  cleanup: () => Promise<void>
  waitForClient: (client: ClientSocket) => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer()
    const io = new SocketIOServer(httpServer, {
      parser: msgpackParser,
    })

    // Use port 0 to get a random free port
    httpServer.listen(0, () => {
      const addr = httpServer.address()
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"))
        return
      }
      const port = addr.port
      resolve({
        server: httpServer,
        io,
        port,
        cleanup: async () => {
          io.close()
          await new Promise<void>((res) => httpServer.close(() => res()))
        },
        waitForClient: (client: ClientSocket) =>
          new Promise<void>((res) => {
            if (client.connected) {
              res()
              return
            }
            client.once("connect", () => res())
          }),
      })
    })
  })
}

/** Helper: build a GlobalEvent with a sessionID property. */
function sessionEvent(sessionID: string): GlobalEvent {
  return {
    directory: "/test",
    payload: {
      id: "evt-test-" + sessionID,
      type: "session.updated",
      properties: { sessionID },
    },
  }
}

/** Helper: build a GlobalEvent without a sessionID (global event). */
function globalEvent(type: string = "workspace.updated"): GlobalEvent {
  return {
    directory: "/test",
    payload: {
      id: "evt-global-" + type,
      type,
      properties: {},
    },
  }
}

/** Helper: sleep for a given ms. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Clean up any lingering GlobalBus listeners between test groups.
afterEach(() => {
  GlobalBus.removeAllListeners("event")
})

describe("Socket.IO event bridge", () => {
  let srv: HttpServer
  let sio: SocketIOServer
  let port: number
  let cleanupSrv: () => Promise<void>
  let waitForClient: (client: ClientSocket) => Promise<void>

  // Start a fresh server for each describe group
  beforeAll(async () => {
    const pair = await createServerPair()
    srv = pair.server
    sio = pair.io
    port = pair.port
    cleanupSrv = pair.cleanup
    waitForClient = pair.waitForClient
    return async () => {
      await cleanupSrv()
    }
  })

  /**
   * Simulates the event bridge logic for a socket (same as in transport.ts).
   * Attaches to a Socket.IO socket: sets up GlobalBus listener with
   * 16ms batching, subscription filtering, and disconnect cleanup.
   */
  function attachBridge(socket: ClientSocket | any, subscribed = new Set<string>()) {
    let pending: GlobalEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    function isSubscribed(event: GlobalEvent): boolean {
      if (subscribed.size === 0) return true
      const props = event.payload?.properties as Record<string, unknown> | undefined
      const sessionID = props?.sessionID as string | undefined
      if (sessionID === undefined) return true
      return subscribed.has(sessionID)
    }

    function flush() {
      const batch = pending
      pending = []
      flushTimer = undefined
      if (batch.length === 0) return

      if (batch.length === 1) {
        const event = batch[0]
        socket.emit("push.event", {
          directory: event.directory,
          payload: event.payload,
        })
        return
      }

      socket.emit("push.batch", { events: batch })
    }

    const listener = (event: GlobalEvent) => {
      if (!isSubscribed(event)) return
      pending.push(event)
      if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS)
    }

    GlobalBus.on("event", listener)

    // Note: in the real transport.ts, this is on("disconnect")
    const off = () => {
      GlobalBus.off("event", listener)
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = undefined
      pending = []
    }

    socket.once("disconnect", off)

    return subscribed
  }

  describe("subscription filtering", () => {
    test("empty subscribed set — all session events are forwarded", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      // Attach bridge using server-side socket
      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      attachBridge(srvSocket)

      // Emit a session event
      GlobalBus.emit("event", sessionEvent("session-a"))
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBeGreaterThan(0)
      const frame = frames[0]
      expect(frame.type).toBe("push.event")
      expect(frame.payload.properties.sessionID).toBe("session-a")

      client.close()
    })

    test("empty subscribed set — global events are forwarded", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      attachBridge(srvSocket)

      GlobalBus.emit("event", globalEvent())
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBe(1)
      expect(frames[0].type).toBe("push.event")
      expect(frames[0].payload.type).toBe("workspace.updated")

      client.close()
    })

    test("non-empty subscribed set — matching session event is forwarded", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      const subscribed = new Set<string>()
      subscribed.add("session-a")
      subscribed.add("session-b")
      attachBridge(srvSocket, subscribed)

      GlobalBus.emit("event", sessionEvent("session-a"))
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBe(1)
      expect(frames[0].type).toBe("push.event")
      expect(frames[0].payload.properties.sessionID).toBe("session-a")

      client.close()
    })

    test("non-empty subscribed set — global/no-session event is always forwarded", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      const subscribed = new Set<string>()
      subscribed.add("session-a")
      attachBridge(srvSocket, subscribed)

      GlobalBus.emit("event", globalEvent("tool.installed"))
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBe(1)
      expect(frames[0].type).toBe("push.event")
      expect(frames[0].payload.type).toBe("tool.installed")

      client.close()
    })

    test("non-matching session event is filtered out", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      const subscribed = new Set<string>()
      subscribed.add("session-a")
      subscribed.add("session-b")
      attachBridge(srvSocket, subscribed)

      // Emit an event for a session the connection is NOT subscribed to
      GlobalBus.emit("event", sessionEvent("session-c"))
      await sleep(BATCH_MS + 10)

      // Should not have been forwarded
      expect(frames.length).toBe(0)

      client.close()
    })

    test("mixed events — only matching and global are forwarded", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      const subscribed = new Set<string>()
      subscribed.add("session-a")
      attachBridge(srvSocket, subscribed)

      GlobalBus.emit("event", sessionEvent("session-a")) // matching
      GlobalBus.emit("event", sessionEvent("session-b")) // non-matching
      GlobalBus.emit("event", globalEvent("some.global")) // global, always
      await sleep(BATCH_MS + 10)

      // Should have pushed a batch with exactly 2 events
      expect(frames.length).toBe(1)
      const batch = frames[0]
      expect(batch.type).toBe("push.batch")
      const events = batch.events as GlobalEvent[]
      expect(events.length).toBe(2)

      // Verify the two forwarded events are the matching and global ones
      const types = events.map((e) => (e.payload.properties as Record<string, unknown>).sessionID ?? "global")
      expect(types).toContain("session-a")
      expect(types).toContain("global")

      client.close()
    })
  })

  describe("batching", () => {
    test("multiple events in one 16ms window → single push.batch", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      attachBridge(srvSocket)

      // Emit several events synchronously before the setTimeout fires
      GlobalBus.emit("event", sessionEvent("session-a"))
      GlobalBus.emit("event", sessionEvent("session-b"))
      GlobalBus.emit("event", globalEvent("config.changed"))
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBe(1)
      const batch = frames[0]
      expect(batch.type).toBe("push.batch")
      expect(batch.events).toBeArray()
      expect((batch.events as any[]).length).toBe(3)

      client.close()
    })

    test("single event after a flush → push.event", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      attachBridge(srvSocket)

      // First batch: emit and wait
      GlobalBus.emit("event", sessionEvent("session-a"))
      await sleep(BATCH_MS + 10)

      // Second batch: single event after flush
      GlobalBus.emit("event", sessionEvent("session-b"))
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBe(2)
      expect(frames[0].type).toBe("push.event")
      expect(frames[1].type).toBe("push.event")
      expect(frames[0].payload.properties.sessionID).toBe("session-a")
      expect(frames[1].payload.properties.sessionID).toBe("session-b")

      client.close()
    })

    test("events within the same tick are batched together", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      attachBridge(srvSocket)

      // Emit many events synchronously
      for (let i = 0; i < 5; i++) {
        GlobalBus.emit("event", sessionEvent("session-" + i))
      }
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBe(1)
      expect(frames[0].type).toBe("push.batch")
      expect((frames[0].events as any[]).length).toBe(5)

      client.close()
    })
  })

  describe("cleanup", () => {
    test("disconnect removes the GlobalBus listener", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      attachBridge(srvSocket)

      // Verify listener is active
      GlobalBus.emit("event", sessionEvent("session-a"))
      await sleep(BATCH_MS + 10)
      expect(frames.length).toBe(1)

      // Disconnect (removes listener via on("disconnect"))
      client.close()
      await sleep(BATCH_MS + 10)

      // After disconnect, emit another event — should not be forwarded
      const framesBefore = frames.length
      GlobalBus.emit("event", sessionEvent("session-b"))
      await sleep(BATCH_MS + 10)

      expect(frames.length).toBe(framesBefore)
    })

    test("disconnect cancels pending flush timer", async () => {
      const client = ioc(`http://localhost:${port}`, { parser: msgpackParser, transports: ["websocket"] })
      await waitForClient(client)

      const frames: any[] = []
      client.on("push.event", (data: any) => frames.push({ type: "push.event", ...data }))
      client.on("push.batch", (data: any) => frames.push({ type: "push.batch", ...data }))

      const serverSockets = await sio.fetchSockets()
      const srvSocket = serverSockets[0]
      attachBridge(srvSocket)

      // Emit an event to start the 16ms timer, but disconnect before it fires
      GlobalBus.emit("event", sessionEvent("session-a"))

      // Disconnect immediately — should cancel the pending timer
      client.close()
      await sleep(10)

      // Wait past the 16ms window
      await sleep(30)

      // The event should not have been flushed because the timer was canceled
      expect(frames.length).toBe(0)
    })
  })
})
