import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, LiveSession, PromptCost, Role, Sprint, TaskCost, Work } from '../types'
import {
  activeFor, addPrompt, ago, duration, emptyLedger, fileFor, fromLines, inDevelopment, isInside, liveFrom, lookText, NO_TICKET, quietFrom, parseConfig, parseLines,
  prune, reasonText, signalsFor, sprintIssue, sprintRows, statusFor, ticketFrom, timeFor, timeText, toLine, tokens, usd,
} from './lib'
import type { JiraIssue, Line, ProjectConfig, SprintIssue, StorageStatus } from './lib'

const PANE = 'pigment'
const TITLES: Record<Role, string> = { developer: 'Your work', manager: 'The sprint' }
const REFRESH_MS = 15_000
const HEARTBEAT_MS = 15_000

const EMPTY: Work = {
  isMeasured: false, folder: '', role: 'developer', ticket: NO_TICKET, sessionUsd: 0, taskUsd: 0,
  hasUnknownPrice: false, prompts: [], snoozed: [], isBusy: false,
  storage: 'unchosen', waiting: 0, storageCard: 'ask',
}
// Bump a tag when its type's fields change: older stored values are read as the initial value.
const work = atom({ plugin: 'pigment', key: 'work' } as const, EMPTY, { shape: 'work-3' })
const sprint = atom({ plugin: 'pigment', key: 'sprint' } as const, null, { shape: 'sprint-2' })

type Options = {
  role?: string; projectFolder?: string; person?: string; serverUrl?: string; teamKey?: string
  jiraSite?: string; jiraEmail?: string; jiraToken?: string; jiraProject?: string
}

const HANDOFF_PROMPT = `Write a handoff note so a fresh session can continue this work without the long history.
Markdown, under 300 words, only facts from this conversation, no tools:
## Goal — the ticket and what "done" means
## Done so far
## In progress right now
## Next steps — numbered, the very next one first
## Decisions and rules to keep
## Files that matter — paths
Answer with the note alone.`

type Ctx = {
  role: Role; folder: string; person: string; server: string; teamKey: string
  hasServer: boolean; hasJira: boolean; o: Options
  root: string; sessionId: string; lastBeat: number
  config: ProjectConfig | null; status: StorageStatus
  jiraSite: string; jiraProject: string
}

const CONFIG = '.pigment/config.json'

/** Reads `.pigment/config.json` (shared with the project) and settles where the numbers go. */
async function loadConfig($: EngineInterface, c: Ctx) {
  const path = `${c.root}/${CONFIG}`
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : null
  c.config = parseConfig(text)
  const settingsServer = (c.o.serverUrl ?? '').trim().replace(/\/+$/, '')
  c.server = c.config?.serverUrl || settingsServer
  c.status = statusFor(c.config, { serverUrl: settingsServer, teamKey: c.teamKey })
  c.hasServer = c.status === 'cloud'
  c.jiraSite = c.config?.jira?.site || (c.o.jiraSite ?? '')
  c.jiraProject = c.config?.jira?.project || (c.o.jiraProject ?? '')
  c.hasJira = !!(c.jiraSite && c.jiraProject && c.o.jiraEmail && c.o.jiraToken)
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

type JiraSprint = { name: string; issues: SprintIssue[] }

/** The open sprint's tickets from Jira, or null when there is none or Jira is not set up. */
async function jiraSprint($: EngineInterface, c: Ctx): Promise<JiraSprint | null> {
  const o = c.o
  if (!c.hasJira) return null
  const site = `https://${String(c.jiraSite).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  const auth = { authorization: 'Basic ' + btoa(`${o.jiraEmail}:${o.jiraToken}`) }
  const boards = (await getJson($, `${site}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(c.jiraProject)}`, auth)) as { values?: { id: number }[] }
  for (const b of boards.values ?? []) {
    const sprints = (await getJson($, `${site}/rest/agile/1.0/board/${b.id}/sprint?state=active`, auth).catch(() => ({}))) as { values?: { id: number; name: string }[] }
    const s = sprints.values?.[0]
    if (!s) continue
    const fields = 'summary,status,resolutiondate,timeoriginalestimate'
    const page = (await getJson($, `${site}/rest/agile/1.0/sprint/${s.id}/issue?fields=${fields}&expand=changelog&maxResults=200`, auth)) as { issues?: JiraIssue[] }
    return { name: s.name, issues: (page.issues ?? []).map(sprintIssue) }
  }
  return null
}

async function refreshSprint($: EngineInterface, c: Ctx) {
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
  await update($, sprint, () => next)
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
    if (isMeasured) {
      await loadConfig($, c)
      await migrate($, c)
      waiting = await flush($, c)
    }
    await update($, work, (): Work => ({
      ...EMPTY, isMeasured, folder: c.folder, role, ticket, taskUsd: l.tasks[ticket]?.usd ?? 0,
      storage: c.status, serverUrl: c.server || undefined, waiting,
      storageCard: c.status === 'unchosen' || c.status === 'cloud-needs-key' ? 'ask' : 'hidden',
    }))

    await $.command.register({ name: 'pigment', description: 'Show what your work, your task and the sprint cost' })
    if (isMeasured || role === 'manager') void $.ui.open({ id: PANE, title: TITLES[role] })
    if (role === 'manager') {
      void refreshSprint($, c)
      $.clock.every(REFRESH_MS, () => void refreshSprint($, c))
    }
    return result
  })

  on('command.run', { command: 'pigment' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLES[role] })
    if (role === 'manager') void refreshSprint($, c)
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
    if (role === 'developer' && after.some(s => !before.includes(s))) {
      $.ui.toast("I've got a suggestion in Your work, whenever you're ready.")
    }
    if (role === 'manager') void refreshSprint($, c)
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
    const width = e.props.bodyColumns ?? 40
    const rows = e.viewport?.rows ?? 30
    const fit = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
    const estimate = <Text dimColor>An estimate at list price. On a plan, it's what it would cost, not what you pay.</Text>

    const w0 = await read($, work)
    const host = (w0.serverUrl ?? '').replace(/^https?:\/\//, '')
    const setCard = (storageCard: Work['storageCard']) => update($, work, x => ({ ...x, storageCard }))
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
    } else if (w0.isMeasured && w0.storageCard !== 'hidden' && w0.storage === 'cloud-needs-key') {
      storageCard = (
        <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
          <Text bold>Developer setup</Text>
          <Text dimColor>This project keeps its numbers in the team's cloud{host ? ` (${host})` : ''}.</Text>
          <Text dimColor>1. Ask whoever set up the project for the team key.</Text>
          <Text dimColor>2. Add it in /config, under Pigment: Team key, and Your name.</Text>
          <Text dimColor>I'm counting here meanwhile{w0.waiting > 0 ? ` (${w0.waiting} waiting)` : ''} and will send it all once the key is in.</Text>
          <Box gap={1}><Button key="storage-later" label="Not now" onPress={() => setCard('hidden')} /></Box>
        </Box>
      )
    }

    // ── Manager: The sprint ──────────────────────────────────────────
    if (role === 'manager') {
      const s = await read($, sprint)
      if (!s) return <Text dimColor>Gathering the sprint…</Text>
      const now = await $.clock.now()
      const heading = s.name ? `${s.name} so far` : 'The last two weeks'
      const doing = inDevelopment(s.tasks, now, s.source === 'jira')
      const look = lookText(s.tasks, now)
      const quiet = (s.quiet ?? []).map(q => `${q.person === 'me' ? 'Your' : `${q.person}'s`} session on ${q.ticket} has been quiet for ${duration(now - q.lastAt)}.`)
      const room = Math.max(3, rows - 18 - s.live.length - doing.length)
      const mark = (t: TaskCost) => {
        const l = timeFor(t, now)?.look
        return l === 'over' ? '!! ' : l === 'near' ? '!  ' : '   '
      }
      return (
        <Box flexDirection="column" gap={1}>
          {storageCard}
          <Box flexDirection="column">
            <Text dimColor>{heading}</Text>
            <Text bold>{usd(s.total)}</Text>
            <Text dimColor>{s.tasks.length} {s.tasks.length === 1 ? 'task' : 'tasks'}, counted on {s.where}</Text>
            {s.note && <Text dimColor>{s.note}</Text>}
          </Box>

          {(look || quiet.length > 0) && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text bold>Worth a look</Text>
              {look && <Text>{look}</Text>}
              {quiet.slice(0, 4).map(q => <Text>{q}</Text>)}
              {quiet.length > 4 && <Text dimColor>{quiet.length - 4} more quiet sessions.</Text>}
              {quiet.length > 0 && <Text dimColor>A quiet session can mean someone is stuck, waiting on an answer, or simply away.</Text>}
            </Box>
          )}

          <Box flexDirection="column">
            <Text dimColor>{s.source === 'jira' ? 'In development' : 'Worked on lately'}</Text>
            {doing.length === 0 && <Text dimColor>Nothing in development right now.</Text>}
            {doing.map(t => (
              <Text bold={!!timeFor(t, now)?.look}>
                {mark(t)}{fit(`${t.ticket} · ${timeText(t, now) || 'not started'}${t.summary ? ` · ${t.summary}` : ''}`, width - 4)}
              </Text>
            ))}
          </Box>

          <Box flexDirection="column">
            <Text dimColor>By task</Text>
            {s.tasks.length === 0 && <Text dimColor>Nothing spent yet. I'll keep count as we go.</Text>}
            {s.tasks.slice(0, room).map(t => {
              const time = timeText(t, now)
              return (
                <Text>
                  {usd(t.usd).padStart(8)}  {fit([t.ticket, time, t.summary].filter(Boolean).join(' · '), width - 11)}
                </Text>
              )
            })}
          </Box>

          <Box flexDirection="column">
            <Text dimColor>
              {s.live.length === 0 ? 'Nobody working right now' : `${s.live.length} ${s.live.length === 1 ? 'session' : 'sessions'} working now`}
            </Text>
            {s.live.map(l => (
              <Text>
                {usd(l.usd).padStart(8)}  {fit(`${l.person} · ${l.ticket} · ${ago(now - l.lastAt)}`, width - 11)}
              </Text>
            ))}
          </Box>
          <Text dimColor>Time is what was worked in sessions: each prompt, plus reading and thinking between prompts. Pauses over 15 minutes don't count.</Text>
          {estimate}
        </Box>
      )
    }

    // ── Developer: Your work ─────────────────────────────────────────
    const w = w0
    if (!w.isMeasured) {
      return <Text dimColor>This session is outside {w.folder}, so I'm not counting it.</Text>
    }
    const signals = signalsFor(w)
    const showCard = signals.length > 0 && signals.some(x => !w.snoozed.includes(x))
    const last = w.prompts[w.prompts.length - 1]
    const recent = [...w.prompts].reverse().slice(0, Math.max(3, rows - (showCard ? 22 : 16)))

    const optimize = async () => {
      await update($, work, x => ({ ...x, isBusy: true }))
      $.ui.toast('Writing a short summary of where we are…')
      const r = await $.model.fork({ prompt: HANDOFF_PROMPT })
      if (!r.isAnswered) {
        await update($, work, x => ({ ...x, isBusy: false }))
        $.ui.toast("I couldn't write the summary this time. Nothing changed; try again in a moment.")
        return
      }
      const stamp = new Date(await $.clock.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')
      const rel = `.claude/handoffs/${stamp}.md`
      await $.fs.write(`${c.root}/${rel}`, r.text)
      await $.ui.copy({ text: r.text, surface: e.surface })
      await $.prompt.fill({
        text: `Let's continue in a fresh session. Start a new session from the handoff in ${rel} and pick up its next step.`,
      })
      await update($, work, x => ({ ...x, isBusy: false, handoffPath: rel, snoozed: signalsFor(x) }))
      $.ui.toast('Summary saved and copied. Send the message in the box and we start fresh.')
    }

    return (
      <Box flexDirection="column" gap={1}>
        {storageCard}
        <Box flexDirection="column">
          <Text dimColor>This prompt</Text>
          <Text bold>{last ? usd(last.usd) : '—'}</Text>
          {last && <Text dimColor>{tokens(last.output)} written, {tokens(last.cacheRead)} read from memory</Text>}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>This task · {w.ticket}</Text>
          <Text bold>{usd(w.taskUsd)}</Text>
          {w.ticket === NO_TICKET && <Text dimColor>This branch isn't named after a ticket, so I'm keeping it apart.</Text>}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>This session</Text>
          <Text bold>{usd(w.sessionUsd)}</Text>
          <Text dimColor>{w.prompts.length} {w.prompts.length === 1 ? 'prompt' : 'prompts'}{w.hasUnknownPrice ? ', one model priced as another' : ''}</Text>
          {w.storage === 'cloud' && w.waiting > 0 && <Text dimColor>{w.waiting} waiting to reach the team server. I'll keep trying.</Text>}
        </Box>

        {w.contextPercent !== undefined && <Progress label="Conversation length" value={w.contextPercent / 100} />}

        {showCard && (
          <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
            <Text>{reasonText(signals, w.prompts)}</Text>
            <Text dimColor>I can write a short summary and start fresh with you. Nothing is lost.</Text>
            <Box gap={1}>
              <Button key="optimize" variant="primary" label={w.isBusy ? 'Writing…' : 'Optimize now'} onPress={w.isBusy ? () => undefined : optimize} />
              <Button key="snooze" label="Not now" onPress={() => update($, work, x => ({ ...x, snoozed: signalsFor(x) }))} />
            </Box>
          </Box>
        )}
        {w.handoffPath && !showCard && <Text dimColor>Last summary: {w.handoffPath}</Text>}

        <Box flexDirection="column">
          <Text dimColor>Earlier prompts</Text>
          {recent.length === 0 && <Text dimColor>Nothing spent yet. I'll keep count as we go.</Text>}
          {recent.map(p => <Text>{usd(p.usd).padStart(8)}  {fit(p.label, width - 11)}</Text>)}
        </Box>
        {estimate}
      </Box>
    )
  })
}
