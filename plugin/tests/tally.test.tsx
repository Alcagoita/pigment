import { expect, test } from 'claude-code/testing'

import { addPrompt, emptyLedger, isInside, liveFrom, NO_TICKET, signalsFor, sprintRows, ticketFrom } from '../hooks/lib'
import type { PromptCost } from '../types'

const pane = (title: string) => ({
  plugin: 'tally',
  component: 'Pane',
  requestId: 'tally',
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

function engine(on: Parameters<Parameters<typeof test>[1]>[1], branch: string, cost: { usd: number; percent: number }) {
  const store = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'tally' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, percent: cost.percent }, cost: { usd: cost.usd } } }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: branch + '\n', stderr: '' } }))
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
  await $.prompt.submit({ text: 'Add the invite link' })
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
  await $.prompt.submit({ text: 'Share sheet' })
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
