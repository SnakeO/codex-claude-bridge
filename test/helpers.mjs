import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** A fresh temp folder, short enough for Unix socket paths (about 104 bytes max). */
export function tempDir(t, prefix = 'ccb-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Resolve with the value of `check()` once it's truthy, polling every 20 ms. */
export async function waitFor(check, { timeoutMs = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A pid that no process has, from a child that already exited. */
export async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid;
}

/**
 * A stand-in for a Claude Code session: listens on `socketPath` and records every frame it gets.
 * `onFrame(frame)` can answer by returning lines to write to the sender's `from` socket.
 */
export async function fakeClaude(t, socketPath, onFrame) {
  const frames = [];
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const frame = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        frames.push(frame);
        const answer = onFrame?.(frame);
        if (answer) writeLines(decodeURIComponent(frame.from.slice(4)), answer);
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  t.after(() => server.close());
  return { frames, socketPath };
}

/** Connect to a socket, write lines, and half-close. */
export function writeLines(socketPath, lines) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath, () => conn.end(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)) + '\n').join('')));
    conn.on('close', resolve);
    conn.on('error', reject);
  });
}

/** A frame like the ones Claude Code's SendMessage writes. */
export function claudeFrame({ from, fromName, text, msgId = 'm-' + Math.random().toString(16).slice(2) }) {
  return {
    msgV: 1,
    msg_id: msgId,
    type: 'user',
    message: {
      role: 'user',
      content: `<cross-session-message from="${from}" from-name="${fromName}" from-mode="bypass">\n${text}\n</cross-session-message>`,
    },
    priority: 'next',
    from,
  };
}

export function writeRecord(registryDir, record) {
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(path.join(registryDir, `${record.pid}.json`), JSON.stringify(record));
}
