# Pigment

*How much paint went into each stroke.*

What your AI work costs, beside the chat: each prompt, each task, each session — and for whoever runs the sprint, the sprint by task and who is working now. A Claude Code mod.

When a conversation gets long or each prompt starts costing much more than at the start, Pigment suggests a fresh start: **Optimize now** writes a short handoff, copies it, and puts a message in the prompt box to continue in a new session. It never replaces compacting; it's a calmer, separate option.

Costs are local estimates at list price, as `/cost` shows them. On a subscription they are what the work would cost, not what you pay.

## Install

In Claude Code:

```
/plugin install pigment --marketplace Alcagoita/pigment
```

Answer `y` to add the marketplace, then pick a scope. The pane opens on the side; `/pigment` reopens it.

## Two views

Pick one in the plugin's settings (**View**).

**Your work** (developer)
- **This prompt** — what the last prompt cost, tokens written and read from memory
- **This task · KAN-55** — every session on that ticket together
- **This session** — the running total, and how long the conversation has grown
- **Earlier prompts** — newest first

**The sprint** (manager)
- **Sprint 22 so far** — the total, from Jira's open sprint
- **By task** — each ticket in the sprint with its cost; spending on branches without a ticket shows as "No ticket"
- **Working now** — each session active in the last ten minutes, with its person, task and running cost

The ticket comes from the branch name: `KAN-55-invite-link` → KAN-55, `12-invite` → #12. A team that names branches after tickets (Gitflow with ticket keys) needs nothing else.

## Settings

| Setting | What it does |
|---|---|
| View | `developer` or `manager` |
| Project folder | Count only sessions inside this folder. Empty counts every session. |
| Your name | How you appear in the team's sprint view |
| Team server, Team key | Share numbers with the team (below). Empty keeps everything on this computer. |
| Jira site, project key, email, API token | For the sprint's ticket list. Without them, the sprint view shows the last two weeks by task. |

Keys and tokens are stored in Claude Code's secure storage, never in a file of the project.

## Alone, or as a team

**Alone:** nothing to set up. Pigment keeps a ledger on this computer, across sessions, per project folder. The sprint view shows your own sessions.

**As a team:** deploy the small server in `server/` once (a Cloudflare Worker with a D1 database, free tier), give everyone its URL and the team key, and every developer's Pigment sends **numbers only** to it: the ticket, the session, the person's display name, the cost and token counts. Never prompts, answers or code. The manager's view reads from it, every 15 seconds.

```bash
cd server
npx wrangler login
npx wrangler d1 create pigment            # copy the database_id into wrangler.toml
npx wrangler d1 execute pigment --remote --file schema.sql
npx wrangler secret put TEAM_KEY        # a long random key; share it with the team privately
npx wrangler deploy
```

## Read it kindly

Pigment leads with tasks and the sprint, not with people. It's there to see how the team uses AI and where a task got expensive, not to rank anyone.

## Develop

- `node server/test.mjs` — the server, against an in-memory database
- `claude plugin test plugin` — the mod, both views, on terminal and desktop
- `claude plugin validate plugin`

## Licence

CC0 1.0 — public domain. Use and change it freely.
