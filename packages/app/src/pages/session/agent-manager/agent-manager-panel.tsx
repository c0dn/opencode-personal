import { For, Match, Show, Switch, createMemo } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useNavigate } from "@solidjs/router"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useAgentManager } from "./agent-manager-context"
import type { SubagentRow, SubagentStatus } from "./subagent-rows"

const PANEL_WIDTH = 320

export function AgentManagerPanel() {
  const sdk = useSDK()
  const settings = useSettings()
  const language = useLanguage()
  const navigate = useNavigate()
  const { params, view } = useSessionLayout()
  const state = useAgentManager()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const open = createMemo(() => isDesktop() && view().agentManager.opened())

  const jump = (sessionID: string) => navigate(`/${params.dir}/session/${sessionID}`)
  const interrupt = (sessionID: string) => void sdk.client.session.abort({ sessionID }).catch(() => {})

  return (
    <Show when={isDesktop()}>
      <aside
        id="agent-manager-panel"
        aria-label={language.t("session.agentManager.title")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            true,
          "rounded-[10px] shadow-[var(--v2-elevation-raised)]": settings.general.newLayoutDesigns(),
        }}
        style={{ width: open() ? `${PANEL_WIDTH}px` : "0px" }}
      >
        <Show when={open()}>
          <div
            class="h-full flex flex-col shrink-0"
            classList={{ "border-l border-border-weaker-base": !settings.general.newLayoutDesigns() }}
            style={{ width: `${PANEL_WIDTH}px` }}
          >
            <header class="shrink-0 flex items-center justify-between gap-2 h-11 px-3 border-b border-border-weaker-base">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-13-medium text-text-strong truncate">
                  {language.t("session.agentManager.title")}
                </span>
                <Show when={state.runningCount() > 0}>
                  <span class="text-12-regular text-text-weak">
                    {language.t("session.agentManager.running", { count: state.runningCount() })}
                  </span>
                </Show>
              </div>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="normal"
                onClick={() => view().agentManager.close()}
                aria-label={language.t("common.close")}
                icon={<IconV2 name="close" />}
              />
            </header>

            <div class="flex-1 min-h-0 overflow-y-auto">
              <Show
                when={state.rows().length > 0}
                fallback={
                  <div class="h-full flex items-center justify-center px-6 text-center">
                    <span class="text-12-regular text-text-weak">{language.t("session.agentManager.empty")}</span>
                  </div>
                }
              >
                <ul class="flex flex-col py-1">
                  <For each={state.rows()}>
                    {(row) => <SubagentItem row={row} onJump={jump} onInterrupt={interrupt} />}
                  </For>
                </ul>
              </Show>
            </div>
          </div>
        </Show>
      </aside>
    </Show>
  )
}

function SubagentItem(props: {
  row: SubagentRow
  onJump: (sessionID: string) => void
  onInterrupt: (sessionID: string) => void
}) {
  const language = useLanguage()
  return (
    <li class="group/agent flex items-center gap-1 px-1.5">
      <button
        type="button"
        class="flex-1 min-w-0 flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-surface-raised-base-hover"
        style={{ "margin-left": `${indent(props.row.depth)}px` }}
        onClick={() => props.onJump(props.row.sessionID)}
        aria-label={`${language.t("session.agentManager.open")}: ${props.row.title}`}
      >
        <StatusPill status={props.row.status} busy={props.row.busy} />
        <div class="flex flex-col min-w-0">
          <span class="text-13-regular text-text-base truncate">{props.row.title}</span>
          <span class="text-11-regular text-text-weak truncate">
            {props.row.agent ?? language.t(`session.agentManager.status.${props.row.status}`)}
          </span>
        </div>
      </button>
      <Show when={props.row.busy}>
        <Tooltip placement="bottom" value={language.t("session.agentManager.interrupt")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="normal"
            class="shrink-0"
            onClick={() => props.onInterrupt(props.row.sessionID)}
            aria-label={`${language.t("session.agentManager.interrupt")}: ${props.row.title}`}
            icon={<Icon name="stop" size="small" />}
          />
        </Tooltip>
      </Show>
    </li>
  )
}

// Indent deeper subagents to show the tree hierarchy; cap the depth so very
// deep chains do not push the row content off-screen.
const INDENT_STEP = 14
const MAX_INDENT_LEVELS = 6
function indent(depth: number): number {
  return Math.min(Math.max(depth - 1, 0), MAX_INDENT_LEVELS) * INDENT_STEP
}

const STATUS_DOT: Record<Exclude<SubagentStatus, "running">, string> = {
  idle: "bg-icon-weak",
  completed: "bg-surface-success-strong",
  error: "bg-text-diff-delete-base",
}

function StatusPill(props: { status: SubagentStatus; busy: boolean }) {
  return (
    <span class="shrink-0 flex size-4 items-center justify-center" aria-hidden="true">
      <Switch>
        <Match when={props.status === "running"}>
          <Spinner class="size-3.5" />
        </Match>
        <Match when={props.status !== "running"}>
          <span class={`size-2 rounded-full ${STATUS_DOT[props.status as Exclude<SubagentStatus, "running">]}`} />
        </Match>
      </Switch>
    </span>
  )
}
