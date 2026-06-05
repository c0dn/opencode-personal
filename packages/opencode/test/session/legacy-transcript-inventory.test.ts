import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dir, "../..")
const repoRoot = path.resolve(packageRoot, "../..")

// Scan runtime implementation source in opencode/src plus core session sources;
// tests, generated artifacts, and docs are excluded intentionally.
const sourceRoots = [
  "packages/opencode/src",
  "packages/core/src/session",
  "packages/core/src/session.ts",
]

const categories = {
  SessionLegacy: {
    pattern: /\bSessionLegacy\b/,
    allowed: [
      "packages/core/src/session/legacy.ts",
      "packages/core/src/session/message-backfill-service.ts",
      "packages/core/src/session/message-backfill.ts",
      "packages/core/src/session/projector.ts",
      "packages/opencode/src/cli/cmd/debug/agent.ts",
      "packages/opencode/src/cli/cmd/github.ts",
      "packages/opencode/src/cli/cmd/import.ts",
      "packages/opencode/src/image/image.ts",
      "packages/opencode/src/server/routes/instance/httpapi/groups/session.ts",
      "packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts",
      "packages/opencode/src/session/compaction.ts",
      "packages/opencode/src/session/instruction.ts",
      "packages/opencode/src/session/llm.ts",
      "packages/opencode/src/session/llm/request.ts",
      "packages/opencode/src/session/message-v2.ts",
      "packages/opencode/src/session/overflow.ts",
      "packages/opencode/src/session/processor.ts",
      "packages/opencode/src/session/prompt.ts",
      "packages/opencode/src/session/prompt/reference.ts",
      "packages/opencode/src/session/retry.ts",
      "packages/opencode/src/session/revert.ts",
      "packages/opencode/src/session/run-state.ts",
      "packages/opencode/src/session/session.ts",
      "packages/opencode/src/session/summary.ts",
      "packages/opencode/src/session/tools.ts",
      "packages/opencode/src/tool/plan.ts",
      "packages/opencode/src/tool/task.ts",
      "packages/opencode/src/tool/tool.ts",
    ],
  },
  MessageV2LegacyReaders: {
    pattern: /\bMessageV2\.(?:page|get|parts|stream|filterCompacted|filterCompactedEffect|latest)\b/,
    allowed: [
      "packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts",
      "packages/opencode/src/session/message-v2.ts",
      "packages/opencode/src/session/processor.ts",
      "packages/opencode/src/session/prompt.ts",
      "packages/opencode/src/session/session.ts",
    ],
  },
  MessageV2LegacyEvents: {
    pattern: /\bMessageV2\.Event\.(?:Updated|Removed|PartUpdated|PartRemoved)\b/,
    allowed: [
      "packages/opencode/src/cli/cmd/github.ts",
    ],
  },
  SessionLegacyReaders: {
    pattern:
      /(?:^|[^\w.'"`])(?:session|sessions|sessionSvc|svc)\.(?:messages|findMessage)\b|\bSession\.(?:messages|findMessage)\b/m,
    allowed: [
      "packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts",
      "packages/opencode/src/session/compaction-v2-session.ts",
      "packages/opencode/src/session/prompt.ts",
      "packages/opencode/src/session/revert.ts",
      "packages/opencode/src/session/session.ts",
      "packages/opencode/src/session/summary.ts",
    ],
  },
  SessionLegacyMutations: {
    pattern:
      /(?:\b(?:session|sessions|sessionSvc)\.(?:updateMessage|updatePart|updatePartDelta|removeMessage|removePart)\b|\bSession\.(?:updateMessage|updatePart|updatePartDelta|removeMessage|removePart)\b)/,
    allowed: [
      "packages/opencode/src/cli/cmd/debug/agent.ts",
      "packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts",
      "packages/opencode/src/session/compaction.ts",
      "packages/opencode/src/session/processor.ts",
      "packages/opencode/src/session/prompt.ts",
      "packages/opencode/src/session/revert.ts",
      "packages/opencode/src/session/session.ts",
      "packages/opencode/src/session/summary.ts",
      "packages/opencode/src/tool/plan.ts",
    ],
  },
  MessageTable: {
    pattern: /\bMessageTable\b/,
    allowed: [
      "packages/core/src/session/message-backfill-service.ts",
      "packages/core/src/session/projector.ts",
      "packages/core/src/session/sql.ts",
      "packages/opencode/src/cli/cmd/import.ts",
      "packages/opencode/src/session/message-v2.ts",
      "packages/opencode/src/storage/json-migration.ts",
      "packages/opencode/src/storage/schema.ts",
    ],
  },
  PartTable: {
    pattern: /\bPartTable\b/,
    allowed: [
      "packages/core/src/session/message-backfill-service.ts",
      "packages/core/src/session/projector.ts",
      "packages/core/src/session/sql.ts",
      "packages/opencode/src/cli/cmd/import.ts",
      "packages/opencode/src/session/message-v2.ts",
      "packages/opencode/src/session/session.ts",
      "packages/opencode/src/storage/json-migration.ts",
      "packages/opencode/src/storage/schema.ts",
    ],
  },
} as const

describe("legacy transcript inventory guard", () => {
  test("runtime legacy transcript dependencies stay explicitly inventoried", async () => {
    const sourceFiles = await runtimeSourceFiles()

    for (const [name, category] of Object.entries(categories)) {
      const actual = await matchingFiles(sourceFiles, category.pattern)

      expect(actual, inventoryMessage(name, actual, category.allowed)).toStrictEqual([...category.allowed].sort())
    }
  })
})

async function runtimeSourceFiles() {
  const files = await Promise.all(
    sourceRoots.map((sourceRoot) => collectSourceFiles(path.resolve(repoRoot, sourceRoot), sourceRoot)),
  )
  return files.flat().sort()
}

async function collectSourceFiles(target: string, sourceRoot = relativePath(target)): Promise<string[]> {
  if (!isRuntimeSourceFile(path.basename(target)) && target.endsWith(".ts")) return []

  const targetStat = await stat(target).catch((error) => {
    throw new Error(`Configured source root is missing: ${sourceRoot}`, { cause: error })
  })

  if (target.endsWith(".ts")) {
    expect(targetStat.isFile(), `Configured TypeScript source root must be a file: ${sourceRoot}`).toBe(true)
    return [target]
  }

  expect(targetStat.isDirectory(), `Configured source root must be a directory: ${sourceRoot}`).toBe(true)

  const entries = await readdir(target, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const child = path.join(target, entry.name)
      if (entry.isDirectory()) return collectSourceFiles(child)
      if (entry.isFile() && isRuntimeSourceFile(entry.name)) return Promise.resolve([child])
      return Promise.resolve([])
    }),
  )
  return files.flat()
}

function isRuntimeSourceFile(fileName: string) {
  return fileName.endsWith(".ts") && !fileName.endsWith(".d.ts") && !fileName.endsWith(".test.ts")
}

async function matchingFiles(files: string[], pattern: RegExp) {
  const matches: string[] = []
  for (const file of files) {
    const source = await readFile(file, "utf8")
    if (pattern.test(source)) matches.push(relativePath(file))
  }
  return matches.sort()
}

function relativePath(file: string) {
  return path.relative(repoRoot, file).split(path.sep).join("/")
}

function inventoryMessage(name: string, actual: string[], allowed: readonly string[]) {
  const allowedSet = new Set(allowed)
  const actualSet = new Set(actual)
  const unexpected = actual.filter((file) => !allowedSet.has(file))
  const missing = allowed.filter((file) => !actualSet.has(file))

  return [
    `${name} legacy transcript inventory changed.`,
    "This blocker guard only inventories current legacy transcript readers/writers; it is not approval to remove them.",
    unexpected.length ? `Unexpected runtime paths:\n${unexpected.join("\n")}` : "Unexpected runtime paths: none",
    missing.length ? `Allowed paths with no current match:\n${missing.join("\n")}` : "Allowed paths with no current match: none",
  ].join("\n\n")
}
