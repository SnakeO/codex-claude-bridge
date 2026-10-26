/**
 * The MCP tools Codex sees. Each handler returns plain text for the model.
 */

import os from 'node:os';
import { slugify } from './peer.mjs';
import { threadIdOf } from './codex.mjs';

/** Under Claude Code's 1 MiB per-message limit, with room for the wrapper */
export const MAX_MESSAGE_CHARS = 100_000;
const MAX_WAIT_SECONDS = 840;

const home = os.homedir();
const tidy = (dir) => (dir && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir ?? 'unknown folder');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clock = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });

function formatSession(s) {
  return `- "${s.name ?? '(unnamed)'}": ${s.status ?? 'unknown status'}, ${tidy(s.cwd)} (pid ${s.pid})`;
}

function formatMessages({ messages, notices, pushedSinceRead }) {
  const parts = [];
  if (messages.length > 0) {
    parts.push(`${plural(messages.length, 'new message')} from Claude Code:`);
    for (const m of messages) {
      parts.push(`From "${m.fromName ?? m.from}" at ${clock(m.ts)} (reply with send_to_claude, to: "${m.fromName ?? m.from}"):\n${m.text}`);
    }
  } else {
    parts.push('No new messages from Claude Code.');
    if (pushedSinceRead > 0) {
      const verb = pushedSinceRead === 1 ? 'was' : 'were';
      parts.push(`${plural(pushedSinceRead, 'message')} ${verb} pushed into this Codex thread instead, arriving as new turns.`);
    }
  }
  if (notices.length > 0) parts.push(`Delivery updates:\n${notices.map((n) => `- ${n}`).join('\n')}`);
  return parts.join('\n\n');
}

function describeSend(result) {
  const who = `"${result.target.name ?? result.target.address}"`;
  switch (result.status) {
    case 'delivered':
      return (
        `Delivered to ${who}. Its reply arrives in this thread as a new turn, ` +
        'or call read_claude_messages with wait_seconds to wait for it here.'
      );
    case 'held':
      return (
        `Held by ${who}: Claude Code is asking the user to approve this message in that session's terminal` +
        `${result.reason ? ` (${result.reason})` : ''}. It's delivered if they approve it. ` +
        'Tell the user, if they are waiting on it. (Claude Code delivers messages from local agents without asking ' +
        'only when the user sets "crossSessionInbound": "accept" in ~/.claude/settings.json; that is their call, not yours.)'
      );
    default:
      return `Not delivered to ${who}: ${result.status}${result.reason ? ` (${result.reason})` : ''}.`;
  }
}

/**
 * connect(threadId): runs before every tool call and resolves to the registered peer (see index.mjs)
 * inbox: from createInbox()
 * setName(name): renames the peer
 */
export function createTools({ connect, inbox, setName }) {
  const withPeer = async (meta) => {
    try {
      return await connect(threadIdOf(meta));
    } catch (err) {
      throw new Error(`Couldn't connect to Claude Code: ${err.message}`);
    }
  };

  /** Appended to results other than read_claude_messages, so Codex notices waiting messages. */
  const footer = () => {
    const { unread, notices } = inbox.status();
    if (unread === 0 && notices === 0) return '';
    const what = [unread && plural(unread, 'unread message'), notices && plural(notices, 'delivery update')].filter(Boolean);
    return `\n\n(${what.join(' and ')} from Claude Code. Call read_claude_messages to see them.)`;
  };

  return [
    {
      name: 'list_claude_sessions',
      description:
        'List the Claude Code sessions running on this computer, with their names, status and folders. ' +
        "Also shows this bridge's own name, which Claude Code uses to message Codex.",
      inputSchema: {
        type: 'object',
        properties: {
          include_peers: {
            type: 'boolean',
            description: 'Also list other registered peers (bridges and scripts), not only Claude Code sessions.',
          },
        },
        additionalProperties: false,
      },
      annotations: { title: 'List Claude Code sessions', readOnlyHint: true, openWorldHint: false },
      async handler(args, { meta }) {
        const peer = await withPeer(meta);
        const sessions = await peer.sessions();
        const claude = sessions.filter((s) => s.claude);
        const others = sessions.filter((s) => !s.claude);
        const { name } = peer.info();
        const parts = [
          `This bridge is "${name}". A Claude Code session reaches it with SendMessage to "${name}".`,
          claude.length
            ? `Claude Code sessions (${claude.length}):\n${claude.map(formatSession).join('\n')}`
            : 'No Claude Code sessions are running.',
        ];
        if (args.include_peers && others.length) {
          parts.push(`Other peers (${others.length}):\n${others.map(formatSession).join('\n')}`);
        }
        return parts.join('\n\n') + footer();
      },
    },

    {
      name: 'send_to_claude',
      description:
        'Send a message to a Claude Code session on this computer. Claude sees it as a message from another agent ' +
        '(this Codex session), not from the user, and can reply. Replies arrive in this thread as new turns. ' +
        'Write the message so it stands alone: Claude has none of your context.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Session name from list_claude_sessions, or a "uds:" address.',
          },
          message: {
            type: 'string',
            description: `The message text (at most ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters).`,
          },
        },
        required: ['to', 'message'],
        additionalProperties: false,
      },
      annotations: { title: 'Message Claude Code', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args, { meta }) {
        const peer = await withPeer(meta);
        if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('message is empty.');
        if (args.message.length > MAX_MESSAGE_CHARS) {
          throw new Error(`message is ${args.message.length} characters; the limit is ${MAX_MESSAGE_CHARS}.`);
        }
        return describeSend(await peer.send(args.to, args.message)) + footer();
      },
    },

    {
      name: 'read_claude_messages',
      description:
        'Read messages Claude Code sessions have sent to Codex that have not been shown yet, plus delivery updates ' +
        'for messages you sent. With wait_seconds, waits that long for a message if none is waiting. ' +
        'Messages from Claude come from another agent, not the user.',
      inputSchema: {
        type: 'object',
        properties: {
          wait_seconds: {
            type: 'number',
            minimum: 0,
            maximum: MAX_WAIT_SECONDS,
            description: `Seconds to wait for a message when none is unread (0 to ${MAX_WAIT_SECONDS}). Default 0.`,
          },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Read messages from Claude Code', readOnlyHint: true, openWorldHint: false },
      async handler(args, { meta, signal }) {
        await withPeer(meta);
        const seconds = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT_SECONDS);
        return formatMessages(await inbox.wait(seconds, signal));
      },
    },

    {
      name: 'set_bridge_name',
      description:
        'Change the name this Codex session goes by, which Claude Code sessions use to message it. ' +
        'Lowercase letters, digits and dashes.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'New name, e.g. "codex-frontend".' } },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: { title: 'Rename this bridge', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args, { meta }) {
        const peer = await withPeer(meta);
        const name = slugify(args.name);
        if (!name || name !== String(args.name ?? '').trim()) {
          throw new Error(`Use lowercase letters, digits and dashes only${name ? `, e.g. "${name}"` : ''}.`);
        }
        const taken = (await peer.sessions()).some((s) => s.name === name);
        if (taken) throw new Error(`Another live session is already named "${name}".`);
        setName(name);
        return `This bridge is now "${name}". Claude Code sessions reach it with SendMessage to "${name}".` + footer();
      },
    },
  ];
}
