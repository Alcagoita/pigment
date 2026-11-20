// Pigment team server: one per project (or team). Keeps numbers only — ticket, session,
// person's display name, cost and token counts. Never prompts, answers or code.
//
// Every request needs `Authorization: Bearer <TEAM_KEY>` (a Worker secret).
//   POST /v1/prompt     {session, person, ticket, usd, input, output, cacheRead, cacheWrite, at}
//   POST /v1/heartbeat  {session, person, ticket, usd, lastAt}
//   GET  /v1/tasks      -> [{ticket, usd, prompts, firstAt, lastAt}]   (all tasks; the mod picks the sprint's)
//   GET  /v1/live       -> [{session, person, ticket, usd, lastAt}] active in the last 10 minutes

const LIVE_MS = 10 * 60_000
const MAX = { text: 80, usd: 10_000, tokens: 50_000_000 }

const json = (body, status = 200) => Response.json(body, { status })

function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || b.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const str = v => (typeof v === 'string' ? v.slice(0, MAX.text) : '')
const num = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : 0)

export async function handle(request, env, now = Date.now()) {
  const url = new URL(request.url)
  const auth = request.headers.get('authorization') ?? ''
  if (!sameKey(auth.replace(/^Bearer /, ''), env.TEAM_KEY)) return json({ error: 'unauthorized' }, 401)

  if (request.method === 'POST' && (url.pathname === '/v1/prompt' || url.pathname === '/v1/heartbeat')) {
    let b
    try { b = await request.json() } catch { return json({ error: 'bad json' }, 400) }
    const session = str(b.session)
    if (!session) return json({ error: 'session required' }, 400)
    const person = str(b.person) || 'someone'
    const ticket = str(b.ticket) || 'No ticket'
    const usd = num(b.usd, MAX.usd)
    const at = now // the server's clock, so a wrong client clock can't reorder the sprint

    if (url.pathname === '/v1/prompt') {
      await env.DB.prepare(
        'INSERT INTO prompts (at, session, person, ticket, usd, input, output, cache_read, cache_write) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)'
      ).bind(at, session, person, ticket, usd, num(b.input, MAX.tokens), num(b.output, MAX.tokens),
        num(b.cacheRead, MAX.tokens), num(b.cacheWrite, MAX.tokens)).run()
    }
    // The session row: its running cost (heartbeat) or its total after a prompt.
    const sessionUsd = url.pathname === '/v1/heartbeat' ? usd : null
    await env.DB.prepare(
      `INSERT INTO sessions (session, person, ticket, usd, last_at) VALUES (?1,?2,?3,COALESCE(?4,0),?5)
       ON CONFLICT(session) DO UPDATE SET person=?2, ticket=?3, usd=COALESCE(?4, usd), last_at=?5`
    ).bind(session, person, ticket, sessionUsd, at).run()
    return new Response(null, { status: 204 })
  }

  if (request.method === 'GET' && url.pathname === '/v1/tasks') {
    const { results } = await env.DB.prepare(
      'SELECT ticket, SUM(usd) AS usd, COUNT(*) AS prompts, MIN(at) AS firstAt, MAX(at) AS lastAt FROM prompts GROUP BY ticket'
    ).all()
    return json(results)
  }

  if (request.method === 'GET' && url.pathname === '/v1/live') {
    const { results } = await env.DB.prepare(
      'SELECT session, person, ticket, usd, last_at AS lastAt FROM sessions WHERE last_at > ?1 ORDER BY last_at DESC'
    ).bind(now - LIVE_MS).all()
    return json(results)
  }

  return json({ error: 'not found' }, 404)
}

export default { fetch: (request, env) => handle(request, env) }
