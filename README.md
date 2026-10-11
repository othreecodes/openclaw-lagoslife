# Lagos Life — OpenClaw plugin + MCP

Lets an [OpenClaw](https://openclaw) agent live inside **[lagoslife.app](https://lagoslife.app)**: it listens on the game's
websocket, replies to players in character, reacts to money/gifts, sends money, and can read its own
game state on demand through an MCP server.

```
lagoslife/
├── plugin/              OpenClaw channel plugin (the agent's Lagos Life presence)
│   ├── index.ts           main plugin: client, event parsing, replies, money, humanize, catch-up
│   ├── openclaw.plugin.json  manifest + config schema
│   ├── package.json
│   └── setup-entry.ts
└── mcp/
    └── server.mjs       zero-dependency MCP server (game awareness + actions)
```

Runs on **Node 24+** (uses global `fetch` and `WebSocket`; zero dependencies).

---

## What it does

**Channel plugin** (`plugin/`)
- Connects to the Lagos Life live websocket and dispatches inbound chat to the bound agent.
- Replies via REST (`POST /api/messages`) — the socket only delivers inbound.
- Understands non-chat events (`kind:"social"`): money received, gifts, waves, gists.
- **Sends money** with hard guardrails: every transfer clamped to `[minSend, maxSendPct% of balance]`,
  optional per-recipient cooldown, automatic retry on HTTP 429.
- **Generous mode**: auto-sends when a player asks for money, and never lets a refusal go out.
- **Humanized**: strips em dashes / AI punctuation tells, random 1–10 s delay before sending,
  keeps conversations going instead of ending them.
- **Outbound guard**: blocks any agent/runtime/system text from leaking into the game chat.
- **Catch-up**: on startup, optionally replies to chats left unanswered (with an age filter so the
  live queue isn't double-replied).

**MCP server** (`mcp/`) — gives the agent on-demand tools:

| Tool | Purpose |
|---|---|
| `lagoslife_status` | money, location, home, needs, mood, job, top skills |
| `lagoslife_balance` | current balance + the allowed gift range |
| `lagoslife_notices` | recent in-game event feed |
| `lagoslife_send_money` | send money by user id (same clamp as the plugin) |
| `lagoslife_send_message` | DM a player by user id |

---

## Installation

### 1. Copy the files onto the host running OpenClaw

```
<openclaw-root>/plugins/openclaw-lagoslife/   ← contents of plugin/
<openclaw-root>/mcp/lagoslife-mcp/            ← contents of mcp/
```
(Any paths work; they just have to match the config below.)

### 2. Register the plugin in `~/.openclaw/openclaw.json`

```jsonc
{
  "plugins": {
    "load": { "paths": ["/abs/path/to/plugins/openclaw-lagoslife"] },
    "entries": { "lagoslife": { "enabled": true } }
  },

  "channels": {
    "lagoslife": {
      "enabled": true,
      "username": "YOUR_LAGOSLIFE_USERNAME",
      "password": "YOUR_LAGOSLIFE_PASSWORD"
    }
  },

  "bindings": [
    { "agentId": "blaze", "match": { "channel": "lagoslife", "accountId": "default" } }
  ],

  "mcp": {
    "servers": {
      "lagoslife": {
        "enabled": true,
        "transport": "stdio",
        "command": "/abs/path/to/node",
        "args": ["/abs/path/to/mcp/lagoslife-mcp/server.mjs"],
        "env": {
          "LL_USERNAME": "YOUR_LAGOSLIFE_USERNAME",
          "LL_PASSWORD": "YOUR_LAGOSLIFE_PASSWORD",
          "LL_MAX_SEND_PCT": "10",
          "LL_MIN_SEND": "10000000"
        }
      }
    }
  }
}
```

Point `bindings[].agentId` at whichever agent should play. The `mcp.servers` block hot-reloads;
plugin/channel changes need a gateway restart.

### 3. Restart the gateway

```
openclaw gateway restart
```
If the gateway runs under a system LaunchDaemon/systemd unit with KeepAlive (so `restart` refuses),
just kill the process and let the supervisor respawn it; it reloads the plugin on boot.

Look for `lagoslife: connected as @<username>` in the gateway log to confirm it's live.

### Turn it off (temporarily)

Set `channels.lagoslife.enabled = false` and restart. Re-enable by setting it back to `true`.

---

## Channel config reference (`channels.lagoslife`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master on/off for the channel. |
| `username` / `password` | — | Lagos Life login (required). |
| `persona` | built-in | In-character voice injected into every prompt. |
| `allowFrom` | — | Optional allowlist of sender ids/usernames. |
| `logEvents` | `false` | Log unmatched websocket frames (debugging). |
| `allowSendMoney` | `true` | Allow the agent to send money. |
| `maxSendPct` | `10` | Max single transfer = this % of current balance. |
| `minSend` | `10000000` | Minimum transfer; if 10% of balance is below it, nothing sends. |
| `sendCooldownMs` | `0` | Min gap between transfers to the **same** person. |
| `reactToSocial` | `false` | Reply to bare waves/hellos/gists (money & gifts always handled). |
| `replyDelayMinMs` / `replyDelayMaxMs` | `1000` / `10000` | Random human-like delay before each reply. |
| `catchUpOnStart` | `false` | On startup, reply to chats left unanswered. |
| `catchUpMax` | `40` | Max chats to catch up per startup. |
| `catchUpStaggerMs` | `8000` | Gap between catch-up dispatches (avoids rate limits). |
| `catchUpMinAgeMs` | `0` | Only catch up threads idle at least this long (avoids double-replying the live queue). |

### MCP env

| Var | Default | Meaning |
|---|---|---|
| `LL_USERNAME` / `LL_PASSWORD` | — | Lagos Life login (required). |
| `LL_MAX_SEND_PCT` | `10` | Max single transfer as % of balance. |
| `LL_MIN_SEND` | `10000000` | Minimum transfer. |

---

## Protocol notes (reverse-engineered)

- Auth: `POST /api/auth/login {username,password}` → `ll_session` cookie; `GET /api/auth/me` for identity.
- Live feed: `GET /api/live` → `{ url: "wss://…/live?t=…" }`. Text frames; `ping`/`pong` keepalive.
- Inbound frame: `{ t:"msg", m:{ id, kind:"chat"|"social", body, at, from, fromId } }`.
- Send DM: `POST /api/messages { to, body }` (the websocket does **not** send).
- Send money: `POST /api/send { to, amount }` → `{ ok, id, amount, fee }`.
- Self state: `GET /api/save` → `game.{ money, location, home, needs, skills, moodlets, notices, … }`.
- People at a location: `POST /api/world { location, look, … }` → `{ players:[{ id, username, rel, … }], hereCount }`.

These are undocumented and may change.
