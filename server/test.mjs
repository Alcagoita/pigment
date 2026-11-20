// Run: node server/test.mjs — the handler against an in-memory SQLite (node:sqlite) standing in for D1.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { handle } from './src/index.js'

const db = new DatabaseSync(':memory:')
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
const D1 = {
  prepare(sql) {
    const q = sql.replace(/\?(\d+)/g, '?')
    const order = [...sql.matchAll(/\?(\d+)/g)].map(m => Number(m[1]) - 1)
    return {
      bind(...args) {
        const params = order.map(i => args[i] ?? null)
        return {
          async run() { db.prepare(q).run(...params) },
          async all() { return { results: db.prepare(q).all(...params).map(r => ({ ...r })) } },
        }
      },
      async all() { return { results: db.prepare(q).all().map(r => ({ ...r })) } },
    }
  },
}
const env = { DB: D1, TEAM_KEY: 'k3y' }
const req = (method, path, body, key = 'k3y') =>
  new Request('https://pigment.test' + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

const T0 = 1_000_000_000_000
assert.equal((await handle(req('GET', '/v1/tasks', null, 'wrong'), env, T0)).status, 401)
assert.equal((await handle(req('GET', '/v1/tasks', null, ''), env, T0)).status, 401)

const p = (session, person, ticket, usd) => ({ session, person, ticket, usd, input: 10, output: 5, cacheRead: 100, cacheWrite: 0, label: 'never stored' })
assert.equal((await handle(req('POST', '/v1/prompt', p('s1', 'Ana', 'KAN-55', 4)), env, T0)).status, 204)
await handle(req('POST', '/v1/prompt', p('s1', 'Ana', 'KAN-55', 6)), env, T0 + 1)
await handle(req('POST', '/v1/prompt', p('s2', 'Rui', 'KAN-88', 33)), env, T0 + 2)
await handle(req('POST', '/v1/heartbeat', { session: 's2', person: 'Rui', ticket: 'KAN-88', usd: 35.5 }), env, T0 + 3)
await handle(req('POST', '/v1/prompt', p('s3', 'Ana', 'KAN-55', -5)), env, T0 + 4) // a negative cost counts as 0

const tasks = await (await handle(req('GET', '/v1/tasks'), env, T0 + 5)).json()
const byTicket = Object.fromEntries(tasks.map(t => [t.ticket, t]))
assert.equal(byTicket['KAN-55'].usd, 10)
assert.equal(byTicket['KAN-55'].prompts, 3)
assert.equal(byTicket['KAN-88'].usd, 33)

const live = await (await handle(req('GET', '/v1/live'), env, T0 + 5)).json()
assert.equal(live.length, 3)
assert.equal(live.find(s => s.session === 's2').usd, 35.5)
const later = await (await handle(req('GET', '/v1/live'), env, T0 + 11 * 60_000)).json()
assert.equal(later.length, 0, 'sessions idle for 10 minutes are not "working now"')

const cols = db.prepare("SELECT name FROM pragma_table_info('prompts')").all().map(r => r.name)
assert.ok(!cols.includes('label') && !cols.includes('text'), 'no prompt text is stored')
assert.equal((await handle(req('POST', '/v1/prompt', { person: 'x' }), env, T0)).status, 400)
console.log('server tests passed')
