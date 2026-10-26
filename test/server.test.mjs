import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readProcStart, socketAddress } from '../plugins/claude-bridge/server/peer.mjs';
import { claudeFrame, fakeClaude, tempDir, waitFor, writeLines, writeRecord } from './helpers.mjs';

const SERVER = new URL('../plugins/claude-bridge/server/index.mjs', import.meta.url).pathname;
const THREAD = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

/** The MCP server as Codex runs it, with a fake Claude Code session and a stub `codex` binary. */
async function startServer(t) {
  const config = tempDir(t);
  const socks = tempDir(t, 'ccs-');
  const codexHome = tempDir(t);
  const registry = path.join(config, 'sessions');

  const claude = await fakeClaude(t, path.join(socks, `${process.pid}.sock`));
  writeRecord(registry, {
    pid: process.pid,
    procStart: await readProcStart(process.pid),
    kind: 'interactive',
    name: 'fake-claude',
    status: 'idle',
    cwd: '/work/app',
    messagingSocketPath: claude.socketPath,
    updatedAt: Date.now(),
  });

  // The thread's session log, so the bridge can name itself after the thread's folder
  const day = path.join(codexHome, 'sessions', '2026', '10', '27');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-x-${THREAD}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/My Project' } }) + '\n');

  const queued = path.join(codexHome, 'queued.jsonl');
  const stub = path.join(codexHome, 'codex');
  fs.writeFileSync(stub, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(queued)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });

  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: config, CLAUDE_BRIDGE_SOCKET_DIR: socks, CODEX_HOME: codexHome, CODEX_CLI_PATH: stub },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  t.after(() => child.kill('SIGKILL'));

  const responses = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      responses.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));

  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return waitFor(() => responses.find((r) => r.id === id), { what: `${method} response (stderr: ${stderr})`, timeoutMs: 10_000 });
  };
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args, _meta: { threadId: THREAD } });
    return response.result;
  };
  const queuedCalls = () => (fs.existsSync(queued) ? fs.readFileSync(queued, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const record = () => {
    const file = path.join(registry, `${child.pid}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  };
  return { child, exited, request, call, claude, queuedCalls, record, registry, socks };
}

test('end to end: list, send, pushed reply, waiting read, cleanup', async (t) => {
  const s = await startServer(t);

  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: 'test' } });
  assert.equal(init.result.serverInfo.name, 'claude-bridge');
  assert.match(init.result.instructions, /not the user/);
  const list = await s.request('tools/list');
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['list_claude_sessions', 'send_to_claude', 'read_claude_messages', 'set_bridge_name']);

  // Nothing registers until Codex calls a tool, so idle threads stay out of Claude Code's list
  assert.equal(s.record(), undefined);

  // The first call tells the bridge its thread, and it registers under the thread's folder name
  const sessions = await s.call('list_claude_sessions');
  assert.match(sessions.content[0].text, /This bridge is "codex-my-project"/);
  assert.match(sessions.content[0].text, /"fake-claude": idle, \/work\/app/);
  assert.equal(s.record().name, 'codex-my-project');
  assert.equal(s.record().cwd, '/work/My Project');

  const sent = await s.call('send_to_claude', { to: 'fake-claude', message: 'Can you review src/a.js?' });
  assert.match(sent.content[0].text, /^Delivered to "fake-claude"/);
  await waitFor(() => s.claude.frames.length === 1, { what: 'frame at fake Claude' });
  const frame = s.claude.frames[0];
  assert.match(frame.message.content, /from-name="codex-my-project">\nCan you review src\/a\.js\?\n</);

  // A reply while nothing is waiting is pushed into the thread with `codex queue`
  const bridgeSocket = decodeURIComponent(frame.from.slice(4));
  await writeLines(bridgeSocket, [claudeFrame({ from: socketAddress(s.claude.socketPath), fromName: 'fake-claude', text: 'LGTM, one nit.' })]);
  const [queued] = await waitFor(() => s.queuedCalls().length && s.queuedCalls(), { what: 'codex queue call', timeoutMs: 20_000 });
  assert.deepEqual(queued.slice(0, 4), ['queue', '--thread', THREAD, '--message']);
  assert.match(queued[4], /^\[Message from Claude Code session "fake-claude"[^\n]*\]\nLGTM, one nit\.\n/);

  const afterPush = await s.call('read_claude_messages');
  assert.match(afterPush.content[0].text, /No new messages[\s\S]*1 message was pushed into this Codex thread/);

  // A reply while a read is waiting goes to the read, not into the thread
  const reading = s.call('read_claude_messages', { wait_seconds: 10 });
  await new Promise((r) => setTimeout(r, 200));
  await writeLines(bridgeSocket, [claudeFrame({ from: socketAddress(s.claude.socketPath), fromName: 'fake-claude', text: 'Second thought.' })]);
  const read = await reading;
  assert.match(read.content[0].text, /1 new message from Claude Code:\n\nFrom "fake-claude" at [\d:]+ \(reply with send_to_claude, to: "fake-claude"\):\nSecond thought\./);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(s.queuedCalls().length, 1);

  // Renaming, and its validation
  const bad = await s.call('set_bridge_name', { name: 'Not OK' });
  assert.equal(bad.isError, true);
  const taken = await s.call('set_bridge_name', { name: 'fake-claude' });
  assert.match(taken.content[0].text, /already named "fake-claude"/);
  const renamed = await s.call('set_bridge_name', { name: 'codex-reviewer' });
  assert.match(renamed.content[0].text, /now "codex-reviewer"/);
  assert.equal(s.record().name, 'codex-reviewer');

  const tooLong = await s.call('send_to_claude', { to: 'fake-claude', message: 'x'.repeat(100_001) });
  assert.equal(tooLong.isError, true);

  // Codex closing stdin shuts the bridge down and removes its socket and record
  const socket = s.record().messagingSocketPath;
  s.child.stdin.end();
  const { code } = await s.exited;
  assert.equal(code, 0);
  assert.equal(s.record(), undefined);
  assert.equal(fs.existsSync(socket), false);
});

test('SIGTERM removes the socket and registry record', async (t) => {
  const s = await startServer(t);
  await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await s.call('list_claude_sessions');
  const socket = s.record().messagingSocketPath;
  assert.equal(fs.existsSync(socket), true);
  s.child.kill('SIGTERM');
  await s.exited;
  assert.equal(s.record(), undefined);
  assert.equal(fs.existsSync(socket), false);
});
