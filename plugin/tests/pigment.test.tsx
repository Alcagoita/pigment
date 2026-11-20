import { expect, mock, test } from 'claude-code/testing'

import { activeFor, addPrompt, duration, isLogStatus, jiraStarted, summaryMarkdown, worklogSeconds, emptyLedger, inDevelopment, isInside, liveFrom, lookText, NO_TICKET, signalsFor, sprintIssue, sprintRows, ticketFrom, timeFor, timeText, quietFrom, teamNow } from '../hooks/lib'
import { figureCells, figureSvg } from '../hooks/figures'
import { continueMessage } from '../hooks/register'
import type { PromptCost } from '../types'

const pane = (title: string) => ({
  plugin: 'pigment',
  component: 'Pane',
  requestId: 'pigment',
  props: { title, isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const

const row = (ticket: string, usd: number, at = 1): PromptCost => ({
  at, label: 'x', ticket, usd, input: 100, output: 50, cacheRead: 5_000, cacheWrite: 0, activeMs: 60_000,
})

test('a branch names its ticket', () => {
  expect(ticketFrom('KAN-55-invite-link\n')).toBe('KAN-55')
  expect(ticketFrom('feature/KAN-88-share')).toBe('KAN-88')
  expect(ticketFrom('12-invite')).toBe('#12')
  expect(ticketFrom('develop')).toBe(NO_TICKET)
  expect(ticketFrom('release/1.2.0')).toBe(NO_TICKET)
  expect(isInside('/w/app/x', '/w/app')).toBe(true)
  expect(isInside('/w/apple', '/w/app')).toBe(false)
})

test('task totals add up across sessions; the sprint lists its tickets', () => {
  let l = emptyLedger()
  l = addPrompt(l, row('KAN-55', 4, 10), 's1', 'Ana', 4)
  l = addPrompt(l, row('KAN-55', 6, 20), 's2', 'Ana', 6)
  l = addPrompt(l, row('KAN-88', 33, 30), 's3', 'Rui', 33)
  l = addPrompt(l, row(NO_TICKET, 2, 40), 's3', 'Rui', 35)
  expect(l.tasks['KAN-55']?.usd).toBe(10)
  const rows = sprintRows(Object.values(l.tasks), [{ key: 'KAN-55', summary: 'Invite link' }, { key: 'KAN-88' }, { key: 'KAN-90' }], 50)
  expect(rows.map(r => [r.ticket, r.usd])).toEqual([['KAN-88', 33], ['KAN-55', 10], [NO_TICKET, 2], ['KAN-90', 0]])
  expect(liveFrom(Object.values(l.sessions), 40 + 11 * 60_000)).toEqual([])
  expect(signalsFor({ contextPercent: 70, prompts: [] })).toEqual(['long'])
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: any[]) => any>>[1]

function engine(on: TestOn, branch: string, cost: { usd: number; percent: number }, files = new Map<string, string>(), posts: string[] = [], opts: { now?: number; fetch?: (url: string, body?: string) => unknown; runs?: { argv: string[]; stdin?: string }[]; ownClock?: boolean } = {}) {
  const store = new Map<string, unknown>()
  on('env.get', (_, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/home/t' : undefined }))
  on('fs.exists', (_, e) => { const p = (e as unknown as { path: string }).path; return { value: files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')) } })
  on('fs.read', (_, e) => ({ value: files.get((e as unknown as { path: string }).path) ?? '' }))
  on('fs.write', (_, e) => { const a = e as unknown as { path: string; text: string }; files.set(a.path, a.text); return { value: undefined } })
  on('fs.list', (_, e) => {
    const dir = (e as unknown as { path: string }).path + '/'
    const names = [...files.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map(k => k.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('http.fetch', (_, e) => {
    const a = e as unknown as { url: string; init?: { body?: string } }
    if (opts.fetch) { posts.push(a.url + ' ' + (a.init?.body ?? '')); return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(opts.fetch(a.url, a.init?.body)) } } }
    posts.push(a.url + ' ' + (a.init?.body ?? ''))
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('command.register', () => ({ value: { command: 'pigment' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, percent: cost.percent }, cost: { usd: cost.usd } } }))
  if (!opts.ownClock) on('clock.now', () => ({ value: opts.now ?? 1_000_000 }))
  if (!opts.ownClock) on('clock.every', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e as unknown as { argv: string[]; init?: { stdin?: string } }
    if (a.argv[0] === 'sh') {
      opts.runs?.push({ argv: a.argv, stdin: a.init?.stdin })
      files.set('/home/t/.pigment/keys/' + a.argv[a.argv.length - 1] + '.txt', a.init?.stdin ?? '')
    }
    return { value: { exitCode: 0, stdout: branch + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', (_, e) => ({ value: store.get((e as unknown as { key: string }).key) }))
  on('store.set', (_, e) => { const a = e as unknown as { key: string; value: unknown }; store.set(a.key, a.value); return { value: undefined } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return store
}

const finish = { reason: 'answer', answer: 'Done.', durationMs: 5, isInterrupted: false, turnId: 't1',
  usage: { input_tokens: 1_000, output_tokens: 400, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000, model: 'm' } } as never

test('Your work: this prompt, this task and this session', async ($, on) => {
  const cost = { usd: 0.5, percent: 30 }
  engine(on, 'KAN-55-invite-link', cost)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Add the invite link' } as never)
  cost.usd = 0.62
  await $.turn.complete(finish)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface })
    expect(await ui.find({ type: 'Text', text: /^This task · KAN-55$/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^\$0\.12$/ }))?.text).toBe('$0.12')
    expect((await ui.find({ type: 'Text', text: /^\$0\.62$/ }))?.text).toBe('$0.62')
    expect(await ui.find({ type: 'Button', key: 'optimize' })).toBeFalsy()
    await ui.unmount()
  }
})

test('The sprint: by task and working now, on this computer', { options: { role: 'manager' } }, async ($, on) => {
  const cost = { usd: 1, percent: 30 }
  engine(on, 'KAN-88-share', cost)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Share sheet' } as never)
  cost.usd = 4
  await $.turn.complete(finish)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface })
    expect(await ui.find({ type: 'Text', text: /The last two weeks/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\$3\.00 · KAN-88$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 session working now/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^You · just now$/ })).toBeTruthy()
    await ui.unmount()
  }
})


test('first run asks where to keep the numbers; "Just on this computer" writes the project files', async ($, on) => {
  const cost = { usd: 0, percent: 10 }
  const files = new Map<string, string>()
  engine(on, 'KAN-55-invite', cost, files)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'First' } as never)
  cost.usd = 0.3
  await $.turn.complete(finish)

  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Where should I keep the numbers/ })).toBeTruthy()
  await ui.press({ key: 'storage-local' })
  expect(JSON.parse(files.get('/work/app/.pigment/config.json') ?? '{}').storage).toBe('local')
  expect(files.get('/work/app/.pigment/.gitignore')).toMatch(/\*\.jsonl/)
  const month = [...files.keys()].find(k => k.endsWith('.jsonl'))
  expect(month).toMatch(/\/work\/app\/\.pigment\/me-\d{4}-\d{2}\.jsonl$/)
  const line = JSON.parse((files.get(month!) ?? '').trim())
  expect(line.ticket).toBe('KAN-55')
  expect(Math.round(line.usd * 100)).toBe(30)
  expect('label' in line).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Where should I keep the numbers/ })).toBeFalsy()
  await ui.unmount()
})

test('a developer joining a cloud project sees Developer setup and counts meanwhile', async ($, on) => {
  const cost = { usd: 0, percent: 10 }
  const files = new Map([['/work/app/.pigment/config.json', JSON.stringify({ version: 1, storage: 'cloud', serverUrl: 'https://pigment.team.example' })]])
  const posts: string[] = []
  engine(on, 'KAN-90-x', cost, files, posts)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Hi' } as never)
  cost.usd = 0.2
  await $.turn.complete(finish)

  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Developer setup$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /pigment\.team\.example/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 waiting/ })).toBeTruthy()
  expect(posts.length).toBe(0)
  await ui.unmount()
})

test('with the team key, prompts go to the team server, waiting ones first', { options: { teamKey: 'k3y', person: 'Ana' } }, async ($, on) => {
  const cost = { usd: 0, percent: 10 }
  const files = new Map([['/work/app/.pigment/config.json', JSON.stringify({ version: 1, storage: 'cloud', serverUrl: 'https://pigment.team.example/' })]])
  const posts: string[] = []
  engine(on, 'KAN-90-x', cost, files, posts)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Hi' } as never)
  cost.usd = 0.2
  await $.turn.complete(finish)
  const prompts = posts.filter(p => p.startsWith('https://pigment.team.example/v1/prompt '))
  expect(prompts.length).toBe(1)
  const body = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf(' ') + 1))
  expect(body.person).toBe('Ana')
  expect(body.ticket).toBe('KAN-90')
  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Developer setup|Where should I keep/ })).toBeFalsy()
  await ui.unmount()
})

test('time per task is worked time; near and over its estimate; active time and quiet sessions', () => {
  const H = 3_600_000
  const now = 100 * H
  // Worked time, not the clock: KAN-045 started 3 days ago but has 5h of work in it.
  const t045 = { ticket: 'KAN-045', usd: 4, prompts: 3, lastAt: now, startedAt: now - 72 * H, activeMs: 5 * H, estimateMs: 6 * H, stage: 'doing' as const }
  const t96 = { ticket: 'KAN-96', usd: 1, prompts: 1, lastAt: now, activeMs: 2 * H, stage: 'doing' as const }
  const t12 = { ticket: 'KAN-12', usd: 2, prompts: 2, lastAt: now, activeMs: 3 * H, doneAt: now - 27 * H, estimateMs: 2 * H, stage: 'done' as const }
  const late = { ticket: 'KAN-50', usd: 0, prompts: 0, lastAt: 0, activeMs: 7 * H, estimateMs: 6 * H, stage: 'doing' as const }

  expect(timeText(t045, now)).toBe('5h of 6h')
  expect(timeFor(t045, now)?.look).toBe('near')
  expect(timeText(t96, now)).toBe('2h')
  expect(timeFor(t96, now)?.look).toBe(null)
  expect(timeText(t12, now)).toBe('3h worked, done')
  expect(timeFor(t12, now)?.look).toBe(null) // done tasks never need a look
  expect(timeFor(late, now)?.look).toBe('over')
  expect(lookText([t045, t96], now)).toBe('KAN-045 has used 5h of its 6h.')
  expect(lookText([late, t045], now)).toBe('KAN-50 has gone past its 6h: 7h so far. 1 more task needs a look too.')
  expect(inDevelopment([t96, t12, t045, late], now, true).map(t => t.ticket)).toEqual(['KAN-50', 'KAN-045', 'KAN-96'])
  // Active time: the turn, plus a short gap before it; a long pause doesn't count.
  const M = 60_000
  expect(activeFor(10 * M, 14 * M, 5 * M)).toBe(9 * M)
  expect(activeFor(100 * M, 104 * M, 5 * M)).toBe(4 * M)
  expect(activeFor(10 * M, 14 * M, undefined)).toBe(4 * M)
  // Quiet: open and silent 45m+, but not forgotten for 12h; closed sessions never.
  const s = (id: string, lastAt: number, endedAt?: number) => ({ session: id, person: 'Ana', ticket: 'KAN-045', usd: 1, lastAt, endedAt })
  expect(quietFrom([s('a', now - 80 * M), s('b', now - 5 * M), s('c', now - 80 * M, now - 70 * M), s('d', now - 13 * H)], now).map(x => x.session)).toEqual(['a'])
  expect(duration(45 * 60_000)).toBe('45m')
  expect(duration(2 * H + 10 * 60_000)).toBe('2h 10m')
  expect(duration(76 * H)).toBe('3d 4h')
})

test('Jira: started when it first moved, done when resolved, estimate in ms', () => {
  const i = sprintIssue({
    key: 'KAN-045',
    fields: { summary: 'Invite link', status: { statusCategory: { key: 'indeterminate' } }, resolutiondate: null, timeoriginalestimate: 21_600 },
    changelog: { histories: [
      { created: '2026-11-20T10:00:00.000Z', items: [{ field: 'assignee' }] },
      { created: '2026-11-20T09:00:00.000Z', items: [{ field: 'status' }] },
    ] },
  })
  expect(i.startedAt).toBe(Date.parse('2026-11-20T09:00:00.000Z'))
  expect(i.doneAt).toBe(undefined)
  expect(i.estimateMs).toBe(6 * 3_600_000)
  expect(i.stage).toBe('doing')
  const d = sprintIssue({ key: 'KAN-1', fields: { status: { statusCategory: { key: 'done' } }, resolutiondate: '2026-11-21T12:00:00.000Z' } })
  expect(d.stage).toBe('done')
  expect(d.doneAt).toBe(Date.parse('2026-11-21T12:00:00.000Z'))
})

test('The sprint with Jira: In development with time, and Worth a look', {
  options: { role: 'manager', jiraSite: 'team.atlassian.net', jiraProject: 'KAN', jiraEmail: 'm@example.com', jiraToken: 't' },
}, async ($, on) => {
  const H = 3_600_000
  const NOW = 1_000_000_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const cost = { usd: 0, percent: 10 }
  const store = engine(on, 'develop', cost, new Map(), [], { now: NOW, fetch: url =>
    url.includes('/board?') ? { values: [{ id: 7 }] }
      : url.includes('/sprint?state=active') ? { values: [{ id: 22, name: 'Sprint 22' }] }
      : { issues: [
          { key: 'KAN-045', fields: { summary: 'Invite link', status: { statusCategory: { key: 'indeterminate' } }, timeoriginalestimate: 6 * 3600 },
            changelog: { histories: [{ created: iso(NOW - 5 * H), items: [{ field: 'status' }] }] } },
          { key: 'KAN-96', fields: { summary: 'Share sheet', status: { statusCategory: { key: 'indeterminate' } } },
            changelog: { histories: [{ created: iso(NOW - 2 * H), items: [{ field: 'status' }] }] } },
          { key: 'KAN-10', fields: { summary: 'Later', status: { statusCategory: { key: 'new' } } } },
        ] } })
  store.set('migrated:/work/app', true)
  store.set('ledger:/work/app', {
    tasks: {
      'KAN-045': { ticket: 'KAN-045', usd: 10, prompts: 9, lastAt: NOW - 80 * 60_000, activeMs: 5 * H },
      'KAN-96': { ticket: 'KAN-96', usd: 3, prompts: 4, lastAt: NOW, activeMs: 2 * H },
    },
    sessions: { 'old': { session: 'old', person: 'me', ticket: 'KAN-045', usd: 10, lastAt: NOW - 80 * 60_000 } },
  })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pigment', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface })
    expect(await ui.find({ type: 'Text', text: /^Sprint 22 so far$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^KAN-045 has used 5h of its 6h\.$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^In development$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^!  KAN-045 · 5h of 6h$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^   Invite link$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^   KAN-96 · 2h$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /KAN-10 · not started/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^Your session on KAN-045 has been quiet for 1h 20m\.$/ })).toBeTruthy()
    await ui.unmount()
  }
})


test('worklog and summary helpers', () => {
  expect(isLogStatus('testing', 'indeterminate', 'Testing')).toBe(true)
  expect(isLogStatus('In Development', 'indeterminate', 'Testing')).toBe(false)
  expect(isLogStatus('Concluído', 'done', 'Testing')).toBe(true)
  expect(jiraStarted(Date.UTC(2026, 10, 20, 9, 30))).toBe('2026-11-20T09:30:00.000+0000')
  expect(worklogSeconds(5 * 3_600_000 + 10 * 60_000 + 20_000)).toBe(18_600)
  expect(worklogSeconds(10_000)).toBe(60)
  const H = 3_600_000
  const sum = summaryMarkdown('Sprint 21', [
    { ticket: 'KAN-55', summary: 'Invite | link', usd: 10, prompts: 30, lastAt: 0, activeMs: 5 * H, estimateMs: 6 * H, stage: 'done' },
    { ticket: 'KAN-88', usd: 33.1, prompts: 90, lastAt: 0, activeMs: 26 * H, stage: 'doing' },
  ], { startDate: '2026-11-03T09:00:00.000Z', endDate: '2026-11-17T18:00:00.000Z', hasEnded: true, writtenAt: Date.UTC(2026, 10, 18) })
  expect(Math.round(sum.usd * 100)).toBe(4310)
  expect(sum.prompts).toBe(120)
  expect(sum.activeMs).toBe(31 * H)
  expect(sum.text).toMatch(/^# Sprint 21\n/)
  expect(sum.text).toMatch(/- \*\*Cost:\*\* \$43\.10/)
  expect(sum.text).toMatch(/- \*\*Worked time:\*\* 1d 7h/)
  expect(sum.text).toMatch(/\| KAN-88 \|  \| \$33\.10 \| 90 \| 1d 2h \|  \| in development \|/)
  expect(sum.text).toMatch(/\| KAN-55 \| Invite \/ link \| \$10\.00 \| 30 \| 5h \| 6h \| done \|/)
})

test('a task in Testing: offer to log the worked time, then log it in Jira', {
  options: { jiraSite: 'team.atlassian.net', jiraEmail: 'ana@example.com', jiraToken: 't' },
}, async ($, on) => {
  const posts: string[] = []
  const store = engine(on, 'KAN-55-invite', { usd: 0, percent: 10 }, new Map(), posts, {
    now: Date.UTC(2026, 10, 20, 18),
    fetch: url => (url.endsWith('/issue/KAN-55?fields=status') ? { fields: { status: { name: 'Testing', statusCategory: { key: 'indeterminate' } } } } : {}),
  })
  store.set('migrated:/work/app', true)
  store.set('ledger:/work/app', { tasks: { 'KAN-55': { ticket: 'KAN-55', usd: 4, prompts: 10, lastAt: 0, activeMs: 5 * 3_600_000 + 10 * 60_000 } }, sessions: {} })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^KAN-55 is in Testing$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Log the 5h 10m you worked on it in Jira\?$/ })).toBeTruthy()
  await ui.press({ key: 'log-it' })
  const log = posts.find(p => p.includes('/rest/api/3/issue/KAN-55/worklog '))
  expect(log).toBeTruthy()
  const body = JSON.parse(log!.slice(log!.indexOf(' ') + 1))
  expect(body.timeSpentSeconds).toBe(18_600)
  expect(store.get('logged:/work/app:KAN-55')).toBe(5 * 3_600_000 + 10 * 60_000)
  expect(await ui.find({ type: 'Text', text: /is in Testing/ })).toBeFalsy()
  await ui.unmount()
})

test('when the open sprint changes, the ended one gets its summary file', {
  options: { role: 'manager', jiraSite: 'team.atlassian.net', jiraProject: 'KAN', jiraEmail: 'm@example.com', jiraToken: 't' },
}, async ($, on) => {
  const files = new Map<string, string>()
  const store = engine(on, 'develop', { usd: 0, percent: 10 }, files, [], {
    now: Date.UTC(2026, 10, 18, 9),
    fetch: url => url.includes('/board?') ? { values: [{ id: 7 }] }
      : url.includes('/sprint?state=active') ? { values: [{ id: 22, name: 'Sprint 22' }] }
      : url.includes('/sprint/21/issue') ? { issues: [{ key: 'KAN-55', fields: { summary: 'Invite link', status: { statusCategory: { key: 'done' } }, resolutiondate: '2026-11-15T10:00:00.000Z' } }] }
      : { issues: [] },
  })
  store.set('migrated:/work/app', true)
  store.set('ledger:/work/app', { tasks: { 'KAN-55': { ticket: 'KAN-55', usd: 10, prompts: 30, lastAt: 0, activeMs: 5 * 3_600_000 } }, sessions: {} })
  store.set('sprintSeen:/work/app', { id: 21, name: 'Sprint 21', startDate: '2026-11-03T09:00:00.000Z', endDate: '2026-11-17T18:00:00.000Z' })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pigment', args: '' } as never)

  const md = files.get('/work/app/.pigment/sprints/sprint-21.md') ?? ''
  expect(md).toMatch(/^# Sprint 21\n/)
  expect(md).toMatch(/\$10\.00/)
  expect(store.get('summarized:/work/app:21')).toBe(true)
  const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Sprint 21 has ended$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\$10\.00 · 30 prompts · 5h worked$/ })).toBeTruthy()
  await ui.unmount()
})


test('long lists show three rows, then Show more', { options: { role: 'manager' } }, async ($, on) => {
  const store = engine(on, 'develop', { usd: 0, percent: 10 })
  store.set('migrated:/work/app', true)
  const tasks = Object.fromEntries([1, 2, 3, 4, 5].map(n => [`KAN-${n}`, { ticket: `KAN-${n}`, usd: n, prompts: 1, lastAt: 1_000_000, activeMs: 60_000 * n }]))
  store.set('ledger:/work/app', { tasks, sessions: {} })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pigment', args: '' } as never)
  const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^\$1\.00 · KAN-1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\$5\.00 · KAN-5/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'fold-tasks' })).toBeTruthy()
  await ui.press({ key: 'fold-tasks' })
  expect(await ui.find({ type: 'Text', text: /^\$5\.00 · KAN-5/ })).toBeTruthy()
  await ui.unmount()
})

test('a manager without the key sees Connect to the team server, not Developer setup', { options: { role: 'manager' } }, async ($, on) => {
  const files = new Map([['/work/app/.pigment/config.json', JSON.stringify({ version: 1, storage: 'cloud', serverUrl: 'https://pigment.team.example' })]])
  engine(on, 'develop', { usd: 0, percent: 10 }, files)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pigment', args: '' } as never)
  const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Connect to the team server$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Developer setup$/ })).toBeFalsy()
  await ui.unmount()
})

test('the manager view also offers a fresh start when its own conversation grows long', { options: { role: 'manager' } }, async ($, on) => {
  const cost = { usd: 0.5, percent: 30 }
  const store = engine(on, 'KAN-88-share', cost)
  store.set('migrated:/work/app', true)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Plan the sprint' } as never)
  cost.usd = 0.9
  cost.percent = 72
  await $.turn.complete(finish)
  await $.command.run({ command: 'pigment', args: '' } as never)
  const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /grown long/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'optimize' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^This session: \$0\.90, conversation 72% full$/ })).toBeTruthy()
  await ui.unmount()
})

test('Start fresh with a summary is always there once there is a prompt, in both views', async ($, on) => {
  const cost = { usd: 0.1, percent: 20 }
  const store = engine(on, 'KAN-88-share', cost)
  store.set('migrated:/work/app', true)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui0 = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  expect(await ui0.find({ type: 'Button', key: 'optimize-anyway' })).toBeFalsy()
  await ui0.unmount()
  await $.prompt.submit({ text: 'Hi' } as never)
  cost.usd = 0.2
  await $.turn.complete(finish)
  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'optimize-anyway' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'optimize' })).toBeFalsy()
  await ui.unmount()
})

test('each view opens with its figure and name', { options: { role: 'manager' } }, async ($, on) => {
  const svg = figureSvg('manager')
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toMatch(/fill="#5b7fd4"/) // the magnifying glass
  expect(figureSvg('developer')).toMatch(/fill="#f2f0ea"/) // the laptop
  const t = figureCells('developer')
  expect([t.columns, t.rows]).toEqual([18, 7])
  expect(atob(t.cells).length).toBe(18 * 7 * 12)

  const store = engine(on, 'develop', { usd: 0, percent: 10 })
  store.set('migrated:/work/app', true)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pigment', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface })
    expect(await ui.find({ type: 'Text', text: /^Manager$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Watching over the sprint$/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('under the manager, one developer figure per person working now', { options: { role: 'manager' } }, async ($, on) => {
  const NOW = 50_000_000
  const M = 60_000
  expect(teamNow([
    { session: 'a', person: 'Ana', ticket: 'KAN-1', usd: 1, lastAt: NOW },
    { session: 'r1', person: 'Rui', ticket: 'KAN-2', usd: 1, lastAt: NOW - 5 * M },
    { session: 'r2', person: 'Rui', ticket: 'KAN-3', usd: 1, lastAt: NOW - M },
    { session: 'me', person: 'Olegário', ticket: 'KAN-9', usd: 1, lastAt: NOW },
  ], 'me').map(d => `${d.person} ${d.ticket}`)).toEqual(['Ana KAN-1', 'Rui KAN-3'])

  const store = engine(on, 'develop', { usd: 0, percent: 10 }, new Map(), [], { now: NOW })
  store.set('migrated:/work/app', true)
  store.set('ledger:/work/app', { tasks: {}, sessions: {
    a: { session: 'a', person: 'Ana', ticket: 'KAN-1', usd: 1, lastAt: NOW - 2 * M },
    r: { session: 'r', person: 'Rui', ticket: 'KAN-2', usd: 2, lastAt: NOW - M },
    gone: { session: 'gone', person: 'Bia', ticket: 'KAN-4', usd: 3, lastAt: NOW - 30 * M },
    closed: { session: 'closed', person: 'Leo', ticket: 'KAN-5', usd: 3, lastAt: NOW - M, endedAt: NOW - M },
  } })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pigment', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface })
    expect(await ui.find({ type: 'Text', text: /^Ana$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Rui$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Bia$/ })).toBeFalsy()  // stopped working a while ago
    expect(await ui.find({ type: 'Text', text: /^Active developers in this project · 2$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Leo$/ })).toBeFalsy()  // closed the session
    await ui.unmount()
  }
})


const CLOUD = JSON.stringify({ version: 1, storage: 'cloud', serverUrl: 'https://pigment-brush.team.workers.dev' })

test('the key the setup saved on this computer connects by itself, no card', { options: { role: 'manager' } }, async ($, on) => {
  const files = new Map([['/work/app/.pigment/config.json', CLOUD], ['/home/t/.pigment/keys/pigment-brush.txt', 'k3y-0123456789abcdef\n']])
  const posts: string[] = []
  engine(on, 'develop', { usd: 0, percent: 10 }, files, posts)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pigment', args: '' } as never)
  const ui = await $.ui.mount({ ...pane('Pigment · The sprint'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Connect to the team server$/ })).toBeFalsy()
  await ui.unmount()
})

test('a developer pastes the team key: checked, saved on this computer, connected', async ($, on) => {
  const files = new Map([['/work/app/.pigment/config.json', CLOUD]])
  const runs: { argv: string[]; stdin?: string }[] = []
  const posts: string[] = []
  engine(on, 'KAN-9-x', { usd: 0, percent: 10 }, files, posts, { fetch: () => [], runs })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Developer setup$/ })).toBeTruthy()
  await ui.input({ key: 'team-key', text: '  k3y-0123456789abcdef  ' } as never)
  expect(runs.length).toBe(1)
  expect(runs[0]!.stdin).toBe('k3y-0123456789abcdef')       // the key goes in on stdin,
  expect(runs[0]!.argv.join(' ')).not.toMatch(/k3y-/)        // never on the command line
  expect(runs[0]!.argv[runs[0]!.argv.length - 1]).toBe('pigment-brush')
  expect(await ui.find({ type: 'Text', text: /^Developer setup$/ })).toBeFalsy()
  await ui.unmount()
})

test('"Not now" holds after a reload', async ($, on) => {
  const files = new Map([['/work/app/.pigment/config.json', CLOUD]])
  engine(on, 'KAN-9-x', { usd: 0, percent: 10 }, files)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  let ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  await ui.press({ key: 'storage-later' })
  await ui.unmount()
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true }) // what a reload runs again
  ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Developer setup$/ })).toBeFalsy()
  await ui.unmount()
})

test('a reload keeps the session numbers, so Start fresh stays', async ($, on) => {
  const cost = { usd: 0.1, percent: 20 }
  const store = engine(on, 'KAN-88-share', cost)
  store.set('migrated:/work/app', true)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Hi' } as never)
  cost.usd = 0.2
  await $.turn.complete(finish)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true }) // the reload runs session.start again
  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'optimize-anyway' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^1 prompt/ })).toBeTruthy()
  await ui.unmount()
})


test('Start fresh: the press returns at once; the summary is a continuation, and the box says so', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 20, 19, 28) })
  const files = new Map<string, string>()
  let forkPrompt = ''
  let filled = ''
  const cost = { usd: 0.1, percent: 20 }
  const store = engine(on, 'KAN-88-share', cost, files, [], { ownClock: true })
  store.set('migrated:/work/app', true)
  on('model.fork', (_, e) => { forkPrompt = (e as unknown as { prompt: string }).prompt; return { value: { isAnswered: true, text: '## Working on\nKAN-88', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('prompt.fill', (_, e) => { filled = (e as unknown as { text: string }).text; return { isFilled: true } as never })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Hi' } as never)
  cost.usd = 0.2
  await $.turn.complete(finish)

  const ui = await $.ui.mount({ ...pane('Pigment · Your work'), surface: 'desktop' })
  await ui.press({ key: 'optimize-anyway' })
  expect(filled).toBe('')            // the press only started it
  await clock.advance(1)
  expect(forkPrompt).toMatch(/continuation of that one piece of work, not a to-do list/)
  expect(forkPrompt).toMatch(/Leave out:.*other tasks/s)
  expect(files.get('/work/app/.claude/handoffs/2026-11-20-19-28.md')).toBe('## Working on\nKAN-88')
  expect(filled).toBe(continueMessage('.claude/handoffs/2026-11-20-19-28.md'))
  expect(filled).toMatch(/not a new task/)
  await ui.unmount()
})
