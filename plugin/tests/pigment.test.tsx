import { expect, test } from 'claude-code/testing'

import { addPrompt, emptyLedger, isInside, liveFrom, NO_TICKET, signalsFor, sprintRows, ticketFrom } from '../hooks/lib'
import type { PromptCost } from '../types'

const pane = (title: string) => ({
  plugin: 'pigment',
  component: 'Pane',
  requestId: 'pigment',
  props: { title, isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const

const row = (ticket: string, usd: number, at = 1): PromptCost => ({
  at, label: 'x', ticket, usd, input: 100, output: 50, cacheRead: 5_000, cacheWrite: 0,
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

function engine(on: TestOn, branch: string, cost: { usd: number; percent: number }, files = new Map<string, string>(), posts: string[] = []) {
  const store = new Map<string, unknown>()
  on('fs.exists', (_, e) => { const p = (e as unknown as { path: string }).path; return { value: files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')) } })
  on('fs.read', (_, e) => ({ value: files.get((e as unknown as { path: string }).path) ?? '' }))
  on('fs.write', (_, e) => { const a = e as unknown as { path: string; text: string }; files.set(a.path, a.text); return { value: undefined } })
  on('fs.list', (_, e) => {
    const dir = (e as unknown as { path: string }).path + '/'
    const names = [...files.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map(k => k.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('http.fetch', (_, e) => { const a = e as unknown as { url: string; init?: { body?: string } }; posts.push(a.url + ' ' + (a.init?.body ?? '')); return { value: { status: 204, ok: true, headers: {}, text: '' } } })
  on('command.register', () => ({ value: { command: 'pigment' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, percent: cost.percent }, cost: { usd: cost.usd } } }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: branch + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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
    const ui = await $.ui.mount({ ...pane('Your work'), surface })
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
    const ui = await $.ui.mount({ ...pane('The sprint'), surface })
    expect(await ui.find({ type: 'Text', text: /The last two weeks/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$3\.00 +KAN-88/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 session working now/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /me · KAN-88/ })).toBeTruthy()
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

  const ui = await $.ui.mount({ ...pane('Your work'), surface: 'desktop' })
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

  const ui = await $.ui.mount({ ...pane('Your work'), surface: 'terminal' })
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
  const ui = await $.ui.mount({ ...pane('Your work'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Developer setup|Where should I keep/ })).toBeFalsy()
  await ui.unmount()
})
