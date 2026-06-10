import type { SubagentRow, SubagentStatus } from "./subagent-rows"

// Indent deeper subagents to show the tree hierarchy; cap the depth so very
// deep chains do not push the row content off-screen.
export const INDENT_STEP = 14
export const MAX_INDENT_LEVELS = 6

export function indent(depth: number): number {
  return Math.min(Math.max(depth - 1, 0), MAX_INDENT_LEVELS) * INDENT_STEP
}

// Dot color per non-running status. Running has no dot; it renders a spinner.
export const STATUS_DOT: Record<Exclude<SubagentStatus, "running">, string> = {
  idle: "bg-icon-weak",
  completed: "bg-surface-success-strong",
  error: "bg-text-diff-delete-base",
}

// The interrupt control is shown only for busy (running) subagents.
export function showsInterrupt(row: Pick<SubagentRow, "busy">): boolean {
  return row.busy
}

// Route to a subagent's own session within the active directory. `dir` mirrors
// the router param, which is typed as possibly undefined.
export function childSessionPath(dir: string | undefined, sessionID: string): string {
  return `/${dir}/session/${sessionID}`
}
