import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Ledger, LiveSession, PromptCost, Role, Sprint, TaskCost, Work } from '../types'
import {
  activeFor, addPrompt, ago, duration, emptyLedger, fileFor, fromLines, inDevelopment, isInside, cleanKey, keyNameFrom, liveFrom, lookText, NO_TICKET, quietFrom, teamNow, parseConfig, parseLines,
  isLogStatus, jiraStarted, MIN_LOG_MS, prune, reasonText, signalsFor, sprintIssue, sprintRows, sprintSlug, statusFor, summaryMarkdown, worklogSeconds, ticketFrom, timeFor, timeText, toLine, tokens, usd,
} from './lib'
import { figureCells, figureSvg } from './figures'
import type { JiraIssue, Line, ProjectConfig, SprintIssue, StorageStatus } from './lib'

const PANE = 'pigment'
const TITLES: Record<Role, string> = { developer: 'Pigment · Your work', manager: 'Pigment · The sprint' }
const REFRESH_MS = 15_000
const HEARTBEAT_MS = 15_000

const EMPTY: Work = {
  isMeasured: false, folder: '', role: 'developer', ticket: NO_TICKET, sessionUsd: 0, taskUsd: 0,
  hasUnknownPrice: false, prompts: [], snoozed: [], isBusy: false,
  storage: 'unchosen', waiting: 0, storageCard: 'ask',
}
// Bump a tag when its type's fields change: older stored values are read as the initial value.
const work = atom({ plugin: 'pigment', key: 'work' } as const, EMPTY, { shape: 'work-5' })
const sprint = atom({ plugin: 'pigment', key: 'sprint' } as const, null, { shape: 'sprint-3' })
// Which lists the person expanded past their first three rows.
const open = atom({ plugin: 'pigment', key: 'open' } as const, {}, { shape: 'open-1' })
const FIRST = 3

type Options = {
  role?: string; projectFolder?: string; person?: string; serverUrl?: string; teamKey?: string
  jiraSite?: string; jiraEmail?: string; jiraToken?: string; jiraProject?: string; logOnStatus?: string
}

const HANDOFF_PROMPT = `Write a handoff so this session can be resumed in a new one with nothing lost. The new session starts with only this note.
Markdown, up to 700 words, only facts from this conversation, no tools:
## Working on — the task in progress right now: its ticket, its goal, what "done" means
## Where it stands — what's finished in that task and what's half-done
## Carry on with — the very next action in that task
## Also open in this session — every other open topic, one bullet each: what it is, where it stands, decisions already made, and what it waits on (the person, a review, another task). These are not to be started on their own.
## Decisions and rules to keep — what the person decided or asked for, so it isn't asked again
## Where things are — repositories, branches, pull requests, tickets, links and files, with their state
Leave out: finished topics with nothing left to do, and any key, token or password.
Answer with the note alone.`

/** What the person pastes as the first message of a new session: the summary, then one line to carry on. */
export function resumePrompt(summary: string): string {
  return `${summary.trim()}\n\nCarry on with the work in progress above. The other open topics are there for when I bring them up.`
}

type Ctx = {
  role: Role; folder: string; person: string; server: string; teamKey: string
  hasServer: boolean; hasJira: boolean; o: Options
  root: string; sessionId: string; lastBeat: number
  config: ProjectConfig | null; status: StorageStatus
  jiraSite: string; jiraProject: string
  lastStatusCheck: number
  refreshing?: Promise<void>
  /** The pane's title as last set, so it's set again only when the sprint changes. */
  title: string
}

function jiraBase(c: Ctx) { return `https://${c.jiraSite.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` }
function jiraAuth(c: Ctx) { return { authorization: 'Basic ' + btoa(`${c.o.jiraEmail}:${c.o.jiraToken}`) } }
function hasJiraLogin(c: Ctx) { return !!(c.jiraSite && c.o.jiraEmail && c.o.jiraToken) }
const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/

/** When this person's task reaches the logging status (Testing), offer to log their unlogged worked time. */
async function checkLogOffer($: EngineInterface, c: Ctx, force = false) {
  const w = await read($, work)
  if (!w.isMeasured || !hasJiraLogin(c) || !JIRA_KEY.test(w.ticket)) return
  const now = await $.clock.now()
  if (!force && now - c.lastStatusCheck < 5 * 60_000) return
  c.lastStatusCheck = now
  let issue: { fields?: { status?: { name?: string; statusCategory?: { key?: string } } } }
  try {
    issue = (await getJson($, `${jiraBase(c)}/rest/api/3/issue/${w.ticket}?fields=status`, jiraAuth(c))) as typeof issue
  } catch { return }
  const name = issue.fields?.status?.name ?? ''
  const ready = isLogStatus(name, issue.fields?.status?.statusCategory?.key, c.o.logOnStatus || 'Testing')
  const worked = (await loadLedger($, c)).tasks[w.ticket]?.activeMs ?? 0
  const logged = Number((await $.store.get(`logged:${c.root}:${w.ticket}`)) ?? 0)
  const ms = worked - logged
  await update($, work, x => ({ ...x, logOffer: ready && ms >= MIN_LOG_MS ? { ticket: w.ticket, status: name, ms } : undefined }))
}

async function logWork($: EngineInterface, c: Ctx, offer: { ticket: string; ms: number }) {
  await update($, work, x => ({ ...x, logOffer: x.logOffer && { ...x.logOffer, isBusy: true } }))
  const now = await $.clock.now()
  const seconds = worklogSeconds(offer.ms)
  try {
    const r = await $.http.fetch(`${jiraBase(c)}/rest/api/3/issue/${offer.ticket}/worklog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...jiraAuth(c) },
      body: JSON.stringify({
        timeSpentSeconds: seconds,
        started: jiraStarted(now - seconds * 1000),
        comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Worked time counted by Pigment: time in sessions, pauses over 15 minutes left out.' }] }] },
      }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch {
    await update($, work, x => ({ ...x, logOffer: x.logOffer && { ...x.logOffer, isBusy: false } }))
    $.ui.toast(`I couldn't log the time on ${offer.ticket} in Jira. Nothing was logged; check the Jira settings and try again.`)
    return
  }
  const key = `logged:${c.root}:${offer.ticket}`
  await $.store.set(key, Number((await $.store.get(key)) ?? 0) + offer.ms)
  await update($, work, x => ({ ...x, logOffer: undefined }))
  $.ui.toast(`Logged ${duration(seconds * 1000)} on ${offer.ticket} in Jira.`)
}

/** Writes `.pigment/sprints/<sprint>.md` and shows it in the sprint view. */
async function writeSummary($: EngineInterface, c: Ctx, name: string, tasks: TaskCost[], dates: { startDate?: string; endDate?: string }, hasEnded: boolean) {
  const now = await $.clock.now()
  const sum = summaryMarkdown(name, tasks, { ...dates, hasEnded, writtenAt: now })
  const path = `.pigment/sprints/${sprintSlug(name)}.md`
  await $.fs.write(`${c.root}/${path}`, sum.text)
  await update($, sprint, x => (x ? { ...x, summary: { name, path, text: sum.text, usd: sum.usd, prompts: sum.prompts, activeMs: sum.activeMs, hasEnded } } : x))
  return path
}

/** Writes the handoff, saves and copies it, and puts the continuation message in the prompt box. */
async function startFresh($: EngineInterface, c: Ctx, surface: RenderSurface) {
  try {
    const r = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!r.isAnswered) throw new Error(r.reason)
    const stamp = new Date(await $.clock.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const rel = `.claude/handoffs/${stamp}.md`
    await $.fs.write(`${c.root}/${rel}`, r.text)
    // Nothing goes into this session's box: sending it here would make this session start the new one.
    const copied = await $.ui.copy({ text: resumePrompt(r.text), surface })
    await update($, work, x => ({ ...x, isBusy: false, handoffPath: rel }))
    $.ui.toast(copied.isCopied
      ? 'Ready. Open a new session and paste: it carries on from here.'
      : `Ready. Open a new session and paste what's in ${rel}.`)
  } catch {
    await update($, work, x => ({ ...x, isBusy: false }))
    $.ui.toast("I couldn't write the summary this time. Nothing changed; try again in a moment.")
  }
}

const CONFIG = '.pigment/config.json'

/** Reads `.pigment/config.json` (shared with the project) and settles where the numbers go. */
async function loadConfig($: EngineInterface, c: Ctx) {
  const path = `${c.root}/${CONFIG}`
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : null
  c.config = parseConfig(text)
  const settingsServer = (c.o.serverUrl ?? '').trim().replace(/\/+$/, '')
  c.server = c.config?.serverUrl || settingsServer
  // The key: Pigment's setting first, else the file the server setup (or a paste) left on this computer.
  c.teamKey = c.o.teamKey ?? ''
  if (!c.teamKey && c.server) {
    const file = await keyFile($, c)
    if (file && (await $.fs.exists(file).catch(() => false))) c.teamKey = (await $.fs.read(file).catch(() => '')).trim()
  }
  c.status = statusFor(c.config, { serverUrl: settingsServer, teamKey: c.teamKey })
  c.hasServer = c.status === 'cloud'
  c.jiraSite = c.config?.jira?.site || (c.o.jiraSite ?? '')
  c.jiraProject = c.config?.jira?.project || (c.o.jiraProject ?? '')
  c.hasJira = !!(c.jiraSite && c.jiraProject && c.o.jiraEmail && c.o.jiraToken)
}

async function keyFile($: EngineInterface, c: Ctx): Promise<string | null> {
  const home = await $.env.get('HOME')
  const name = keyNameFrom(c.server)
  return home && name ? `${home}/.pigment/keys/${name}.txt` : null
}

/** A pasted key: checked with the server, then kept on this computer only (a file only you can read). */
async function saveKey($: EngineInterface, c: Ctx, text: string) {
  const key = cleanKey(text)
  if (!key) { $.ui.toast("That doesn't look like a team key. It's one long line of letters and numbers."); return }
  const check = await $.http.fetch(`${c.server}/v1/live`, { headers: { authorization: `Bearer ${key}` } }).catch(() => null)
  if (!check) { $.ui.toast("I couldn't reach the team server just now. Nothing was saved; try again in a moment."); return }
  if (check.status === 401) { $.ui.toast("The team server didn't accept that key. Check it with whoever set up the project."); return }
  const name = keyNameFrom(c.server)
  const r = await $.process.run(
    ['sh', '-c', 'umask 077; mkdir -p "$HOME/.pigment/keys" && cat > "$HOME/.pigment/keys/$1.txt"', 'sh', name],
    { stdin: key },
  ).catch(() => null)
  if (!r || r.exitCode !== 0) { $.ui.toast("I couldn't save the key on this computer. Nothing changed."); return }
  await loadConfig($, c)
  const left = await flush($, c)
  await update($, work, (x): Work => ({ ...x, storage: c.status, waiting: left, storageCard: 'hidden' }))
  if (c.role === 'manager') await refreshSprint($, c)
  $.ui.toast(left === 0 ? "Connected. Everything waiting has been sent." : `Connected. ${left} still waiting; I'll keep trying.`)
}

function queueKey(c: Ctx) { return `queue:${c.root}` }

async function loadQueue($: EngineInterface, c: Ctx): Promise<Line[]> {
  return ((await $.store.get(queueKey(c))) as Line[] | undefined) ?? []
}

async function send($: EngineInterface, c: Ctx, path: string, body: unknown): Promise<boolean> {
  if (!c.hasServer) return false
  try {
    const r = await $.http.fetch(`${c.server}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.teamKey}` },
      body: JSON.stringify(body),
    })
    return r.ok
  } catch {
    return false
  }
}

/** Adds lines to this person's local file for the month (read, add, write: there is no append). */
async function appendLocal($: EngineInterface, c: Ctx, lines: Line[]) {
  const byFile = new Map<string, Line[]>()
  for (const l of lines) byFile.set(fileFor(c.person, l.at), [...(byFile.get(fileFor(c.person, l.at)) ?? []), l])
  for (const [rel, ls] of byFile) {
    const path = `${c.root}/${rel}`
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const sep = before === '' || before.endsWith('\n') ? '' : '\n'
    await $.fs.write(path, before + sep + ls.map(l => JSON.stringify(l)).join('\n') + '\n')
  }
}

/** Writes what is waiting to the chosen place; whatever can't go yet keeps waiting. Returns how many still wait. */
async function flush($: EngineInterface, c: Ctx, extra: Line[] = []): Promise<number> {
  const waiting = [...(await loadQueue($, c)), ...extra]
  if (waiting.length === 0) return 0
  let left: Line[] = waiting
  if (c.status === 'local') {
    await appendLocal($, c, waiting)
    left = []
  } else if (c.status === 'cloud') {
    left = []
    for (let i = 0; i < waiting.length; i++) {
      const l = waiting[i]!
      if (!(await send($, c, '/v1/prompt', l))) { left = waiting.slice(i); break }
    }
  }
  await $.store.set(queueKey(c), left)
  return left.length
}

/** The first time this version runs in a project, what the hidden ledger held becomes waiting lines. */
async function migrate($: EngineInterface, c: Ctx) {
  const flag = `migrated:${c.root}`
  if (await $.store.get(flag)) return
  const l = await loadLedger($, c)
  const now = await $.clock.now()
  const lines: Line[] = Object.values(l.tasks).filter(t => t.usd > 0).map(t => ({
    at: t.lastAt || now, session: 'earlier', person: c.person, ticket: t.ticket, usd: t.usd,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, activeMs: t.activeMs ?? 0,
  }))
  await $.store.set(queueKey(c), [...(await loadQueue($, c)), ...lines])
  await $.store.set(flag, true)
}

/** "Just on this computer": a shared config saying so, and a .gitignore that keeps the numbers out of git. */
async function chooseLocal($: EngineInterface, c: Ctx) {
  const config: ProjectConfig = { version: 1, storage: 'local' }
  await $.fs.write(`${c.root}/${CONFIG}`, JSON.stringify(config, null, 2) + '\n')
  await $.fs.write(`${c.root}/.pigment/.gitignore`, '# Pigment: the numbers stay on this computer\n*.jsonl\n')
  await loadConfig($, c)
  const left = await flush($, c)
  await update($, work, (x): Work => ({ ...x, storage: c.status, waiting: left, storageCard: 'hidden' }))
  $.ui.toast('Done. I\'ll keep the numbers in .pigment/ in this project, out of git.')
}

function ledgerKey(c: Ctx) { return `ledger:${c.root}` }

async function loadLedger($: EngineInterface, c: Ctx): Promise<Ledger> {
  return ((await $.store.get(ledgerKey(c))) as Ledger | undefined) ?? emptyLedger()
}

async function branchTicket($: EngineInterface, c: Ctx): Promise<string> {
  const r = await $.process.run(['git', 'branch', '--show-current'], { cwd: c.root }).catch(() => null)
  return r && r.exitCode === 0 ? ticketFrom(r.stdout) : NO_TICKET
}


async function getJson($: EngineInterface, url: string, headers: Record<string, string>): Promise<unknown> {
  const r = await $.http.fetch(url, { headers: { accept: 'application/json', ...headers } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return JSON.parse(r.text) as unknown
}

type JiraSprint = { id: number; name: string; startDate?: string; endDate?: string; issues: SprintIssue[] }

async function sprintIssues($: EngineInterface, c: Ctx, id: number): Promise<SprintIssue[]> {
  const fields = 'summary,status,resolutiondate,timeoriginalestimate'
  const page = (await getJson($, `${jiraBase(c)}/rest/agile/1.0/sprint/${id}/issue?fields=${fields}&expand=changelog&maxResults=200`, jiraAuth(c))) as { issues?: JiraIssue[] }
  return (page.issues ?? []).map(sprintIssue)
}

/** The open sprint's tickets from Jira, or null when there is none or Jira is not set up. */
async function jiraSprint($: EngineInterface, c: Ctx): Promise<JiraSprint | null> {
  const o = c.o
  if (!c.hasJira) return null
  const site = `https://${String(c.jiraSite).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  const auth = { authorization: 'Basic ' + btoa(`${o.jiraEmail}:${o.jiraToken}`) }
  const boards = (await getJson($, `${site}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(c.jiraProject)}`, auth)) as { values?: { id: number }[] }
  for (const b of boards.values ?? []) {
    const sprints = (await getJson($, `${site}/rest/agile/1.0/board/${b.id}/sprint?state=active`, auth).catch(() => ({}))) as { values?: { id: number; name: string; startDate?: string; endDate?: string }[] }
    const s = sprints.values?.[0]
    if (!s) continue
    return { id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate, issues: await sprintIssues($, c, s.id) }
  }
  return null
}

/** One refresh at a time: a caller arriving mid-refresh waits for it, then refreshes again. */
async function refreshSprint($: EngineInterface, c: Ctx): Promise<void> {
  if (c.refreshing) await c.refreshing.catch(() => undefined)
  c.refreshing = doRefresh($, c)
  try { await c.refreshing } finally { c.refreshing = undefined }
}

async function doRefresh($: EngineInterface, c: Ctx) {
  const now = await $.clock.now()
  let note: string | undefined
  let js: JiraSprint | null = null
  try { js = await jiraSprint($, c) } catch { note = "I couldn't reach Jira just now. Showing the last two weeks instead." }
  if (c.hasJira && !js && !note) note = "I can't see an open sprint yet. Costs are still counted by task."

  let costs: TaskCost[]
  let live: LiveSession[]
  let quietPool: LiveSession[] = []
  if (c.hasServer) {
    try {
      const h = { authorization: `Bearer ${c.teamKey}` }
      costs = (await getJson($, `${c.server}/v1/tasks`, h)) as TaskCost[]
      live = (await getJson($, `${c.server}/v1/live`, h)) as LiveSession[]
      quietPool = live
    } catch {
      note = "I couldn't reach the team server just now. I'll try again in a moment."
      const l = await loadLedger($, c)
      costs = Object.values(l.tasks)
      live = Object.values(l.sessions)
    }
  } else if (c.status === 'local') {
    // Every person's files in this project's .pigment folder, plus this computer's live sessions.
    const dir = `${c.root}/.pigment`
    const files = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl')) : []
    const lines = (await Promise.all(files.map(f => $.fs.read(`${dir}/${f.name}`)))).flatMap(parseLines)
    const fromFiles = fromLines([...lines, ...(await loadQueue($, c))])
    costs = fromFiles.tasks
    const mine = Object.values((await loadLedger($, c)).sessions)
    live = [...mine, ...fromFiles.sessions.filter(f => !mine.some(m => m.session === f.session))]
    quietPool = mine // only this computer knows which of its sessions ended
  } else {
    const l = await loadLedger($, c)
    costs = Object.values(l.tasks)
    live = Object.values(l.sessions)
    quietPool = live
  }
  const tasks = sprintRows(costs, js?.issues ?? null, now)
  const next: Sprint = {
    name: js?.name,
    source: js ? 'jira' : 'recent',
    where: c.hasServer ? 'team' : 'this computer',
    tasks,
    total: tasks.reduce((n, t) => n + t.usd, 0),
    live: liveFrom(live, now),
    quiet: quietFrom(quietPool, now),
    updatedAt: now,
    note,
  }
  await update($, sprint, x => ({ ...next, summary: x?.summary }))

  // "Pigment · Sprint 22" while a sprint is open; "Pigment · The sprint" otherwise.
  const title = js?.name ? `Pigment · ${js.name}` : TITLES.manager
  if (title !== c.title) {
    c.title = title
    void $.ui.open({ id: PANE, title })
  }

  // A sprint that was open last time and isn't now has ended: write its summary once.
  if (c.hasJira && !note) {
    const seenKey = `sprintSeen:${c.root}`
    const seen = (await $.store.get(seenKey)) as { id: number; name: string; startDate?: string; endDate?: string } | undefined
    if (seen && seen.id !== js?.id && !(await $.store.get(`summarized:${c.root}:${seen.id}`))) {
      try {
        const ended = sprintRows(costs, await sprintIssues($, c, seen.id), now)
        const path = await writeSummary($, c, seen.name, ended, seen, true)
        await $.store.set(`summarized:${c.root}:${seen.id}`, true)
        $.ui.toast(`${seen.name} has ended. Its summary is in ${path}.`)
      } catch { /* try again next refresh */ }
    }
    if (js) await $.store.set(seenKey, { id: js.id, name: js.name, startDate: js.startDate, endDate: js.endDate })
  }
}

async function beat($: EngineInterface, c: Ctx, w: Work) {
  const now = await $.clock.now()
  if (now - c.lastBeat < HEARTBEAT_MS) return
  c.lastBeat = now
  const l = await loadLedger($, c)
  const s: LiveSession = { session: c.sessionId, person: c.person, ticket: w.ticket, usd: w.sessionUsd, lastAt: now }
  await $.store.set(ledgerKey(c), prune({ ...l, sessions: { ...l.sessions, [c.sessionId]: s } }, now))
  void send($, c, '/v1/heartbeat', s)
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Options
  const server = (o.serverUrl ?? '').trim().replace(/\/+$/, '')
  const teamKey = o.teamKey ?? ''
  const c: Ctx = {
    o,
    role: o.role === 'manager' ? 'manager' : 'developer',
    folder: String(o.projectFolder ?? ''),
    person: (o.person ?? '').trim() || 'me',
    server,
    teamKey,
    hasServer: server !== '' && teamKey !== '',
    hasJira: false,
    root: '',
    sessionId: '',
    lastBeat: 0,
    config: null,
    status: 'unchosen',
    jiraSite: '',
    jiraProject: '',
    lastStatusCheck: 0,
    title: '',
  }
  const role = c.role

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    c.root = await $.session.root()
    c.sessionId = await $.session.id()
    const isMeasured = isInside(c.root, c.folder)
    const ticket = isMeasured ? await branchTicket($, c) : NO_TICKET
    const l = isMeasured ? await loadLedger($, c) : emptyLedger()
    let waiting = 0
    let hidden = false
    const startUsage = isMeasured ? await $.session.usage().catch(() => null) : null
    if (isMeasured) {
      await loadConfig($, c)
      await migrate($, c)
      waiting = await flush($, c)
      hidden = (await $.store.get(`cardHidden:${c.root}:${c.status}`)) === true
    }
    // A reload (the mod changed, or the engine replaced its copy) is the same session: keep its numbers.
    await update($, work, (prev): Work => ({
      ...EMPTY,
      ...(prev.sessionId === c.sessionId ? {
        prompts: prev.prompts, sessionUsd: prev.sessionUsd, hasUnknownPrice: prev.hasUnknownPrice,
        contextPercent: prev.contextPercent, snoozed: prev.snoozedAt === undefined ? [] : prev.snoozed, snoozedAt: prev.snoozedAt, handoffPath: prev.handoffPath,
        lastEndAt: prev.lastEndAt, logOffer: prev.logOffer,
      } : {}),
      sessionId: c.sessionId,
      sessionUsd: prev.sessionId === c.sessionId ? prev.sessionUsd : startUsage?.cost?.usd ?? 0,
      contextPercent: prev.sessionId === c.sessionId ? prev.contextPercent : startUsage?.context.percent,
      isMeasured, folder: c.folder, role, ticket, taskUsd: l.tasks[ticket]?.usd ?? 0,
      storage: c.status, serverUrl: c.server || undefined, waiting,
      storageCard: (c.status === 'unchosen' || c.status === 'cloud-needs-key') && !hidden ? 'ask' : 'hidden',
    }))

    await $.command.register({ name: 'pigment', description: 'Show what your work, your task and the sprint cost' })
    if (isMeasured || role === 'manager') void $.ui.open({ id: PANE, title: TITLES[role] })
    void checkLogOffer($, c, true)
    if (role === 'manager') {
      void refreshSprint($, c)
      $.clock.every(REFRESH_MS, () => void refreshSprint($, c))
    }
    return result
  })

  on('command.run', { command: 'pigment' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLES[role] })
    if (role === 'manager') await refreshSprint($, c)
    return { text: role === 'manager' ? 'The sprint view is open.' : 'Your work view is open.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const w = await read($, work)
    if (w.isMeasured) {
      const now = await $.session.usage()
      const ticket = await branchTicket($, c)
      const label = e.text.replace(/\s+/g, ' ').trim().slice(0, 60) || '(no text)'
      const at = await $.clock.now()
      const l = ticket === w.ticket ? null : await loadLedger($, c)
      await update($, work, x => ({
        ...x, ticket, taskUsd: l ? l.tasks[ticket]?.usd ?? 0 : x.taskUsd,
        pendingUsd: now.cost?.usd ?? x.sessionUsd, pendingLabel: label, pendingAt: at,
      }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result // a subagent's turn belongs to its parent's prompt
    const w = await read($, work)
    if (!w.isMeasured || w.pendingLabel === undefined) return result

    const now = await $.session.usage()
    const total = now.cost?.usd ?? w.sessionUsd
    const u = e.usage
    const endAt = await $.clock.now()
    const row: PromptCost = {
      at: endAt,
      activeMs: activeFor(w.pendingAt ?? endAt, endAt, w.lastEndAt),
      label: w.pendingLabel,
      ticket: w.ticket,
      usd: Math.max(0, total - (w.pendingUsd ?? total)),
      input: u?.input_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
      contextPercent: now.context.percent,
    }
    const l = addPrompt(await loadLedger($, c), row, c.sessionId, c.person, total)
    await $.store.set(ledgerKey(c), prune(l, row.at))
    c.lastBeat = row.at
    const left = await flush($, c, [toLine(row, c.sessionId, c.person)])

    const before = signalsFor(w)
    await update($, work, x => {
      const updated: Work = {
        ...x, sessionUsd: total, taskUsd: l.tasks[row.ticket]?.usd ?? x.taskUsd,
        hasUnknownPrice: now.cost?.hasUnknownPrice === true, contextPercent: now.context.percent,
        prompts: [...x.prompts, row].slice(-200), pendingUsd: undefined, pendingLabel: undefined,
        pendingAt: undefined, lastEndAt: endAt,
        waiting: left,
      }
      const isNew = signalsFor(updated).some(s => !before.includes(s))
      return isNew ? { ...updated, snoozed: [] } : updated
    })
    const after = signalsFor(await read($, work))
    $.ui.status(`${usd(total)} this session`)
    if (after.some(s => !before.includes(s))) {
      $.ui.toast("I've got a suggestion in Pigment, whenever you're ready.")
    }
    if (role === 'manager') void refreshSprint($, c)
    void checkLogOffer($, c)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const w = await read($, work)
    if (w.isMeasured && (e.changed.includes('cost') || e.changed.includes('context'))) {
      await update($, work, x => ({
        ...x,
        sessionUsd: e.cost?.usd ?? x.sessionUsd,
        hasUnknownPrice: e.cost?.hasUnknownPrice === true,
        contextPercent: e.context.percent ?? x.contextPercent,
      }))
      await beat($, c, await read($, work))
    }
    return next(e)
  })

  // A session that closes says so, so the manager view never mistakes it for a quiet one.
  on('session.end', async ($, e, next) => {
    const w = await read($, work)
    if (w.isMeasured && c.sessionId) {
      const now = await $.clock.now()
      const l = await loadLedger($, c)
      const s = l.sessions[c.sessionId]
      if (s) await $.store.set(ledgerKey(c), { ...l, sessions: { ...l.sessions, [c.sessionId]: { ...s, endedAt: now } } })
      void send($, c, '/v1/heartbeat', { session: c.sessionId, person: c.person, ticket: w.ticket, usd: w.sessionUsd, ended: true })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const rows = e.viewport?.rows ?? 30
    const expanded = await read($, open)
    /** Rows one per item; past the first three, a toggle shows the rest. */
    const fold = (key: string, rows: JSX.Element[]) => {
      const isOpen = expanded[key] === true
      return (
        <Box flexDirection="column" gap={1}>
          {isOpen ? rows : rows.slice(0, FIRST)}
          {rows.length > FIRST && (
            <Button key={`fold-${key}`} plain label={isOpen ? 'Show fewer ▴' : `Show ${rows.length - FIRST} more ▾`}
              onPress={() => update($, open, x => ({ ...x, [key]: !isOpen }))} />
          )}
        </Box>
      )
    }

    const stored = await read($, work)
    // The session's own figures, read live: what this conversation has cost and how full it is right now,
    // and how many prompts it has had — not only what this copy of the mod happened to count.
    const live = stored.isMeasured ? await $.session.usage().catch(() => null) : null
    const turns = stored.isMeasured ? await $.session.turns().catch(() => 0) : 0
    const w0: Work = {
      ...stored,
      sessionUsd: live?.cost?.usd ?? stored.sessionUsd,
      contextPercent: live?.context.percent ?? stored.contextPercent,
      hasUnknownPrice: live?.cost?.hasUnknownPrice === true || stored.hasUnknownPrice,
    }
    const promptCount = Math.max(turns, stored.prompts.length)
    const { Raster, Svg } = $.ui.resolve(e) as unknown as {
      Raster?: (p: { key: string; columns: number; rows: number; cells: string }) => JSX.Element
      Svg?: (p: { source: string; alt: string; height?: number; width?: number }) => JSX.Element
    }
    const who = role === 'manager' ? 'Manager' : 'Developer'
    const art = e.surface === 'terminal'
      ? (Raster ? <Raster key="figure" {...figureCells(role)} /> : null)
      : (Svg ? <Svg source={figureSvg(role, 3)} alt={role === 'manager' ? 'A little orange block figure in a black hat, holding a magnifying glass' : 'A little orange block figure behind a laptop'} /> : null)
    // ── Building blocks: cards, a label with its figure on the right, a quiet note ──
    const AMBER = '#e8a86a'
    const card = (children: JSX.Element | (JSX.Element | null | false | undefined)[], color: string = 'subtle') => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={2} paddingY={1} gap={1}>{children}</Box>
    )
    /** A section of the one surface: no border, the sections split by a thin line, as the drawing has it. */
    const section = (children: (JSX.Element | null | false | undefined)[]) => (
      <Box flexDirection="column" gap={1}>{children}</Box>
    )
    const divider = e.surface === 'terminal' || !Svg
      ? <Text dimColor>{'─'.repeat(Math.max(10, Math.min(60, (e.viewport?.columns ?? 40) - 4)))}</Text>
      : <Svg source={'<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1" viewBox="0 0 2000 1" preserveAspectRatio="none"><rect width="2000" height="1" fill="#8a857c" fill-opacity=".35"/></svg>'} alt="" height={1} />
    const stack = (parts: (JSX.Element | null | false | undefined)[]) => {
      const shown = parts.filter(Boolean) as JSX.Element[]
      return <Box flexDirection="column" gap={1}>{shown.flatMap((x, i) => (i === 0 ? [x] : [divider, x]))}</Box>
    }
    const figure = (label: string, value: string, note?: string | null) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" gap={1}>
          <Text dimColor>{label}</Text>
          <Text size="heading" weight="semibold" tabular>{value}</Text>
        </Box>
        {note && <Text dimColor size="footnote">{note}</Text>}
      </Box>
    )
    const item = (left: string, right: string, opts: { note?: string; isMono?: boolean; strong?: boolean; bar?: JSX.Element | null } = {}) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Text mono={opts.isMono} weight={opts.strong ? 'semibold' : 'medium'} wrap="end">{left}</Text>
          {opts.bar && <Box flexGrow={1}>{opts.bar}</Box>}
          <Text dimColor={!opts.strong} weight={opts.strong ? 'semibold' : 'regular'} tabular>{right}</Text>
        </Box>
        {opts.note && <Text dimColor size="footnote" wrap="end">{opts.note}</Text>}
      </Box>
    )
    const heading = (text: string) => <Text dimColor weight="medium">{text}</Text>
    const header = (
      <Box flexDirection="row" gap={2} alignItems="center">
        {art}
        <Box flexDirection="column">
          <Text size="heading" weight="semibold">{who}</Text>
          <Text dimColor>{role === 'manager' ? 'Watching over the sprint' : 'At work on the tasks'}</Text>
        </Box>
      </Box>
    )
    const host = (w0.serverUrl ?? '').replace(/^https?:\/\//, '')
    const setCard = async (storageCard: Work['storageCard']) => {
      // "Not now" holds until something changes (the key arrives, or the storage choice changes).
      if (storageCard === 'hidden') await $.store.set(`cardHidden:${c.root}:${w0.storage}`, true)
      await update($, work, x => ({ ...x, storageCard }))
    }
    const { Input } = $.ui.resolve(e) as unknown as { Input?: (p: { key: string; label?: string; placeholder?: string; submitLabel?: string; onSubmit: (v: string) => void }) => JSX.Element }
    const keyBox = Input
      ? <Input key="team-key" label="Team key" placeholder="Paste the team key here" submitLabel="Connect" onSubmit={v => saveKey($, c, v)} />
      : <Text dimColor>Add it in /config, under Pigment (Team key).</Text>
    let storageCard = null
    if (w0.isMeasured && w0.storageCard !== 'hidden' && w0.storage === 'unchosen') {
      storageCard = w0.storageCard === 'cloud-help' ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
          <Text bold>Keeping the numbers in your cloud</Text>
          <Text dimColor>1. Set up the team server once: Pigment's README, "Set up the team server". Cloudflare's free plan is enough; it takes about five minutes.</Text>
          <Text dimColor>2. Add .pigment/config.json to this project with "storage": "cloud" and the server's address, and commit it. Everyone who opens the project then knows where the numbers go.</Text>
          <Text dimColor>3. Add the team key in /config, under Pigment.</Text>
          <Text dimColor>Until then I keep counting here. Nothing is lost.</Text>
          <Box gap={1}><Button key="storage-back" label="Back" onPress={() => setCard('ask')} /></Box>
        </Box>
      ) : (
        <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
          <Text bold>Where should I keep the numbers?</Text>
          <Text dimColor>In your cloud, they're safe if this computer goes, and a team sees the sprint together. On this computer, they stay in a file in this project and nothing leaves your machine.</Text>
          <Box gap={1}>
            <Button key="storage-local" label="Just on this computer" onPress={() => chooseLocal($, c)} />
            <Button key="storage-cloud" variant="primary" label="In my cloud" onPress={() => setCard('cloud-help')} />
            <Button key="storage-later" label="Not now" onPress={() => setCard('hidden')} />
          </Box>
        </Box>
      )
    } else if (w0.isMeasured && w0.storageCard !== 'hidden' && w0.storage === 'cloud-needs-key' && role === 'manager') {
      storageCard = (
        <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
          <Text bold>Connect to the team server</Text>
          <Text dimColor>The team key is the password your team's numbers are kept under on {host || 'the team server'}. The sprint view needs it to show everyone's work.</Text>
          <Text dimColor>I looked for it on this computer and didn't find it, so the server was probably set up somewhere else. Paste the key from there:</Text>
          {keyBox}
          <Text dimColor>It stays on this computer. Until then I show this computer's numbers{w0.waiting > 0 ? `, and ${w0.waiting} of yours are waiting to be sent` : ''}.</Text>
          <Box gap={1}><Button key="storage-later" label="Not now" onPress={() => setCard('hidden')} /></Box>
        </Box>
      )
    } else if (w0.isMeasured && w0.storageCard !== 'hidden' && w0.storage === 'cloud-needs-key') {
      storageCard = (
        <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
          <Text bold>Developer setup</Text>
          <Text dimColor>This project keeps its numbers on the team server{host ? ` (${host})` : ''}. To join, paste the team key whoever set up the project gave you:</Text>
          {keyBox}
          <Text dimColor>It stays on this computer. I'm counting here meanwhile{w0.waiting > 0 ? ` (${w0.waiting} waiting)` : ''} and will send it all once you're connected.</Text>
          <Box gap={1}><Button key="storage-later" label="Not now" onPress={() => setCard('hidden')} /></Box>
        </Box>
      )
    }

    const signals = signalsFor(w0)
    const grewSince = w0.snoozedAt !== undefined && (w0.contextPercent ?? 0) >= w0.snoozedAt + 10
    const showCard = signals.length > 0 && (grewSince || signals.some(x => !w0.snoozed.includes(x)))
    // The summary takes longer than a press may hold, so the press only starts it.
    const optimize = () => {
      if (w0.isBusy) return
      void update($, work, x => ({ ...x, isBusy: true }))
      $.ui.toast('Writing a short summary of where we are…')
      $.clock.after(0, () => void startFresh($, c, e.surface))
    }
    const label = w0.isBusy ? 'Writing…' : 'Optimize now'
    // When I think it's time: why, with Optimize now and Not now.
    const freshCard = w0.isMeasured && showCard ? card([
      <Text weight="semibold">{reasonText(signals, w0.prompts)}</Text>,
      <Text dimColor>I can write a short summary for you to paste into a new session, and you carry on from there. Nothing is lost.</Text>,
      <Box flexDirection="row" gap={1}>
        <Button key="optimize" variant="primary" label={label} onPress={w0.isBusy ? () => undefined : optimize} />
        <Button key="snooze" label="Not now" onPress={() => update($, work, x => ({ ...x, snoozed: signalsFor({ ...x, contextPercent: w0.contextPercent }), snoozedAt: w0.contextPercent ?? 0 }))} />
      </Box>,
    ], AMBER) : null
    // Otherwise always there: a fresh start whenever the person wants one.
    const freshButton = w0.isMeasured && !showCard ? (
      <Box flexDirection="column" alignItems="stretch" gap={1}>
        <Button key="optimize-anyway" variant="primary" label={label} onPress={w0.isBusy ? () => undefined : optimize} />
        <Box flexDirection="row" justifyContent="center">
          <Text dimColor size="footnote">A short summary to carry on in a fresh session{w0.handoffPath ? ` · last one: ${w0.handoffPath}` : ''}</Text>
        </Box>
      </Box>
    ) : null
    const conversation = w0.contextPercent !== undefined ? `conversation ${Math.round(w0.contextPercent)}% full` : ''
    const footnotes = (lines: string[]) => (
      <Box flexDirection="column" gap={1}>{lines.map(l => <Text dimColor size="footnote">{l}</Text>)}</Box>
    )
    const ESTIMATE = "An estimate at list price. On a plan, it's what it would cost, not what you pay."

    // ── Manager: The sprint ──────────────────────────────────────────
    if (role === 'manager') {
      const s = await read($, sprint)
      if (!s) return <Text dimColor>Gathering the sprint…</Text>
      const now = await $.clock.now()
      const title = s.name ? `${s.name} so far` : 'The last two weeks'
      const doing = inDevelopment(s.tasks, now, s.source === 'jira')
      const look = lookText(s.tasks, now)
      // A small developer figure for each person working right now; they leave when they stop.
      const team = teamNow(s.live, c.sessionId)
      const teamCard = section([
        heading(`Active developers in this project${team.length > 0 ? ` · ${team.length}` : ''}`),
        team.length === 0
          ? <Text dimColor>Nobody else is working right now.</Text>
          : (
            <Box flexDirection="row" flexWrap="wrap" gap={2}>
              {team.map((d, i) => (
                <Box flexDirection="row" gap={1} alignItems="center">
                  {e.surface === 'terminal'
                    ? (Raster ? <Raster key={`dev-${i}`} {...figureCells('developer')} /> : null)
                    : (Svg ? <Svg source={figureSvg('developer', 2)} alt={`${d.person}, working on ${d.ticket}`} /> : null)}
                  <Box flexDirection="column">
                    <Text weight="semibold">{d.person === 'me' ? 'You' : d.person}</Text>
                    <Text dimColor mono size="footnote">{d.ticket}</Text>
                  </Box>
                </Box>
              ))}
            </Box>
          ),
      ])
      const quiet = (s.quiet ?? []).map(q => `${q.person === 'me' ? 'Your' : `${q.person}'s`} session on ${q.ticket} has been quiet for ${duration(now - q.lastAt)}.`)
      const where = s.where === 'team' ? 'the team server' : s.where
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {storageCard}
          {freshCard}
          {stack([
            teamCard,
            section([
              figure(title, usd(s.total), `${s.tasks.length} ${s.tasks.length === 1 ? 'task' : 'tasks'}, counted on ${where}`),
              s.note ? <Text dimColor size="footnote">{s.note}</Text> : null,
              w0.isMeasured ? <Text dimColor size="footnote">This session: {usd(w0.sessionUsd)}{conversation ? `, ${conversation}` : ''}</Text> : null,
            ]),
            s.summary ? card([
              <Text weight="semibold">{s.summary.hasEnded ? `${s.summary.name} has ended` : `${s.summary.name} so far`}</Text>,
              <Text tabular>{usd(s.summary.usd)} · {s.summary.prompts} prompts · {duration(s.summary.activeMs)} worked</Text>,
              <Text dimColor size="footnote">Saved to {s.summary.path}</Text>,
              <Box flexDirection="row" gap={1}>
                <Button key="summary-copy" label="Copy the summary" onPress={async () => {
                  const r = await $.ui.copy({ text: s.summary?.text ?? '', surface: e.surface })
                  $.ui.toast(r.isCopied ? 'Copied.' : `It's in ${s.summary?.path}.`)
                }} />
                <Button key="summary-close" label="Close" onPress={() => update($, sprint, x => (x ? { ...x, summary: undefined } : x))} />
              </Box>,
            ]) : null,
            (look || quiet.length > 0) ? card([
              <Text color="warning" weight="semibold">Worth a look</Text>,
              look ? <Text>{look}</Text> : null,
              quiet.length > 0 ? fold('quiet', quiet.map(q => <Text>{q}</Text>)) : null,
              quiet.length > 0 ? <Text dimColor size="footnote">A quiet session can mean someone is stuck, waiting on an answer, or simply away.</Text> : null,
            ], 'warning') : null,
            section([
              heading(s.source === 'jira' ? 'In development' : 'Worked on lately'),
              doing.length === 0 ? <Text dimColor>Nothing in development right now.</Text> : null,
              doing.length > 0 ? fold('doing', doing.map(t => {
                const time = timeFor(t, now)
                const bar = t.estimateMs && time
                  ? <Progress label={`${t.ticket} time`} value={Math.min(time.elapsedMs / t.estimateMs, 1)} valueText={timeText(t, now)} color={time.look ? 'warning' : 'subtle'} />
                  : null
                return item(t.ticket, timeText(t, now) || 'not started', { note: t.summary, isMono: true, strong: !!time?.look, bar })
              })) : null,
            ]),
            s.tasks.length > 0 ? section([
              heading('By task'),
              fold('tasks', s.tasks.map(t => {
                const time = timeText(t, now)
                return item(t.ticket, usd(t.usd), { note: [t.summary, time].filter(Boolean).join(' · ') || undefined, isMono: true })
              })),
            ]) : null,
            s.live.length > 0 ? section([
              heading(`${s.live.length} ${s.live.length === 1 ? 'session' : 'sessions'} working now`),
              fold('live', s.live.map(l => item(l.ticket, usd(l.usd), {
                note: `${l.person === 'me' ? 'You' : l.person} · ${ago(now - l.lastAt)}`, isMono: true,
              }))),
            ]) : null,
          ])}
          {freshButton}
          {s.tasks.length > 0 && (
            <Box flexDirection="row">
              <Button key="summary-now" label="Write a summary now" onPress={async () => {
                const path = await writeSummary($, c, s.name ?? 'The last two weeks', s.tasks, {}, false)
                $.ui.toast(`Saved to ${path}.`)
              }} />
            </Box>
          )}
          {footnotes(["Time is worked time: each prompt, plus reading and thinking between prompts. Pauses over 15 minutes don't count.", ESTIMATE])}
        </Box>
      )
    }

    // ── Developer: Your work ─────────────────────────────────────────
    const w = w0
    if (!w.isMeasured) {
      return <Text dimColor>This session is outside {w.folder}, so I'm not counting it.</Text>
    }
    const last = w.prompts[w.prompts.length - 1]
    const recent = [...w.prompts].reverse().slice(0, 50)
    const sessionNote = [`${promptCount} ${promptCount === 1 ? 'prompt' : 'prompts'}`, w.hasUnknownPrice ? 'one model priced as another' : '']
      .filter(Boolean).join(', ')
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {storageCard}
        {w.logOffer && card([
          <Text weight="semibold">{w.logOffer.ticket} is in {w.logOffer.status}</Text>,
          <Text>Log the {duration(w.logOffer.ms)} you worked on it in Jira?</Text>,
          <Text dimColor size="footnote">Worked time is time in sessions; pauses over 15 minutes are left out.</Text>,
          <Box flexDirection="row" gap={1}>
            <Button key="log-it" variant="primary" label={w.logOffer.isBusy ? 'Logging…' : 'Log it in Jira'}
              onPress={() => { const o = w.logOffer; return o && !o.isBusy ? logWork($, c, o) : undefined }} />
            <Button key="log-later" label="Not now" onPress={() => update($, work, x => ({ ...x, logOffer: undefined }))} />
          </Box>,
        ], AMBER)}
        {stack([
          figure('This prompt', last ? usd(last.usd) : '—', last ? `${tokens(last.output)} written · ${tokens(last.cacheRead)} read from memory` : null),
          figure(`This task · ${w.ticket}`, usd(w.taskUsd), w.ticket === NO_TICKET ? "This branch isn't named after a ticket, so I'm keeping it apart." : null),
          <Box flexDirection="column" gap={1}>
            {figure('This session', usd(w.sessionUsd))}
            {w.contextPercent !== undefined && <Progress label="Conversation length" value={w.contextPercent / 100} valueText={`${Math.round(w.contextPercent)}% full`} color={AMBER} />}
            <Text dimColor size="footnote">{sessionNote}{conversation ? ` · ${conversation[0]!.toUpperCase()}${conversation.slice(1)}` : ''}</Text>
            {w.storage === 'cloud' && w.waiting > 0 && <Text dimColor size="footnote">{w.waiting} waiting to reach the team server. I'll keep trying.</Text>}
          </Box>,
        ])}
        {freshCard}
        {freshButton}
        {recent.length > 0 && divider}
        {recent.length > 0 && section([heading('Earlier prompts'), fold('prompts', recent.map(p => item(p.label, usd(p.usd))))])}
        {footnotes([ESTIMATE])}
      </Box>
    )
  })
}
