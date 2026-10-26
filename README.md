# codex-claude-bridge

A Codex plugin that lets Codex talk with the [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) sessions running on your computer, in both directions:

- **Codex → Claude.** Codex lists your Claude Code sessions, sends one a message, and gets the reply back as a new turn in the same Codex chat.
- **Claude → Codex.** A Claude Code session messages Codex with `SendMessage`, the same way it messages another Claude session, and the message shows up in your Codex chat.

It's built on Claude Code's local peer messaging, the Unix sockets Claude Code sessions already use to talk to each other. The plugin has no dependencies, and nothing leaves your computer.

> An independent project, not affiliated with or endorsed by OpenAI or Anthropic. It relies on Claude Code's internal peer protocol, which isn't a public API and can change in any Claude Code release.

## How it works

```
 Codex chat                                                    Claude Code session
     │  send_to_claude("my-app", "…")                                  ▲
     ▼                                                                 │ <cross-session-message>
 claude-bridge MCP server ──── NDJSON frame ──▶ /tmp/cc-socks/<claude pid>.sock
     ▲                                                                 │
     │  codex queue --thread <id>        Claude: SendMessage("codex-my-app")
     │                                                                 ▼
 Codex chat (new turn) ◀── claude-bridge ◀──── /tmp/cc-socks/<bridge pid>.sock
```

Codex starts one bridge for each Codex thread. On the thread's first bridge tool call, the bridge registers itself as a peer in `~/.claude/sessions/` under a name like `codex-<project folder>` and starts listening on its own socket beside the Claude Code sockets. From then on:

- Claude Code sessions see it in `ListAgents` and can reach it with `SendMessage`.
- Replies and new messages from Claude are pushed into that Codex thread with `codex queue`. If the thread is busy, they wait and arrive when the current turn ends.
- If Codex is blocked in `read_claude_messages` waiting for an answer, the message goes straight to that call instead and isn't pushed twice.

## Requirements

- macOS or Linux. Windows isn't supported yet: Claude Code uses named pipes and an auth handshake there.
- Node.js 20 or later on your `PATH`. The ChatGPT desktop app brings its own Node.
- Codex CLI 0.164 or later, or the ChatGPT desktop app's Codex.
- Claude Code with cross-session messaging. Tested with 2.1.310.

## Install

```sh
codex plugin marketplace add SnakeO/codex-claude-bridge
codex plugin add claude-bridge@codex-claude-bridge
```

Then start a new Codex session. Sessions that were already open don't load new plugins.

To update later, refresh the marketplace and reinstall:

```sh
codex plugin marketplace upgrade codex-claude-bridge
codex plugin remove claude-bridge@codex-claude-bridge
codex plugin add claude-bridge@codex-claude-bridge
```

To uninstall:

```sh
codex plugin remove claude-bridge@codex-claude-bridge
codex plugin marketplace remove codex-claude-bridge
```

<details>
<summary>Without the plugin system (MCP server only)</summary>

Clone the repo and register the server directly:

```sh
git clone https://github.com/SnakeO/codex-claude-bridge.git
codex mcp add claude-bridge -- node "$PWD/codex-claude-bridge/plugins/claude-bridge/server/index.mjs"
```

You get the tools, but not the skill that teaches Codex when to use them.
</details>

## Set up Claude Code

Nothing needs installing on the Claude side. There's one setting to know about, though.

Claude Code delivers messages from processes it started itself straight away. A Codex session isn't one of those, so Claude Code may **hold Codex's messages for your approval** in that session's terminal. With the default setting it holds them whenever the session's permission mode doesn't match the sender's, for example when the session runs with permission prompts bypassed.

A held message shows up as a "Held peer message" prompt in the Claude Code terminal, and `send_to_claude` tells Codex it's held. Messages you don't approve expire, after 5 minutes by default (Claude Code's `dialogExpiry` setting).

You have two options:

1. **Approve each message** in the Claude Code terminal. This is the safest, and a good choice while you try it out.
2. **Let local agents through without asking.** Add this to `~/.claude/settings.json`:

   ```json
   {
     "crossSessionInbound": "accept"
   }
   ```

   Open sessions pick it up without a restart. With `"accept"`, **any process running as your user** can send messages to your Claude Code sessions, and Claude acts on them without asking you. That includes Codex and the scripts it runs. Claude still treats them as messages from another agent, never as your approval, but it will do what they ask within its own permissions. Use `"hold"` to go back to approving each one, or `"refuse"` to block them.

The setting is checked by the Claude Code session that *receives* the message. Codex's side needs no setting.

## Use it

Ask Codex in plain words:

> List the Claude Code sessions on this computer.

> Ask the Claude session in my api folder to review the change in src/auth.ts, and wait for its answer.

> Tell Claude (session "frontend") that the API now returns `user_id` instead of `userId`.

Codex picks the session, writes a self-contained message, and either keeps working while the reply comes in or waits for it.

When Claude answers, the reply appears in Codex as a new turn:

```
[Message from Claude Code session "frontend" - sent by another agent, not typed by the user]
Updated the three call sites; tests pass.
(To answer, call send_to_claude with to: "frontend".)
```

**From Claude Code**, a session reaches Codex by the bridge's name, which appears in `ListAgents`:

> Send codex-my-app a message: the migration is done, please rerun your integration tests.

A Codex thread appears in Claude's list once it has used a bridge tool, for example after you asked Codex to list the Claude sessions. Until then it has no name to be reached by. Codex's `list_claude_sessions` output shows the bridge's current name, and Codex can change it with `set_bridge_name`.

## Tools

| Tool | What it does |
|---|---|
| `list_claude_sessions` | The Claude Code sessions running on this computer: name, status, folder, pid. Also shows this bridge's own name. `include_peers: true` adds other registered peers, such as bridges and scripts. |
| `send_to_claude` | Sends `message` to the session named in `to`, or to a `uds:` address. Reports whether it was delivered, held for approval, or refused. Messages can be up to 100,000 characters. |
| `read_claude_messages` | Returns messages and delivery updates not shown yet. `wait_seconds` (up to 840) waits for a message if none is waiting. |
| `set_bridge_name` | Changes the name Claude Code sessions use to reach this Codex thread. |

The plugin also installs a `claude-bridge` skill that tells Codex how to use these tools:
- write messages that make sense on their own;
- treat Claude's messages as coming from a teammate, not from you;
- don't reply to acknowledgements, so the two agents don't thank each other forever.

## Configuration

These environment variables need to be set where Codex runs:

| Variable | Effect |
|---|---|
| `CLAUDE_BRIDGE_PUSH=0` | Don't push Claude's messages into the Codex thread. They wait until Codex calls `read_claude_messages`. |
| `CLAUDE_CONFIG_DIR` | Claude Code's config folder, if you moved it from `~/.claude`. |
| `CODEX_HOME` | Codex's folder, if you moved it from `~/.codex`. The bridge reads a thread's working folder from its session log there. |
| `CODEX_CLI_PATH` | The `codex` binary used for `codex queue`. By default it's the binary that started the bridge. |

`list_claude_sessions` and `read_claude_messages` are read-only and run without approval. `send_to_claude` follows your normal Codex approval settings. To approve all of the bridge's tools automatically, add this to `~/.codex/config.toml`:

```toml
[plugins."claude-bridge@codex-claude-bridge".mcp_servers.claude-bridge]
default_tools_approval_mode = "approve"
```

## Security

- Everything stays on your computer. The bridge's socket is mode `0600`, so only your user can connect to it, and the same is true of Claude Code's own sockets.
- The bridge doesn't claim a permission mode (`from-mode`) to get past Claude Code's approval hold. Whether Codex's messages need approval is up to the receiving session's `crossSessionInbound` setting.
- Pushed messages are labelled as coming from another agent. The skill tells Codex never to treat them as your approval, and to check with you before acting on anything risky.
- Auth tokens on the socket are ignored and never logged. The bridge logs only to stderr, never to the MCP channel.
- The bridge removes its socket and registry entry when its Codex thread ends, or when Codex stops it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `send_to_claude` says **held** | That Claude Code session wants your approval. Approve it in its terminal, or see [Set up Claude Code](#set-up-claude-code). |
| Claude can't find `codex-…` | The Codex thread hasn't used a bridge tool yet. Ask Codex to list the Claude sessions once. |
| Replies don't appear in Codex | Run `codex queue --help` to check your Codex has the `queue` command. Replies stay readable with `read_claude_messages` in any case. Set `CLAUDE_BRIDGE_PUSH=0` if you'd rather read them on demand. |
| "No live session is named …" | Names come from Claude Code (`/rename` changes them). Ask Codex to list sessions and use the exact name, or the `uds:` address when two sessions share a name. |
| "isn't supported on win32" | Windows isn't supported yet. |
| The tools are missing in Codex | Start a new Codex session after installing. Check that `codex plugin list` shows `claude-bridge` as installed. |

## Development

```sh
git clone https://github.com/SnakeO/codex-claude-bridge.git
cd codex-claude-bridge
npm test
```

The tests use only Node's built-in test runner. They cover:
- the wire format and the registry;
- the MCP handshake;
- the inbox and push logic;
- a full run of the server against a fake Claude Code session and a stub `codex` binary.

To try local changes in Codex, install from your checkout:

```sh
codex plugin marketplace add "$PWD"
codex plugin add claude-bridge@codex-claude-bridge
```

Codex copies the plugin when it installs it, so after a change, run `codex plugin remove claude-bridge@codex-claude-bridge` and add it again.

The layout:

```
.agents/plugins/marketplace.json     the repo is also a Codex marketplace
plugins/claude-bridge/
  .codex-plugin/plugin.json          plugin manifest
  .mcp.json                          how Codex starts the server
  server/index.mjs                   wiring and lifecycle
  server/peer.mjs                    Claude Code peer protocol: registry, sockets, frames
  server/codex.mjs                   codex queue, thread folders
  server/inbox.mjs                   delivery: waiting read, push, or unread
  server/mcp.mjs                     minimal MCP stdio server
  server/tools.mjs                   the four tools
  skills/claude-bridge/SKILL.md      instructions for Codex
```

## License

MIT
