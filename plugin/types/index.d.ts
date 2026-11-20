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
  /** Where the numbers go: chosen yet, on this computer, the team cloud, or the cloud waiting for this person's key. */
  storage: 'unchosen' | 'local' | 'cloud' | 'cloud-needs-key'
  serverUrl?: string
  /** Rows waiting to be written to the chosen place. */
  waiting: number
  storageCard: 'ask' | 'cloud-help' | 'hidden'
}

/** One task's total. */
export type TaskCost = {
  ticket: string; summary?: string; usd: number; prompts: number; lastAt: number
  /** First prompt Pigment counted on this ticket. */
  firstAt?: number
  /** When the task started (Jira: left its first status), else firstAt. */
  startedAt?: number
  /** When it finished (Jira: resolved); absent while open. */
  doneAt?: number
  /** The time it was given (Jira: original estimate), in milliseconds. */
  estimateMs?: number
  /** Jira's status category: to do, in development, done. */
  stage?: 'todo' | 'doing' | 'done'
}

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
    pigment: { work: Shaped<Work>; sprint: Shaped<Sprint | null> }
  }
}
