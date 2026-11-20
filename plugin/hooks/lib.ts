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
    tasks: { ...l.tasks, [row.ticket]: { ...t, usd: t.usd + row.usd, prompts: t.prompts + 1, lastAt: row.at } },
    sessions: { ...l.sessions, [session]: { session, person, ticket: row.ticket, usd: sessionUsd, lastAt: row.at } },
  }
}

/** Keeps the ledger small: sessions idle for a week are dropped. Tasks stay. */
export function prune(l: Ledger, now: number): Ledger {
  const keep = Object.fromEntries(Object.entries(l.sessions).filter(([, s]) => now - s.lastAt < 7 * 24 * 3_600_000))
  return { ...l, sessions: keep }
}

export function liveFrom(sessions: LiveSession[], now: number): LiveSession[] {
  return sessions.filter(s => now - s.lastAt < LIVE_MS).sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * The sprint's rows: every sprint ticket (zero if nothing was spent on it yet) with its cost,
 * then any spending on tickets outside the sprint list ("No ticket" included) when it has one.
 * Without a sprint list, the tasks with activity in the last two weeks.
 */
export function sprintRows(
  costs: TaskCost[],
  sprint: { key: string; summary?: string }[] | null,
  now: number,
): TaskCost[] {
  const byKey = new Map(costs.map(c => [c.ticket, c]))
  if (sprint) {
    const rows: TaskCost[] = sprint.map(s => ({ ...(byKey.get(s.key) ?? { ticket: s.key, usd: 0, prompts: 0, lastAt: 0 }), summary: s.summary }))
    const none = byKey.get(NO_TICKET)
    if (none && none.usd > 0) rows.push(none)
    return rows.sort((a, b) => b.usd - a.usd)
  }
  return costs.filter(c => now - c.lastAt < 14 * 24 * 3_600_000).sort((a, b) => b.lastAt - a.lastAt)
}
