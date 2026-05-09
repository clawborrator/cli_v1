# clawborrator-cli

`claw` — command-line client for [clawborrator](https://next.clawborrator.com),
a control plane for Claude Code sessions.

What you can do with it from a terminal:

- Attach to any CC session you can see (yours or shared with you), watch
  prompts and tool calls stream in, type your own prompts, approve or
  deny permission gates, chat with other operators on the side.
- Send one-shot prompts to a session non-interactively (CI-friendly).
- Mint channel tokens (`ck_live_…`) and drop a ready-to-use `.mcp.json`
  block so a CC running on this machine appears on the hub.
- Route prompts across sessions (`claw route @backend "what time is it"`)
  with reply tracking.
- Share sessions with teammates at viewer / prompter / approver role.
- Publish a session as a public expert agent (`@<owner>/<slug>`,
  callable from any prompt).
- Subscribe to webhooks for chat / permission / file / agent events.

The hub is at <https://next.clawborrator.com> by default — point at a
self-hosted instance with `claw login --hub <url>` (persists per
machine).

---

## Install

```bash
# one-off (no global install)
npx clawborrator-cli@latest login

# or pin globally
npm install -g clawborrator-cli
claw login
```

Requires Node 20+.

---

## First-time setup

```bash
# 1. Authenticate (opens a browser → GitHub → back to a localhost
#    callback that hands you a 30-day session token).
claw login

# 2. Confirm.
claw whoami
# logged in as @your-github-login

# 3. (optional) Mint a channel token + drop the .mcp.json block so
#    your local Claude Code registers a session against the hub.
claw token mint --name "$(hostname)" --mcp-snippet --out .mcp.json
# → now restart `claude code` in this directory and it'll appear in
#   `claw session list`.
```

The session token is stored at `~/.clawborrator/config.json` (mode
0600). To talk to a different hub, pass `--hub <url>` once on login;
the URL persists.

---

## Cheatsheet

### Sessions

```bash
claw session list                              # your sessions + ones shared with you
claw session ls --connected                    # only currently-online ones

claw session attach @backend                   # interactive TUI: live tail + send prompts + approve gates
claw session attach 6d04…uuid

claw session info @backend                     # one-shot detail dump
claw session events @backend --kind chat       # transcript history (--limit / --after / --before)
claw session messages @backend                 # operator-to-operator chat (op-messages)
claw session files @backend                    # list file attachments on a session
claw session file-rm 42                        # delete a file by id (refcount-sweeps blob if last ref)
                                                # Tip: any prompt that mentions fileId=N will auto-clone the file into
                                                # the recipient's session — files follow conversations across agents.

claw session prompt @backend "deploy to staging"   # fire-and-forget
claw session prompt @backend "@MRIIOT/rust-expert what is a lifetime?"  # public-agent dispatch
claw session prompt @backend "@alice/frontend ..."  # cross-account peer (if shared)
claw session prompt @backend "@MRIIOT/api-expert read fileId=42"        # mention a fileId — hub auto-clones into recipient's session

claw session share @backend alice --role prompter  # grant access (viewer | prompter | approver)
claw session shares @backend                       # list current shares
claw session unshare @backend alice                # revoke

claw session archive @backend                  # soft-delete (auto-resurrects on next CC start in the same project)
claw session prune --dry-run                   # find duplicate-routing-name rows
claw session delete @backend --hard            # permanent (cascades events / op-messages / shares)
```

Managed-session control (works against sessions spawned by a desktop daemon):

```bash
claw session kill @backend                     # kill the CC process; keep the session row
claw session restart @backend                  # kill + respawn; new pid, same session row
claw session screenshot @backend               # one frame of the rendered terminal (vt100 → text)
claw session input @backend "hello\r"          # type bytes into the PTY (escape sequences ok)
```

`<ref>` in any subcommand accepts the session UUID, the `@routingName`
for sessions you own, or `@owner/routingName` for sessions shared with
you.

### Cross-session routing

```bash
claw peers                                     # sessions reachable for routing (yours + shared)

claw route @backend "what time is it"          # ask-mode: blocks up to 60s for the reply
claw route @alice/frontend "..." --tell        # tell-mode: fire-and-forget

claw probe "do you have a User model" --peers @backend,@frontend   # parallel fan-out
claw probe "..."                               # implicit: every online reachable peer
```

Routing requires prompter+ on the target. Peer's CC must be online
and not mid-turn for someone else (driver-claim contention returns a
409 and you retry in a moment).

### Channel tokens

For your local Claude Code to register a session against the hub,
clawborrator-mcp needs a `ck_live_…` token in the project's
`.mcp.json`:

```bash
claw token mint --name "alice-laptop" --mcp-snippet --out .mcp.json
# → writes a ready-to-use .mcp.json
# → prints the plaintext token to stderr ONCE — copy it if you didn't redirect

claw token list                                # list active tokens
claw token revoke <id>                         # revoke (cascade-archives sessions registered with it)
```

> **Windows note:** prefer `--out <path>` over PowerShell `>`
> redirection. PowerShell's default redirection writes UTF-16 LE with
> BOM, which CC rejects when parsing `.mcp.json`. `--out` writes UTF-8
> without BOM.

### Public expert agents

A session you own can be published as `@<your-login>/<slug>`,
callable by any signed-in user:

```bash
claw agents publish --session <uuid> --name "rust expert" --tagline "answers Rust questions" --published
# → @MRIIOT/rust-expert is live; rate-limited per-user, capped at
#   1000 queries/day by default.

claw agents list                               # discover everyone's published agents
claw agents list --mine                        # your own agents (any status, includes draft)

claw agents update @MRIIOT/rust-expert --budget 5000
claw agents update @MRIIOT/rust-expert --composable        # opt out of isolation (cross-session routing tools enabled while answering)
claw agents update @MRIIOT/rust-expert --status draft      # take it offline without unpublishing

claw agents inbound @MRIIOT/rust-expert --days 7  # who's been calling: ok / denied / latency / top askers / recent

claw agents unpublish @MRIIOT/rust-expert
```

Default mode is `--isolated` (recommended): the agent's CC cannot
use cross-session routing tools while answering a public dispatch.
Use `--composable` only for orchestrator-style agents that need to
reach other peers.

Anyone can also call your agent over the
[A2A protocol](https://a2a-protocol.org) at
`/api/a2a/v1/agents/<owner>/<slug>` — see the
[A2A bridge reference](https://next.clawborrator.com/demos/a2a-docs/).

### Webhooks

Subscribe to events for sessions you can see:

```bash
claw webhook add --url https://your-server/hook \
  --events 'chat.event,permission.requested,permission.resolved'

claw webhook list
claw webhook test <id>                         # queue a synthetic webhook.test delivery
claw webhook rm <id>
```

The signing secret is shown ONCE on `add`. HMAC-SHA256 in the
`X-Clawborrator-Signature: t=…,v1=…` header (Stripe-style).
Verification recipes for Node + Python and the full event catalog
live at the
[webhooks reference](https://next.clawborrator.com/demos/webhooks/).

### App tokens (SPA OAuth shortcut)

Browser SPAs authenticate via the SPA OAuth + PKCE flow and store
their `cw_app_…` token in `localStorage`. For dev you usually don't
want to walk the full OAuth round-trip every time — the CLI can mint
an app token directly off your existing CLI session:

```bash
claw apps mint "my-spa"                        # mint a cw_app_… app token
claw apps list                                 # list active app tokens
claw apps list --all                           # include revoked
claw apps revoke <id>                          # revoke (use --yes to skip the confirm)

claw apps test-oauth                           # walk the SPA OAuth+PKCE flow end-to-end
                                                # as a debug tool — mints a real app token
                                                # via the redirect-callback path
```

`apps mint` is the dev shortcut; `apps test-oauth` is the real flow
exercised end-to-end (useful when the redirect or the exchange step
is misbehaving). Both produce identical tokens.

### Desktop daemons

If you (or operators you share with) are running the
[`clawborrator-supervisor`](https://github.com/clawborrator/desktop_v1)
desktop daemon, the hub knows about it and you can ask it to spawn
managed CC sessions remotely:

```bash
claw desktop list                              # daemons registered for the current user
claw desktop create-session <machineId> <folder>   # spawn CC on that machine in <folder>
                                                #   --routing-name <name>     pin the routingName
                                                #   --auto-enter / --no-auto-enter
                                                #   --extra-flag <flag>       passed to claude (repeatable)
```

The daemon mints the channel token server-side, drops a `.mcp.json`
into the folder, and spawns CC. Once it registers, it shows up in
`claw session list` like any other session — and `claw session kill`
/ `restart` / `screenshot` / `input` operate on it.

### Auth

```bash
claw login                                     # browser-based GitHub OAuth (PKCE)
claw login --hub https://your-hub.example.com  # point at a different hub; persists
claw whoami
claw logout                                    # revokes the session token + clears local config
```

---

## `claw session attach` — the TUI

Multiple operators attach to the same Claude Code session, see each
other's prompts in real time, race on tool-permission approvals, and
chat in a side channel that stays out of Claude's context.

```
$ claw session attach @backend

  attached to @backend (cwd /home/alice/repo, role: prompter, alice (you), bob)
  ───────────────────────────────────────────────────────────────────────────
  [10:42] @bob ›       deploy to staging
  [10:42] claude       I'll start by running the test suite first…
  [10:42] → Bash       npm run test
                       ↳ permission gate: /y to approve, /n to deny  (alice can decide)
  /y
  [10:42] ✓ Bash       (allowed by @alice)
  [10:43] ✓ Bash       (npm run test exited 0)
  [10:43] claude       Tests pass. Running deploy now…
  ───────────────────────────────────────────────────────────────────────────
  > _                                                          [/help for commands]
```

In-TUI commands:

| | |
|---|---|
| `<text>` | send a prompt to the attached session |
| `@peer <text>` | route to a peer session and wait for the reply |
| `/op <text>` | operator-to-operator chat (visible to peers, not to Claude) |
| `/y` `/n` | approve / deny the most recent permission gate |
| `/peers` | show currently-reachable peer sessions |
| `/help` | full list |
| `Ctrl-C` | detach (the session keeps running) |

---

## Configuration

| Path | Contents |
|---|---|
| `~/.clawborrator/config.json` | hub URL + session token (mode 0600) |
| `$CLAWBORRATOR_HUB` | env override for hub URL (one-shot, doesn't persist) |

---

## Troubleshooting

**"can't connect to localhost:8787" after login.** You're on a
pre-0.0.45 install pointed at the dev default. Upgrade to
`@latest` and re-run `claw login`; the new default points at
`https://next.clawborrator.com`. Or pass `--hub` explicitly.

**OAuth callback hangs / "state is required" in the browser.** On
Windows the callback URL contains `&` which CMD's `start` builtin
treats as a separator. Upgrade to a recent version of the CLI
(0.0.41+); we now quote the URL through `windowsVerbatimArguments`.

**`.mcp.json` written via `>` doesn't work.** PowerShell encodes
redirected output as UTF-16 LE with BOM. CC's MCP parser doesn't
handle the BOM. Use `claw token mint … --mcp-snippet --out .mcp.json`
instead — that writes UTF-8 without BOM directly to disk.

**`claw session attach` shows "auth failed".** Your session token
expired (30-day hard cap, no refresh). Run `claw login` again and
re-attach.

**Cross-session routing returns "is offline" or "is processing a
turn for another user".** The peer's CC needs to be online (channel
WS open) and not mid-turn for someone else. Wait or pick a different
peer.

---

## Where to look next

- **Hub home:** <https://next.clawborrator.com/>
- **CLI source / issues:** <https://github.com/clawborrator/cli_v1>

The CLI is a thin shell over the hub's REST + WebSocket surface — anything
`claw` does you can do directly from any HTTP client. Wire types live in
`src/shared/` (vendored from the hub repo's `shared/` workspace).

---

## License

MIT.
