import { cmd } from "../cmd"
import { UI } from "@/cli/ui"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { errorMessage } from "@/util/error"
import { validateSession } from "./validate-session"
import { ServerAuth } from "@/server/auth"
import { resolveNetworkOptionsNoConfig } from "@/cli/network"

// ── URL resolution ───────────────────────────────────────────────────

function resolveAttachUrl(args: { url?: string; port?: number; hostname?: string }): string {
  if (args.url) return args.url

  const network = resolveNetworkOptionsNoConfig({
    port: args.port ?? 0,
    hostname: args.hostname ?? "127.0.0.1",
    mdns: false,
    "mdns-domain": "opencode.local",
    cors: [],
  })

  const port = network.port === 0 ? 4096 : network.port
  return `http://${network.hostname}:${port}`
}

// ── Connection probe ─────────────────────────────────────────────────

async function probeAttach(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`${url}/session`, {
      signal: AbortSignal.timeout(2000),
      headers,
    })
    if (res.ok || res.status === 401) return { ok: true }
    if (res.status === 403) return { ok: false, reason: "Server rejected authentication." }
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed"))
      return { ok: false, reason: `No opencode server listening at ${url}` }
    if (msg.includes("ETIMEDOUT") || msg.includes("timeout"))
      return { ok: false, reason: `Connection to ${url} timed out` }
    return { ok: false, reason: `Could not connect to ${url}: ${msg}` }
  }
}

// ── Command ──────────────────────────────────────────────────────────

export const AttachCommand = cmd({
  command: "attach [url]",
  aliases: ["connect"],
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "server URL (default: auto-resolved via config / 127.0.0.1:4096)",
      })
      .option("hostname", {
        type: "string",
        describe: "server hostname (default: 127.0.0.1, respects global config)",
      })
      .option("port", {
        type: "number",
        describe: "server port (default: 4096, respects global config)",
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      }),
  handler: async (args) => {
    const { TuiConfig } = await import("@/cli/cmd/tui/config/tui")
    const unguard = win32InstallCtrlCGuard()
    try {
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      const url = resolveAttachUrl(args)

      // When URL is auto-resolved, probe the server before launching TUI
      if (!args.url) {
        const probeHeaders = ServerAuth.headers({ password: args.password, username: args.username }) ?? {}
        const probe = await probeAttach(url, probeHeaders)
        if (!probe.ok) {
          UI.error(probe.reason)
          UI.error(`Is \`opencode serve\` running? Use --port to specify a different port.`)
          process.exitCode = 1
          return
        }
      }

      const directory = (() => {
        if (!args.dir) return undefined
        try {
          process.chdir(args.dir)
          return process.cwd()
        } catch {
          // If the directory doesn't exist locally (remote attach), pass it through.
          return args.dir
        }
      })()
      const headers = ServerAuth.headers({ password: args.password, username: args.username })
      const config = await TuiConfig.get()

      try {
        await validateSession({
          url,
          sessionID: args.session,
          directory,
          headers,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      const { createTuiRenderer, tui } = await import("./app")
      const renderer = await createTuiRenderer(config)
      const handle = tui({
        url,
        config,
        renderer,
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
        },
        directory,
        headers,
      })
      await handle.done
    } finally {
      unguard?.()
    }
  },
})
