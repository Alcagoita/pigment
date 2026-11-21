// Pure helpers: no $ calls, so they are easy to test.
import type { Ledger, LiveSession, PromptCost, Signal, TaskCost, Work } from '../types'

export const NO_TICKET = 'No ticket'

/** Context fill (percent of the window) from which answers tend to get less sharp. */
export const LONG_PERCENT = 65
/** Last three prompts cost at least this many times the first three. */
export const CLIMB_RATIO = 2
/** A prompt read at least this many input tokens with under this share from the cache. */
export const REREAD_TOKENS = 30_000
export const REREAD_SHARE = 0.4
/** A session counts as working now if it did something in this window. */
export const LIVE_MS = 10 * 60_000
/** A gap between prompts up to this long is reading and thinking, and counts as work; longer is a pause. */
export const IDLE_MS = 15 * 60_000
/** An open session silent this long is worth a look; past QUIET_MAX_MS it's left alone (probably forgotten). */
export const QUIET_MS = 45 * 60_000
export const QUIET_MAX_MS = 12 * 3_600_000

/** Active time for one prompt: the turn, plus the gap before it when it's short enough to be thinking. */
export function activeFor(submitAt: number, endAt: number, lastEndAt: number | undefined): number {
  const turn = Math.max(0, endAt - submitAt)
  const gap = lastEndAt === undefined ? Infinity : submitAt - lastEndAt
  return turn + (gap >= 0 && gap <= IDLE_MS ? gap : 0)
}

/** Open sessions that have gone quiet: not ended, silent for QUIET_MS, but not for half a day. */
export function quietFrom(sessions: LiveSession[], now: number): LiveSession[] {
  return sessions
    .filter(s => s.endedAt === undefined && now - s.lastAt >= QUIET_MS && now - s.lastAt < QUIET_MAX_MS && s.ticket !== NO_TICKET)
    .sort((a, b) => a.lastAt - b.lastAt)
}

/** The ticket a branch belongs to: `KAN-55-invite-link` → `KAN-55`, `12-invite` → `#12`. */
export function ticketFrom(branch: string): string {
  const name = branch.trim().replace(/^(feature|bugfix|fix|hotfix)\//, '')
  const jira = /^([A-Z][A-Z0-9]{1,9}-\d+)(\b|[-_])/.exec(name)
  if (jira) return jira[1] ?? NO_TICKET
  const issue = /^#?(\d+)[-_]/.exec(name)
  if (issue) return '#' + issue[1]
  return NO_TICKET
}

/** Whether a session rooted at `root` is one to measure, given the configured folder. */
export function isInside(root: string, folder: string): boolean {
  const f = folder.trim().replace(/\/+$/, '')
  if (f === '') return true
  return root === f || root.startsWith(f + '/')
}

const avg = (xs: PromptCost[]) => xs.reduce((n, x) => n + x.usd, 0) / xs.length

/** Why a fresh start would help now. */
export function signalsFor(w: Pick<Work, 'contextPercent' | 'prompts'>): Signal[] {
  const out: Signal[] = []
  if ((w.contextPercent ?? 0) >= LONG_PERCENT) out.push('long')
  const p = w.prompts
  if (p.length >= 6) {
    const early = avg(p.slice(0, 3))
    const late = avg(p.slice(-3))
    if (early > 0 && late >= CLIMB_RATIO * early && late >= 0.05) out.push('climbing')
  }
  const last = p[p.length - 1]
  if (last) {
    const read = last.input + last.cacheRead + last.cacheWrite
    if (read >= REREAD_TOKENS && last.cacheRead / read < REREAD_SHARE) out.push('rereading')
  }
  return out
}

/** How many times the last three prompts cost, on average, against the first three; 0 before six prompts. */
export function climbRatio(prompts: PromptCost[]): number {
  if (prompts.length < 6) return 0
  const early = avg(prompts.slice(0, 3))
  return early > 0 ? avg(prompts.slice(-3)) / early : 0
}

export function reasonText(signals: Signal[], prompts: PromptCost[]): string {
  if (signals.includes('long')) return 'This conversation has grown long. From here, answers can get less sharp.'
  if (signals.includes('climbing')) {
    const times = Math.round(avg(prompts.slice(-3)) / avg(prompts.slice(0, 3)))
    return `Each prompt now costs about ${times} times what it did at the start.`
  }
  return 'The last prompt had to re-read most of the conversation, which costs more.'
}

export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return '$' + n.toFixed(2)
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}

export function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

export const emptyLedger = (): Ledger => ({ tasks: {}, sessions: {} })

/** Adds one prompt to the ledger: its task's total and its session's running cost. */
export function addPrompt(l: Ledger, row: PromptCost, session: string, person: string, sessionUsd: number): Ledger {
  const t = l.tasks[row.ticket] ?? { ticket: row.ticket, usd: 0, prompts: 0, lastAt: 0 }
  return {
    tasks: { ...l.tasks, [row.ticket]: { ...t, usd: t.usd + row.usd, prompts: t.prompts + 1, lastAt: row.at, firstAt: t.firstAt ?? row.at, activeMs: (t.activeMs ?? 0) + row.activeMs } },
    sessions: { ...l.sessions, [session]: { session, person, ticket: row.ticket, usd: sessionUsd, lastAt: row.at } },
  }
}

/** Keeps the ledger small: sessions idle for a week are dropped. Tasks stay. */
export function prune(l: Ledger, now: number): Ledger {
  const keep = Object.fromEntries(Object.entries(l.sessions).filter(([, s]) => now - s.lastAt < 7 * 24 * 3_600_000))
  return { ...l, sessions: keep }
}

export function liveFrom(sessions: LiveSession[], now: number): LiveSession[] {
  return sessions.filter(s => s.endedAt === undefined && now - s.lastAt < LIVE_MS).sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * The sprint's rows: every sprint ticket (zero if nothing was spent on it yet) with its cost,
 * then any spending on tickets outside the sprint list ("No ticket" included) when it has one.
 * Without a sprint list, the tasks with activity in the last two weeks.
 */
export type SprintIssue = { key: string; summary?: string; startedAt?: number; doneAt?: number; estimateMs?: number; stage?: 'todo' | 'doing' | 'done' }

/** Tasks that need a look first, then the most expensive. */
function byAttention(now: number) {
  const rank = (t: TaskCost) => ({ over: 0, near: 1 })[timeFor(t, now)?.look ?? 'none' as never] ?? 2
  return (a: TaskCost, b: TaskCost) => rank(a) - rank(b) || b.usd - a.usd
}

export function sprintRows(costs: TaskCost[], sprint: SprintIssue[] | null, now: number): TaskCost[] {
  const byKey = new Map(costs.map(c => [c.ticket, c]))
  if (sprint) {
    const rows: TaskCost[] = sprint.map(s => {
      const c = byKey.get(s.key) ?? { ticket: s.key, usd: 0, prompts: 0, lastAt: 0 }
      return { ...c, summary: s.summary, startedAt: s.startedAt, doneAt: s.doneAt, estimateMs: s.estimateMs, stage: s.stage }
    })
    const none = byKey.get(NO_TICKET)
    if (none && none.usd > 0) rows.push(none)
    return rows.sort(byAttention(now))
  }
  return costs.filter(c => now - c.lastAt < 14 * 24 * 3_600_000).sort((a, b) => b.lastAt - a.lastAt)
}

// ── Where the numbers live ─────────────────────────────────────────────

/** `.pigment/config.json`, committed with the project: shared, never secret. */
export type ProjectConfig = {
  version: 1
  storage: 'local' | 'cloud'
  provider?: 'cloudflare'
  serverUrl?: string
  jira?: { site: string; project: string }
}

/** What this session can do with the numbers right now. */
export type StorageStatus = 'unchosen' | 'local' | 'cloud' | 'cloud-needs-key'

export function parseConfig(text: string | null): ProjectConfig | null {
  if (!text) return null
  try {
    const c = JSON.parse(text) as Partial<ProjectConfig>
    if (c.storage !== 'local' && c.storage !== 'cloud') return null
    const serverUrl = typeof c.serverUrl === 'string' ? c.serverUrl.trim().replace(/\/+$/, '') : undefined
    const jira = c.jira && typeof c.jira.site === 'string' && typeof c.jira.project === 'string' ? c.jira : undefined
    return { version: 1, storage: c.storage, provider: c.provider === 'cloudflare' ? 'cloudflare' : undefined, serverUrl, jira }
  } catch {
    return null
  }
}

export function statusFor(config: ProjectConfig | null, settings: { serverUrl: string; teamKey: string }): StorageStatus {
  const serverUrl = config?.serverUrl || settings.serverUrl
  const storage = config?.storage ?? (settings.serverUrl ? 'cloud' : undefined)
  if (!storage) return 'unchosen'
  if (storage === 'local') return 'local'
  return serverUrl && settings.teamKey ? 'cloud' : 'cloud-needs-key'
}

export function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'me'
}

/** One line of a local `.pigment/<person>-<yyyy-mm>.jsonl` file: numbers only. */
export type Line = {
  at: number; session: string; person: string; ticket: string; usd: number
  input: number; output: number; cacheRead: number; cacheWrite: number
  activeMs: number
}

export function toLine(row: PromptCost, session: string, person: string): Line {
  return {
    at: row.at, session, person, ticket: row.ticket, usd: row.usd,
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    activeMs: row.activeMs,
  }
}

export function fileFor(person: string, at: number): string {
  return `.pigment/${slug(person)}-${new Date(at).toISOString().slice(0, 7)}.jsonl`
}

/** Reads JSONL text, skipping any line that does not parse (a half-written last line). */
export function parseLines(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const l = JSON.parse(raw) as Line
      if (typeof l.usd === 'number' && typeof l.ticket === 'string') out.push(l)
    } catch { /* skip */ }
  }
  return out
}

/** Task totals and recent sessions from local lines (every person's files in the folder). */
export function fromLines(lines: Line[]): { tasks: TaskCost[]; sessions: LiveSession[] } {
  const tasks = new Map<string, TaskCost>()
  const sessions = new Map<string, LiveSession>()
  for (const l of lines) {
    const t = tasks.get(l.ticket) ?? { ticket: l.ticket, usd: 0, prompts: 0, lastAt: 0 }
    tasks.set(l.ticket, { ...t, usd: t.usd + l.usd, prompts: t.prompts + 1, lastAt: Math.max(t.lastAt, l.at), firstAt: Math.min(t.firstAt ?? l.at, l.at), activeMs: (t.activeMs ?? 0) + (l.activeMs ?? 0) })
    const s = sessions.get(l.session) ?? { session: l.session, person: l.person, ticket: l.ticket, usd: 0, lastAt: 0 }
    sessions.set(l.session, { ...s, ticket: l.at >= s.lastAt ? l.ticket : s.ticket, usd: s.usd + l.usd, lastAt: Math.max(s.lastAt, l.at) })
  }
  return { tasks: [...tasks.values()], sessions: [...sessions.values()] }
}

// ── Time per task ─────────────────────────────────────────────────────

/** From this share of its estimate, a task is worth a look. */
export const NEAR_SHARE = 0.8

export type TaskTime = { elapsedMs: number; isOpen: boolean; look: 'over' | 'near' | null }

/** Time worked on the task in sessions (not the clock on the wall), and whether it needs a look. */
export function timeFor(t: TaskCost, _now: number): TaskTime | null {
  if (!t.activeMs) return null
  const isOpen = t.doneAt === undefined
  const elapsedMs = t.activeMs
  let look: TaskTime['look'] = null
  if (isOpen && t.estimateMs && t.estimateMs > 0) {
    if (elapsedMs >= t.estimateMs) look = 'over'
    else if (elapsedMs >= NEAR_SHARE * t.estimateMs) look = 'near'
  }
  return { elapsedMs, isOpen, look }
}

/** 45m, 5h, 2h 10m, 3d 4h. */
export function duration(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 >= 5 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** The task's time as a manager reads it: "5h of 6h", "2h", "3h, done". */
export function timeText(t: TaskCost, now: number): string {
  const time = timeFor(t, now)
  if (!time) return ''
  const used = duration(time.elapsedMs)
  if (!time.isOpen) return `${used} worked, done`
  return t.estimateMs ? `${used} of ${duration(t.estimateMs)}` : used
}

/** The sentence above the list when tasks need a look. */
export function lookText(tasks: TaskCost[], now: number): string | null {
  const flagged = tasks.filter(t => timeFor(t, now)?.look)
  if (flagged.length === 0) return null
  const t = flagged[0]!
  const time = timeFor(t, now)!
  const what = time.look === 'over'
    ? `${t.ticket} has gone past its ${duration(t.estimateMs!)}: ${duration(time.elapsedMs)} so far.`
    : `${t.ticket} has used ${duration(time.elapsedMs)} of its ${duration(t.estimateMs!)}.`
  return flagged.length === 1 ? what : `${what} ${flagged.length - 1} more ${flagged.length === 2 ? 'task needs' : 'tasks need'} a look too.`
}

/**
 * The tasks in development now. From Jira: its in-progress statuses. Without Jira: open tasks
 * worked on in the last three days. Those that need a look first, then the longest running.
 */
export function inDevelopment(tasks: TaskCost[], now: number, hasStages: boolean): TaskCost[] {
  const doing = hasStages
    ? tasks.filter(t => t.stage === 'doing')
    : tasks.filter(t => t.ticket !== NO_TICKET && t.doneAt === undefined && now - t.lastAt < 3 * 24 * 3_600_000)
  const rank = (t: TaskCost) => ({ over: 0, near: 1 })[timeFor(t, now)?.look ?? 'none' as never] ?? 2
  return doing.sort((a, b) => rank(a) - rank(b) || (timeFor(b, now)?.elapsedMs ?? 0) - (timeFor(a, now)?.elapsedMs ?? 0))
}

// ── Jira ──────────────────────────────────────────────────────────────

export type JiraIssue = {
  key: string
  fields?: {
    summary?: string
    status?: { statusCategory?: { key?: string } }
    resolutiondate?: string | null
    timeoriginalestimate?: number | null
    /** When the status category last changed: Jira's own field, there when the changelog isn't. */
    statuscategorychangedate?: string | null
    /** The Sprint field (customfield_10020 on Jira Cloud). */
    customfield_10020?: { id: number; name: string; state?: string; startDate?: string; endDate?: string }[] | null
  }
  changelog?: { histories?: { created: string; items?: { field?: string }[] }[] }
}

/** Started: the first time it left its first status. Done: resolved (or its last status change) once in a done status. */
export function sprintIssue(i: JiraIssue): SprintIssue {
  const moves = (i.changelog?.histories ?? [])
    .filter(h => (h.items ?? []).some(it => it.field === 'status'))
    .map(h => Date.parse(h.created))
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b)
  const category = i.fields?.status?.statusCategory?.key
  const isDone = category === 'done'
  const resolved = i.fields?.resolutiondate ? Date.parse(i.fields.resolutiondate) : NaN
  const estimate = i.fields?.timeoriginalestimate
  return {
    key: i.key,
    summary: i.fields?.summary,
    // Without the changelog (the Atlassian connector), a task in progress started when it entered that category.
    startedAt: moves[0] ?? (category === 'indeterminate' && i.fields?.statuscategorychangedate ? Date.parse(i.fields.statuscategorychangedate) : undefined),
    doneAt: isDone ? (Number.isNaN(resolved) ? moves[moves.length - 1] : resolved) : undefined,
    estimateMs: typeof estimate === 'number' && estimate > 0 ? estimate * 1000 : undefined,
    stage: isDone ? 'done' : category === 'indeterminate' ? 'doing' : 'todo',
  }
}


// ── Jira through the Atlassian connector ─────────────────────────────

/** The connected MCP server that has Jira's search, whatever /mcp calls it. */
export function jiraServerFrom(tools: { name: string; serverName: string }[]): string | undefined {
  return tools.find(t => /(^|__)searchJiraIssuesUsingJql$/.test(t.name))?.serverName
}

/** A connector result's JSON: its structured content, else its first text block that parses. */
export function mcpJson(r: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }): unknown {
  if (r.isError) throw new Error((r.content ?? []).map(b => b.text ?? '').join(' ').slice(0, 200) || 'Jira refused')
  if (r.structuredContent !== undefined) return r.structuredContent
  for (const b of r.content ?? []) {
    if (b.type !== 'text' || !b.text) continue
    try { return JSON.parse(b.text) as unknown } catch { /* the next block */ }
  }
  throw new Error('No JSON in the reply')
}

/** The issues of a search reply, in the shapes the connector has used. */
export function issuesFrom(json: unknown): { issues: JiraIssue[]; next?: string } {
  const d = json as { issues?: JiraIssue[] | { nodes?: JiraIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }; nextPageToken?: string }
  if (Array.isArray(d?.issues)) return { issues: d.issues, next: d.nextPageToken }
  const page = d?.issues?.pageInfo
  return { issues: d?.issues?.nodes ?? [], next: page?.hasNextPage && page.endCursor ? page.endCursor : undefined }
}

/** The open sprint, read off the issues' Sprint field. */
export function openSprintFrom(issues: JiraIssue[]): { id: number; name: string; startDate?: string; endDate?: string } | null {
  for (const i of issues) {
    const s = (i.fields?.customfield_10020 ?? []).find(x => x.state === 'active')
    if (s) return { id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate }
  }
  return null
}

/** KAN-55 → KAN; anything else has no Jira project. */
export function projectFrom(ticket: string): string | undefined {
  return /^([A-Z][A-Z0-9]{1,9})-\d+$/.exec(ticket)?.[1]
}

/** Jira's own way of writing time spent: "5h 10m", "6m". */
export function timeSpentText(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60))
  const h = Math.floor(m / 60)
  return h ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m}m`
}

// ── Jira worklog ─────────────────────────────────────────────────────

/** Worked time is logged from this many minutes; less isn't worth a worklog. */
export const MIN_LOG_MS = 5 * 60_000

/** The status a task's time is logged at (`Testing` by default), matched without case; Done counts too. */
export function isLogStatus(name: string, category: string | undefined, logOn: string): boolean {
  return name.trim().toLowerCase() === logOn.trim().toLowerCase() || category === 'done'
}

/** Jira's `started` format: 2026-11-20T10:00:00.000+0000. */
export function jiraStarted(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '+0000')
}

/** Jira takes whole minutes; round to the nearest, at least one. */
export function worklogSeconds(ms: number): number {
  return Math.max(60, Math.round(ms / 60_000) * 60)
}

// ── Sprint summary ───────────────────────────────────────────────────

export function sprintSlug(name: string): string {
  return slug(name) || 'sprint'
}

/** A plain Markdown summary of a sprint: totals, then one row per task. Numbers only. */
export function summaryMarkdown(
  name: string,
  tasks: TaskCost[],
  opts: { startDate?: string; endDate?: string; hasEnded: boolean; writtenAt: number },
): { text: string; usd: number; prompts: number; activeMs: number } {
  const usdTotal = tasks.reduce((n, t) => n + t.usd, 0)
  const prompts = tasks.reduce((n, t) => n + t.prompts, 0)
  const activeMs = tasks.reduce((n, t) => n + (t.activeMs ?? 0), 0)
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : '')
  const when = opts.startDate || opts.endDate ? `${day(opts.startDate)} → ${day(opts.endDate)}` : ''
  const rows = [...tasks]
    .sort((a, b) => b.usd - a.usd)
    .map(t => {
      const est = t.estimateMs ? duration(t.estimateMs) : ''
      const state = t.stage === 'done' || t.doneAt !== undefined ? 'done' : t.stage === 'doing' ? 'in development' : 'to do'
      return `| ${t.ticket} | ${(t.summary ?? '').replace(/\|/g, '/')} | ${usd(t.usd)} | ${t.prompts} | ${t.activeMs ? duration(t.activeMs) : ''} | ${est} | ${state} |`
    })
  const text = [
    `# ${name}${opts.hasEnded ? '' : ' (so far)'}`,
    '',
    when ? `${when}  ` : '',
    `Written by Pigment on ${new Date(opts.writtenAt).toISOString().slice(0, 10)}.`,
    '',
    `- **Cost:** ${usd(usdTotal)} (an estimate at list price)`,
    `- **Prompts:** ${prompts}`,
    `- **Worked time:** ${duration(activeMs)} (time in sessions; pauses over 15 minutes don't count)`,
    `- **Tasks:** ${tasks.length}, ${tasks.filter(t => t.stage === 'done' || t.doneAt !== undefined).length} done`,
    '',
    '| Task | Summary | Cost | Prompts | Worked | Estimate | State |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
  return { text, usd: usdTotal, prompts, activeMs }
}

/** One entry per person working now (their most recent session), leaving out this session itself. */
export function teamNow(live: LiveSession[], thisSession: string): LiveSession[] {
  const byPerson = new Map<string, LiveSession>()
  for (const s of live) {
    if (s.session === thisSession) continue
    const seen = byPerson.get(s.person)
    if (!seen || s.lastAt > seen.lastAt) byPerson.set(s.person, s)
  }
  return [...byPerson.values()].sort((a, b) => a.person.localeCompare(b.person))
}

/** The key file's name for a server: `pigment-brush` from https://pigment-brush.<account>.workers.dev. */
export function keyNameFrom(serverUrl: string): string {
  try {
    const host = new URL(serverUrl).hostname
    return host.split('.')[0]?.replace(/[^a-z0-9-]/gi, '') ?? ''
  } catch {
    return ''
  }
}

/** A pasted team key: trimmed, no spaces inside, long enough to be one. */
export function cleanKey(text: string): string | null {
  const k = text.trim()
  return k.length >= 16 && !/\s/.test(k) ? k : null
}
