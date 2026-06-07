import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260607100822_session_search_embedding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_search_embedding\` (
          \`fingerprint\` text PRIMARY KEY,
          \`vector\` blob NOT NULL,
          \`dimensions\` integer NOT NULL,
          \`model\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`last_accessed_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`idx_embedding_lru\` ON \`session_search_embedding\` (\`model\`,\`last_accessed_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
