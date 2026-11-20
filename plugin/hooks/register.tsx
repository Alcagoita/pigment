import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, LiveSession, PromptCost, Role, Sprint, TaskCost, Work } from '../types'
import {
  addPrompt, ago, emptyLedger, isInside, liveFrom, NO_TICKET, prune, reasonText,
  signalsFor, sprintRows, ticketFrom, tokens, usd,
} from './lib'

const PANE = 'pigment'
const TITLES: Record<Role, string> = { developer: 'Your work', manager: 'The sprint' }
const REFRESH_MS = 15_000
const HEARTBEAT_MS = 15_000

const EMPTY: Work = {
  isMeasured: false, folder: '', role: 'developer', ticket: NO_TICKET, sessionUsd: 0, taskUsd: 0,
  hasUnknownPrice: false, prompts: [], snoozed: [], isBusy: false,
}
// Bump a tag when its type's fields change: older stored values are read as the initial value.
const work = atom({ plugin: 'pigment', key: 'work' } as const, EMPTY, { shape: 'work-1' })
const sprint = atom({ plugin: 'pigment', key: 'sprint' } as const, null, { shape: 'sprint-1' })

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
}

function ledgerKey(c: Ctx) { return `ledger:${c.root}` }

async function loadLedger($: EngineInterface, c: Ctx): Promise<Ledger> {
  return ((await $.store.get(ledgerKey(c))) as Ledger | undefined) ?? emptyLedger()
}

async function branchTicket($: EngineInterface, c: Ctx): Promise<string> {
  const r = await $.process.run(['git', 'branch', '--show-current'], { cwd: c.root }).catch(() => null)
  return r && r.exitCode === 0 ? ticketFrom(r.stdout) : NO_TICKET
}

function post($: EngineInterface, c: Ctx, path: string, body: unknown) {
  if (!c.hasServer) return
  void $.http.fetch(`${c.server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.teamKey}` },
    body: JSON.stringify(body),
  }).catch(() => undefined)
}

async function getJson($: EngineInterface, url: string, headers: Record<string, string>): Promise<unknown> {
  const r = await $.http.fetch(url, { headers: { accept: 'application/json', ...headers } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return JSON.parse(r.text) as unknown
}

type JiraSprint = { name: string; issues: { key: string; summary?: string }[] }

/** The open sprint's tickets from Jira, or null when there is none or Jira is not set up. */
async function jiraSprint($: EngineInterface, c: Ctx): Promise<JiraSprint | null> {
  const o = c.o
  if (!c.hasJira) return null
  const site = `https://${String(o.jiraSite).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  const auth = { authorization: 'Basic ' + btoa(`${o.jiraEmail}:${o.jiraToken}`) }
  const boards = (await getJson($, `${site}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(String(o.jiraProject))}`, auth)) as { values?: { id: number }[] }
  for (const b of boards.values ?? []) {
    const sprints = (await getJson($, `${site}/rest/agile/1.0/board/${b.id}/sprint?state=active`, auth).catch(() => ({}))) as { values?: { id: number; name: string }[] }
    const s = sprints.values?.[0]
    if (!s) continue
    const page = (await getJson($, `${site}/rest/agile/1.0/sprint/${s.id}/issue?fields=summary&maxResults=200`, auth)) as { issues?: { key: string; fields?: { summary?: string } }[] }
    return { name: s.name, issues: (page.issues ?? []).map(i => ({ key: i.key, summary: i.fields?.summary })) }
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
  if (c.hasServer) {
    try {
      const h = { authorization: `Bearer ${c.teamKey}` }
      costs = (await getJson($, `${c.server}/v1/tasks`, h)) as TaskCost[]
      live = (await getJson($, `${c.server}/v1/live`, h)) as LiveSession[]
    } catch {
      note = "I couldn't reach the team server just now. I'll try again in a moment."
      const l = await loadLedger($, c)
      costs = Object.values(l.tasks)
      live = Object.values(l.sessions)
    }
  } else {
    const l = await loadLedger($, c)
    costs = Object.values(l.tasks)
    live = Object.values(l.sessions)
  }
  const tasks = sprintRows(costs, js?.issues ?? null, now)
  const next: Sprint = {
    name: js?.name,
    source: js ? 'jira' : 'recent',
    where: c.hasServer ? 'team' : 'this computer',
    tasks,
    total: tasks.reduce((n, t) => n + t.usd, 0),
    live: liveFrom(live, now),
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
  post($, c, '/v1/heartbeat', s)
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
    hasJira: !!(o.jiraSite && o.jiraEmail && o.jiraToken && o.jiraProject),
    root: '',
    sessionId: '',
    lastBeat: 0,
  }
  const role = c.role

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    c.root = await $.session.root()
    c.sessionId = await $.session.id()
    const isMeasured = isInside(c.root, c.folder)
    const ticket = isMeasured ? await branchTicket($, c) : NO_TICKET
    const l = isMeasured ? await loadLedger($, c) : emptyLedger()
    await update($, work, () => ({ ...EMPTY, isMeasured, folder: c.folder, role, ticket, taskUsd: l.tasks[ticket]?.usd ?? 0 }))

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
      const l = ticket === w.ticket ? null : await loadLedger($, c)
      await update($, work, x => ({
        ...x, ticket, taskUsd: l ? l.tasks[ticket]?.usd ?? 0 : x.taskUsd,
        pendingUsd: now.cost?.usd ?? x.sessionUsd, pendingLabel: label,
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
    const row: PromptCost = {
      at: await $.clock.now(),
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
    post($, c, '/v1/prompt', { ...row, session: c.sessionId, person: c.person })

    const before = signalsFor(w)
    await update($, work, x => {
      const updated: Work = {
        ...x, sessionUsd: total, taskUsd: l.tasks[row.ticket]?.usd ?? x.taskUsd,
        hasUnknownPrice: now.cost?.hasUnknownPrice === true, contextPercent: now.context.percent,
        prompts: [...x.prompts, row].slice(-200), pendingUsd: undefined, pendingLabel: undefined,
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 40
    const rows = e.viewport?.rows ?? 30
    const fit = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
    const estimate = <Text dimColor>An estimate at list price. On a plan, it's what it would cost, not what you pay.</Text>

    // ── Manager: The sprint ──────────────────────────────────────────
    if (role === 'manager') {
      const s = await read($, sprint)
      if (!s) return <Text dimColor>Gathering the sprint…</Text>
      const now = await $.clock.now()
      const heading = s.name ? `${s.name} so far` : 'The last two weeks'
      const room = Math.max(3, rows - 14 - s.live.length)
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text dimColor>{heading}</Text>
            <Text bold>{usd(s.total)}</Text>
            <Text dimColor>{s.tasks.length} {s.tasks.length === 1 ? 'task' : 'tasks'}, counted on {s.where}</Text>
            {s.note && <Text dimColor>{s.note}</Text>}
          </Box>

          <Box flexDirection="column">
            <Text dimColor>By task</Text>
            {s.tasks.length === 0 && <Text dimColor>Nothing spent yet. I'll keep count as we go.</Text>}
            {s.tasks.slice(0, room).map(t => (
              <Text>
                {usd(t.usd).padStart(8)}  {fit(t.summary ? `${t.ticket} · ${t.summary}` : t.ticket, width - 11)}
              </Text>
            ))}
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
          {estimate}
        </Box>
      )
    }

    // ── Developer: Your work ─────────────────────────────────────────
    const w = await read($, work)
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
