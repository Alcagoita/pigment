/** One prompt: what its turn cost, the task it counted towards, how full the conversation was. */
export type PromptCost = {
  at: number
  label: string
  ticket: string
  usd: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextPercent?: number
}

/** Why the developer view suggests a fresh start. */
export type Signal = 'long' | 'climbing' | 'rereading'

export type Role = 'developer' | 'manager'

/** This session, as the developer view draws it. */
export type Work = {
  isMeasured: boolean
  folder: string
  role: Role
  ticket: string
  sessionUsd: number
  taskUsd: number
  hasUnknownPrice: boolean
  contextPercent?: number
  prompts: PromptCost[]
  pendingUsd?: number
  pendingLabel?: string
  snoozed: Signal[]
  isBusy: boolean
  handoffPath?: string
}

/** One task's total. */
export type TaskCost = { ticket: string; summary?: string; usd: number; prompts: number; lastAt: number }

/** One session that has been active recently. */
export type LiveSession = { session: string; person: string; ticket: string; usd: number; lastAt: number }

/** The sprint, as the manager view draws it. */
export type Sprint = {
  name?: string
  source: 'jira' | 'recent'
  where: 'team' | 'this computer'
  tasks: TaskCost[]
  total: number
  live: LiveSession[]
  updatedAt: number
  note?: string
}

/** What this computer keeps across sessions, per project folder. */
export type Ledger = {
  tasks: Record<string, TaskCost>
  sessions: Record<string, LiveSession>
}

declare module 'claude-code' {
  interface PluginState {
    tally: { work: Shaped<Work>; sprint: Shaped<Sprint | null> }
  }
}
