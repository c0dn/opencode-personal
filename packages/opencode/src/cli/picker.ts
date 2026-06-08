/**
 * Interactive fuzzy picker for the CLI.
 *
 * TTY mode: raw terminal, live filtering, arrow-key navigation.
 * Non-TTY mode: numbered list prompt on stderr.
 *
 * No external dependencies — uses Node built-ins only.
 */

import { createInterface } from "readline"
import { fuzzyFilter } from "./fuzzy"

export interface PickOption {
  id: string
  title: string
  subtitle?: string
  detail?: string
}

export class PickerCancelledError extends Error {
  constructor() {
    super("cancelled")
  }
}

const MAX_PRINTED = 20

export async function pick(options: PickOption[], query?: string): Promise<PickOption> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return pickNonTty(options, query)
  }
  return pickTty(options, query)
}

/** Multi-select picker. Returns selected items (empty array = cancelled). */
export async function pickMulti(options: PickOption[], query?: string): Promise<PickOption[]> {
  if (options.length === 0) throw new PickerCancelledError()
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return pickMultiNonTty(options, query)
  }
  return pickMultiTty(options, query)
}

// ── TTY (raw-mode) picker ────────────────────────────────────────────

function pickTty(options: PickOption[], initialQuery?: string): Promise<PickOption> {
  return new Promise((resolve, reject) => {
    if (options.length === 0) {
      reject(new PickerCancelledError())
      return
    }

    const wasRaw = process.stdin.isRaw
    const listeners: Array<{ stream: NodeJS.EventEmitter; event: string; handler: (...args: any[]) => void }> = []
    let resolved = false

    const addListener = (stream: NodeJS.EventEmitter, event: string, handler: (...args: any[]) => void) => {
      stream.on(event, handler)
      listeners.push({ stream, event, handler })
    }

    const cleanup = () => {
      process.stdin.setRawMode(wasRaw ?? false)
      process.stdin.pause()
      for (const entry of listeners) {
        entry.stream.removeListener(entry.event, entry.handler)
      }
      process.stdout.write("\x1b[?25h") // show cursor
      process.stdout.write("\x1b[0m") // reset attributes
    }

    const cancel = () => {
      if (resolved) return
      resolved = true
      cleanup()
      // Clear the picker output area
      clearLines(visibleLines)
      reject(new PickerCancelledError())
    }

    // State
    let query = initialQuery ?? ""
    let cursorIndex = 0
    let scrollOffset = 0
    let visibleLines = 0

    const applyFilter = (q: string, opts: PickOption[]): PickOption[] => {
      if (q.trim().length === 0) return opts.slice()
      return fuzzyFilter(q, opts)
    }

    let filtered = applyFilter(query, options)

    const redraw = () => {
      const termHeight = process.stdout.rows ?? 24
      const termWidth = process.stdout.columns ?? 80
      const maxVisible = Math.max(1, termHeight - 2) // header + footer

      // Clamp cursor
      if (filtered.length === 0) cursorIndex = 0
      else if (cursorIndex >= filtered.length) cursorIndex = filtered.length - 1
      else if (cursorIndex < 0) cursorIndex = 0

      // Scroll
      if (cursorIndex < scrollOffset) scrollOffset = cursorIndex
      else if (cursorIndex >= scrollOffset + maxVisible) scrollOffset = cursorIndex - maxVisible + 1

      const end = Math.min(scrollOffset + maxVisible, filtered.length)

      // Clear previous output
      clearLines(visibleLines)
      visibleLines = 0

      // Header
      const header = filtered.length === 0
        ? formatNoMatchesHeader(query, termWidth)
        : `\x1b[1mSelect a session to resume\x1b[0m  \x1b[2m(type to filter, \u2191\u2193 to move, Enter to select, Esc to cancel)\x1b[0m`
      process.stdout.write(header + "\n")
      visibleLines++

      // Options
      for (let i = scrollOffset; i < end; i++) {
        const opt = filtered[i]
        if (!opt) continue
        const line = formatLine(opt, termWidth, i === cursorIndex ? ">" : " ")
        process.stdout.write(line + "\n")
        visibleLines++
      }

      // Footer / query line
      const prompt = query.length > 0
        ? `\x1b[2m>\x1b[0m ${query}\x1b[5m \x1b[0m`
        : `\x1b[2m>\x1b[0m \x1b[2mtype to search...\x1b[0m`
      process.stdout.write(prompt + "\n")
      visibleLines++
    }

    // Keypress handler
    addListener(process.stdin, "data", (buf: Buffer) => {
      if (resolved) return

      const str = buf.toString()

      // Escape sequences
      if (str === "\x1b") {
        cancel()
        return
      }

      // Ctrl+C
      if (str === "\x03") {
        cancel()
        return
      }

      // Arrow up: \x1b[A
      if (str === "\x1b[A") {
        if (cursorIndex > 0) cursorIndex--
        redraw()
        return
      }

      // Arrow down: \x1b[B
      if (str === "\x1b[B") {
        if (cursorIndex < filtered.length - 1) cursorIndex++
        redraw()
        return
      }

      // Enter / Return
      if (str === "\r" || str === "\n") {
        if (filtered.length === 0) return
        resolved = true
        cleanup()
        clearLines(visibleLines)
        resolve(filtered[cursorIndex]!)
        return
      }

      // Backspace / Ctrl+H
      if (str === "\x7f" || str === "\b" || str === "\x08") {
        if (query.length > 0) {
          // Remove last character (handle multi-byte)
          query = [...query].slice(0, -1).join("")
          filtered = applyFilter(query, options)
          cursorIndex = 0
          scrollOffset = 0
          redraw()
        }
        return
      }

      // Printable characters only
      if (str.length === 1 && str.charCodeAt(0) >= 32 && str.charCodeAt(0) < 127) {
        query += str
        filtered = applyFilter(query, options)
        cursorIndex = 0
        scrollOffset = 0
        redraw()
        return
      }
    })

    // Resize handler
    addListener(process.stdout, "resize", () => {
      if (resolved) return
      redraw()
    })

    // SIGINT while in raw mode
    const sigintHandler = () => {
      cancel()
      process.exit(130)
    }
    addListener(process, "SIGINT", sigintHandler)

    // Enter raw mode
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.write("\x1b[?25l") // hide cursor

    // Initial render
    redraw()
  })
}

// ── Non-TTY picker ───────────────────────────────────────────────────

async function pickNonTty(options: PickOption[], initialQuery?: string): Promise<PickOption> {
  if (options.length === 0) {
    throw new PickerCancelledError()
  }

  let query = initialQuery ?? ""
  let filtered = query.length > 0 ? fuzzyFilter(query, options) : options.slice()

  const rl = createInterface({ input: process.stdin, output: process.stderr })

  const prompt = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("Enter number, refine search, or Ctrl+C to cancel: ", (answer) => {
        resolve(answer.trim())
      })
    })

  const printList = (items: PickOption[]) => {
    const toPrint = items.slice(0, MAX_PRINTED)
    process.stderr.write("\n")
    for (let i = 0; i < toPrint.length; i++) {
      const opt = toPrint[i]
      if (!opt) continue
      const title = opt.title
      const subtitle = opt.subtitle ?? ""
      process.stderr.write(`  ${(i + 1).toString().padStart(2)}. ${title}`)
      if (subtitle) process.stderr.write(`  \x1b[2m${subtitle}\x1b[0m`)
      process.stderr.write("\n")
    }
    if (items.length > MAX_PRINTED) {
      process.stderr.write(`  \x1b[2m... and ${items.length - MAX_PRINTED} more\x1b[0m\n`)
    }
    process.stderr.write("\n")
  }

  while (true) {
    if (filtered.length === 0) {
      process.stderr.write(`\nNo sessions match "${query}". Showing all sessions again.\n`)
      if (query.length > 0) {
        const suggestions = fuzzyFilter(query, options).slice(0, 5)
        if (suggestions.length > 0) {
          process.stderr.write("\nSuggestions:\n")
          printList(suggestions)
        }
      }
      query = ""
      filtered = options.slice()
    }

    printList(filtered)
    const answer = await prompt()

    if (answer === "") {
      rl.close()
      if (filtered.length > 0) return filtered[0]!
      throw new PickerCancelledError()
    }

    const num = parseInt(answer, 10)
    if (!isNaN(num) && num >= 1 && num <= filtered.length) {
      rl.close()
      return filtered[num - 1]!
    }

    if (!isNaN(num)) {
      process.stderr.write(`  Invalid selection: ${num}\n`)
      continue
    }

    // Treat as new search query
    query = answer
    filtered = query.length > 0 ? fuzzyFilter(query, options) : options.slice()
  }
}

// ── Multi-select TTY picker ──────────────────────────────────────────

interface MultiPickOption extends PickOption {
  selected: boolean
}

function pickMultiTty(options: PickOption[], initialQuery?: string): Promise<PickOption[]> {
  return new Promise((resolve, reject) => {
    const items: MultiPickOption[] = options.map((o) => ({ ...o, selected: false }))

    const wasRaw = process.stdin.isRaw
    const listeners: Array<{ stream: NodeJS.EventEmitter; event: string; handler: (...args: any[]) => void }> = []
    let resolved = false

    const addListener = (stream: NodeJS.EventEmitter, event: string, handler: (...args: any[]) => void) => {
      stream.on(event, handler)
      listeners.push({ stream, event, handler })
    }

    const cleanup = () => {
      process.stdin.setRawMode(wasRaw ?? false)
      process.stdin.pause()
      for (const entry of listeners) {
        entry.stream.removeListener(entry.event, entry.handler)
      }
      process.stdout.write("\x1b[?25h")
      process.stdout.write("\x1b[0m")
    }

    const cancel = () => {
      if (resolved) return
      resolved = true
      cleanup()
      clearLines(visibleLines)
      reject(new PickerCancelledError())
    }

    let query = initialQuery ?? ""
    let cursorIndex = 0
    let scrollOffset = 0
    let visibleLines = 0

    const applyFilter = (q: string, opts: MultiPickOption[]): MultiPickOption[] => {
      if (q.trim().length === 0) return opts.slice()
      return fuzzyFilter(q, opts)
    }

    let filtered = applyFilter(query, items)

    const selectedCount = () => items.filter((i) => i.selected).length
    const selectedItems = (): PickOption[] => items.filter((i) => i.selected)

    const redraw = () => {
      const termHeight = process.stdout.rows ?? 24
      const termWidth = process.stdout.columns ?? 80
      const maxVisible = Math.max(1, termHeight - 2)

      if (filtered.length === 0) cursorIndex = 0
      else if (cursorIndex >= filtered.length) cursorIndex = filtered.length - 1
      else if (cursorIndex < 0) cursorIndex = 0

      if (cursorIndex < scrollOffset) scrollOffset = cursorIndex
      else if (cursorIndex >= scrollOffset + maxVisible) scrollOffset = cursorIndex - maxVisible + 1

      const end = Math.min(scrollOffset + maxVisible, filtered.length)

      clearLines(visibleLines)
      visibleLines = 0

      const header = filtered.length === 0
        ? formatNoMatchesHeader(query, termWidth)
        : `\x1b[1mSelect sessions to delete\x1b[0m  \x1b[2m(space: toggle, \u2191\u2193: move, Enter: confirm, Esc: cancel)\x1b[0m`
      process.stdout.write(header + "\n")
      visibleLines++

      for (let i = scrollOffset; i < end; i++) {
        const opt = filtered[i]
        if (!opt) continue
        const line = formatMultiLine(opt, termWidth, i === cursorIndex)
        process.stdout.write(line + "\n")
        visibleLines++
      }

      const count = selectedCount()
      const footer = count > 0
        ? `\x1b[2m>\x1b[0m ${query}\x1b[5m \x1b[0m  \x1b[33m${count} selected\x1b[0m`
        : `\x1b[2m>\x1b[0m ${query}\x1b[5m \x1b[0m  \x1b[2mtype to search...\x1b[0m`
      process.stdout.write(footer + "\n")
      visibleLines++
    }

    addListener(process.stdin, "data", (buf: Buffer) => {
      if (resolved) return

      const str = buf.toString()

      if (str === "\x1b") {
        cancel()
        return
      }
      if (str === "\x03") {
        cancel()
        return
      }
      if (str === "\x1b[A") {
        if (cursorIndex > 0) cursorIndex--
        redraw()
        return
      }
      if (str === "\x1b[B") {
        if (cursorIndex < filtered.length - 1) cursorIndex++
        redraw()
        return
      }

      // Space: toggle selection
      if (str === " ") {
        if (filtered.length === 0) return
        const current = filtered[cursorIndex]
        if (current) {
          const original = items.find((i) => i.id === current.id)
          if (original) original.selected = !original.selected
          redraw()
        }
        return
      }

      if (str === "\r" || str === "\n") {
        const sel = selectedItems()
        if (sel.length === 0) return // require at least one selection
        resolved = true
        cleanup()
        clearLines(visibleLines)
        resolve(sel)
        return
      }

      if (str === "\x7f" || str === "\b" || str === "\x08") {
        if (query.length > 0) {
          query = [...query].slice(0, -1).join("")
          filtered = applyFilter(query, items)
          cursorIndex = 0
          scrollOffset = 0
          redraw()
        }
        return
      }

      if (str.length === 1 && str.charCodeAt(0) >= 32 && str.charCodeAt(0) < 127) {
        query += str
        filtered = applyFilter(query, items)
        cursorIndex = 0
        scrollOffset = 0
        redraw()
        return
      }
    })

    addListener(process.stdout, "resize", () => {
      if (resolved) return
      redraw()
    })

    const sigintHandler = () => {
      cancel()
      process.exit(130)
    }
    addListener(process, "SIGINT", sigintHandler)

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.write("\x1b[?25l")

    redraw()
  })
}

function formatMultiLine(opt: MultiPickOption, width: number, isCursor: boolean): string {
  const checkbox = opt.selected ? "\x1b[32m\u25cf\x1b[0m" : "\u25cb"
  const prefix = isCursor ? "\x1b[7m" : ""
  const suffix = isCursor ? "\x1b[0m" : ""

  if (width >= 80) {
    const subtitle = opt.subtitle ?? ""
    const detail = opt.detail ?? ""
    const titleCol = Math.floor(width * 0.40)
    const subtitleCol = Math.floor(width * 0.25)
    const title = truncate(opt.title, titleCol - 2)
    const proj = truncate(subtitle, subtitleCol - 2)
    return `${prefix} ${checkbox} ${padRight(title, titleCol)}${padRight(proj, subtitleCol)}${detail}${suffix}`
  }

  if (width >= 50) {
    const detail = opt.detail ?? ""
    const titleCol = width - detail.length - 6
    const title = truncate(opt.title, titleCol - 2)
    return `${prefix} ${checkbox} ${padRight(title, titleCol)}${detail}${suffix}`
  }

  return `${prefix} ${checkbox} ${truncate(opt.title, width - 6)}${suffix}`
}

// ── Multi-select non-TTY picker ───────────────────────────────────────

async function pickMultiNonTty(options: PickOption[], initialQuery?: string): Promise<PickOption[]> {
  let query = initialQuery ?? ""
  let filtered = query.length > 0 ? fuzzyFilter(query, options) : options.slice()

  const rl = createInterface({ input: process.stdin, output: process.stderr })

  const prompt = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("Enter numbers (comma-separated) or refine search, Enter to cancel: ", (answer) => {
        resolve(answer.trim())
      })
    })

  const printList = (items: PickOption[]) => {
    const toPrint = items.slice(0, MAX_PRINTED)
    process.stderr.write("\n")
    for (let i = 0; i < toPrint.length; i++) {
      const opt = toPrint[i]
      if (!opt) continue
      const title = opt.title
      const subtitle = opt.subtitle ?? ""
      process.stderr.write(`  ${(i + 1).toString().padStart(2)}. ${title}`)
      if (subtitle) process.stderr.write(`  \x1b[2m${subtitle}\x1b[0m`)
      process.stderr.write("\n")
    }
    if (items.length > MAX_PRINTED) {
      process.stderr.write(`  \x1b[2m... and ${items.length - MAX_PRINTED} more\x1b[0m\n`)
    }
    process.stderr.write("\n")
  }

  while (true) {
    if (filtered.length === 0) {
      process.stderr.write(`\nNo sessions match "${query}". Showing all sessions again.\n`)
      query = ""
      filtered = options.slice()
      printList(filtered)
    } else {
      printList(filtered)
    }

    const answer = await prompt()

    if (answer === "") {
      rl.close()
      return []
    }

    // Comma-separated numbers
    const parts = answer.split(",").map((p) => p.trim()).filter(Boolean)
    const allNums = parts.every((p) => /^\d+$/.test(p))
    if (allNums) {
      const indices = parts.map((p) => parseInt(p, 10))
      const valid = indices.every((n) => n >= 1 && n <= filtered.length)
      if (valid && indices.length > 0) {
        rl.close()
        return indices.map((n) => filtered[n - 1]!)
      }
      process.stderr.write(`  Invalid selection: ${answer}\n`)
      continue
    }

    // Refine search
    query = answer
    filtered = query.length > 0 ? fuzzyFilter(query, options) : options.slice()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function clearLines(count: number) {
  if (count <= 0) return
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[2K") // clear line
    if (i < count - 1) process.stdout.write("\x1b[1A") // move up
  }
  // Move cursor back down
  if (count > 1) process.stdout.write(`\x1b[${count - 1}B`)
  // Move to start of line
  process.stdout.write("\r")
}

function formatLine(opt: PickOption, width: number, cursor: string): string {
  const prefix = cursor === ">" ? "\x1b[7m" : ""
  const suffix = cursor === ">" ? "\x1b[0m" : ""

  if (width >= 80) {
    // [> title]  [project]  [time]
    const subtitle = opt.subtitle ?? ""
    const detail = opt.detail ?? ""
    const titleCol = Math.floor(width * 0.45)
    const subtitleCol = Math.floor(width * 0.25)
    const title = truncate(opt.title, titleCol - 2)
    const proj = truncate(subtitle, subtitleCol - 2)
    return `${prefix}  ${padRight(title, titleCol)}${padRight(proj, subtitleCol)}${detail}${suffix}`
  }

  if (width >= 50) {
    // [> title]  [time]
    const detail = opt.detail ?? ""
    const titleCol = width - detail.length - 4
    const title = truncate(opt.title, titleCol - 2)
    return `${prefix}  ${padRight(title, titleCol)}${detail}${suffix}`
  }

  // Narrow: just title
  return `${prefix}  ${truncate(opt.title, width - 4)}${suffix}`
}

function formatNoMatchesHeader(query: string, width: number): string {
  const visibleQuery = query.trim().length > 0 ? ` "${truncate(query, Math.max(8, width - 46))}"` : ""
  return `\x1b[2mNo sessions match${visibleQuery} — Backspace to edit, Esc to cancel\x1b[0m`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "\u2026"
}

function padRight(s: string, len: number): string {
  if (s.length >= len) return s
  return s + " ".repeat(len - s.length)
}
