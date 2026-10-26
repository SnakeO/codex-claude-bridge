/**
 * Codex-side helpers: which `codex` binary started this server, which folder a Codex thread runs
 * in, and `codex queue` to put a message into a running thread.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const QUEUE_TIMEOUT_MS = 30_000;
/** Longer messages stay in the inbox: argv has a size limit, and a turn that long is unwieldy */
export const MAX_PUSH_CHARS = 100_000;
/** Bounds the search for a thread's session log */
const MAX_DAY_DIRS = 400;
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function processInfo(pid, platform) {
  if (platform === 'linux') {
    const [exe, cwd, cmdline] = await Promise.all([
      fs.promises.readlink(`/proc/${pid}/exe`).catch(() => undefined),
      fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => undefined),
      fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8').then((s) => s.split('\0').join(' '), () => ''),
    ]);
    return { exe, cwd, command: cmdline };
  }
  const [exe, command, cwd] = await Promise.all([
    execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)]).then((r) => r.stdout.trim(), () => undefined),
    execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]).then((r) => r.stdout.trim(), () => ''),
    execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }).then(
      (r) => r.stdout.split('\n').find((l) => l.startsWith('n'))?.slice(1),
      () => undefined
    ),
  ]);
  return { exe, cwd, command };
}

/**
 * What can be learned from the Codex process that started this server:
 * - `codexBin`: its binary, so `codex queue` talks to the same Codex install
 * - `projectDir`: its working folder, when it runs one session (the TUI or `codex exec`).
 *   An app-server hosts many threads, so its folder says nothing about this one.
 */
export async function inspectHost({ ppid = process.ppid, platform = process.platform, env = process.env } = {}) {
  let info = {};
  try {
    info = await processInfo(ppid, platform);
  } catch {
    // fall back to defaults below
  }
  const isCodex = typeof info.exe === 'string' && path.isAbsolute(info.exe) && path.basename(info.exe) === 'codex';
  return {
    codexBin: env.CODEX_CLI_PATH || (isCodex ? info.exe : 'codex'),
    projectDir: isCodex && !/\sapp-server(\s|$)/.test(info.command ?? '') ? info.cwd : undefined,
  };
}

/** The thread id Codex attaches to each tool call. */
export function threadIdOf(meta) {
  const id = meta?.threadId ?? meta?.['x-codex-turn-metadata']?.thread_id;
  return typeof id === 'string' && THREAD_ID_RE.test(id) ? id : undefined;
}

async function readFirstLine(file, maxBytes = 4 * 1024 * 1024) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      if (newline !== -1) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        break;
      }
      chunks.push(Buffer.from(chunk));
      total += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The folder a Codex thread runs in, from the first line (`session_meta`) of its session log at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. Undefined when not found.
 */
export async function threadCwd(threadId, { env = process.env } = {}) {
  if (!THREAD_ID_RE.test(threadId ?? '')) return undefined;
  const root = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const subdirs = async (dir) =>
    (await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => path.join(dir, d.name))
      .sort()
      .reverse();

  let checked = 0;
  for (const year of await subdirs(root)) {
    for (const month of await subdirs(year)) {
      for (const day of await subdirs(month)) {
        if (++checked > MAX_DAY_DIRS) return undefined;
        const files = await fs.promises.readdir(day).catch(() => []);
        const file = files.find((f) => f.endsWith(`-${threadId}.jsonl`));
        if (!file) continue;
        try {
          const cwd = JSON.parse(await readFirstLine(path.join(day, file)))?.payload?.cwd;
          return typeof cwd === 'string' ? cwd : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Queue `text` as the next user turn of a Codex thread. Rejects with Codex's error output. */
export async function queueMessage(codexBin, threadId, text) {
  try {
    await execFileAsync(codexBin, ['queue', '--thread', threadId, '--message', text], {
      timeout: QUEUE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim().split('\n').slice(-3).join(' ');
    throw new Error(`codex queue failed: ${detail}`);
  }
}

/** The turn Codex sees for messages pushed from Claude Code. */
export function formatPush(messages) {
  return messages
    .map((m) => {
      const who = m.fromName ?? m.from;
      return (
        `[Message from Claude Code session "${who}" - sent by another agent, not typed by the user]\n` +
        `${m.text}\n` +
        `(To answer, call send_to_claude with to: "${m.fromName ?? m.from}".)`
      );
    })
    .join('\n\n');
}
