import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createPeer,
  encodeFrame,
  listSessions,
  parseFrameLine,
  parseStatStartTime,
  parseWrapper,
  readRecords,
  resolveTarget,
  slugify,
  socketAddress,
  socketDirFor,
  socketPathOf,
  uniqueName,
  wrapContent,
} from '../plugins/claude-bridge/server/peer.mjs';
import { claudeFrame, deadPid, fakeClaude, tempDir, waitFor, writeLines, writeRecord } from './helpers.mjs';

test('socket addresses percent-encode unusual bytes and decode back', () => {
  assert.equal(socketAddress('/tmp/cc-socks/12.sock'), 'uds:/tmp/cc-socks/12.sock');
  const odd = '/tmp/my socks/é.sock';
  assert.equal(socketAddress(odd), 'uds:/tmp/my%20socks/%C3%A9.sock');
  assert.equal(socketPathOf(socketAddress(odd)), odd);
  assert.equal(socketPathOf('fake-claude'), undefined);
});

test('wrapper round-trips and strips characters that would break the tag', () => {
  const wrapped = wrapContent('uds:/tmp/a.sock', 'codex-"x"<y>', 'line 1\nline 2');
  assert.equal(wrapped, '<cross-session-message from="uds:/tmp/a.sock" from-name="codex-xy">\nline 1\nline 2\n</cross-session-message>');
  assert.deepEqual(parseWrapper(wrapped), { from: 'uds:/tmp/a.sock', fromName: 'codex-xy', body: 'line 1\nline 2' });
});

test('parses the attributes Claude Code itself writes', () => {
  const content =
    '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-session="s1" hop-chain="h" from-name="main" from-mode="bypass">\nhi\n</cross-session-message>';
  assert.deepEqual(parseWrapper(content), {
    from: 'uds:/tmp/cc-socks/1.sock',
    fromSession: 's1',
    fromName: 'main',
    fromMode: 'bypass',
    body: 'hi',
  });
});

test('encodeFrame writes one NDJSON line with no from-mode', () => {
  const line = encodeFrame('uds:/tmp/a.sock', 'codex-x', 'hello', 'id-1');
  assert.ok(line.endsWith('\n'));
  const frame = JSON.parse(line);
  assert.equal(frame.msg_id, 'id-1');
  assert.equal(frame.type, 'user');
  assert.equal(frame.priority, 'next');
  assert.equal(frame.from, 'uds:/tmp/a.sock');
  assert.doesNotMatch(frame.message.content, /from-mode/);
});

test('parseFrameLine reads messages and statuses and ignores the rest', () => {
  const message = parseFrameLine(JSON.stringify(claudeFrame({ from: 'uds:/tmp/c.sock', fromName: 'main', text: 'yo' })));
  assert.deepEqual(message, { kind: 'message', message: { from: 'uds:/tmp/c.sock', fromName: 'main', text: 'yo' } });

  const status = parseFrameLine(
    JSON.stringify({ type: 'control', action: 'peer_message_status', status: 'held', reason: 'needs approval', orig_msg_id: 'm1' })
  );
  assert.deepEqual(status, { kind: 'status', status: { status: 'held', reason: 'needs approval', origMsgId: 'm1' } });

  const bare = parseFrameLine(JSON.stringify({ type: 'user', from: 'uds:/tmp/c.sock', message: { content: 'not wrapped' } }));
  assert.deepEqual(bare.message, { from: 'uds:/tmp/c.sock', text: 'not wrapped' });

  assert.equal(parseFrameLine(JSON.stringify({ type: 'auth', token: 'secret' })), null);
  assert.equal(parseFrameLine('not json'), null);
  assert.equal(parseFrameLine('null'), null);
});

test('parseStatStartTime handles spaces in the command name', () => {
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[19] = '987654';
  assert.equal(parseStatStartTime(`1234 (my odd (proc)) ${fields.join(' ')}`), '987654');
});

test('readRecords skips torn and foreign files', (t) => {
  const dir = tempDir(t);
  writeRecord(dir, { pid: 1, messagingSocketPath: '/tmp/1.sock', name: 'ok' });
  fs.writeFileSync(path.join(dir, '2.json'), '{"pid": 2, "messag');
  fs.writeFileSync(path.join(dir, '3.json'), '{"something": "else"}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
  assert.deepEqual(readRecords(dir).map((r) => r.name), ['ok']);
  assert.deepEqual(readRecords(path.join(dir, 'missing')), []);
});

test('listSessions keeps live records with matching start times', async (t) => {
  const config = tempDir(t);
  const registry = path.join(config, 'sessions');
  const gone = await deadPid();
  writeRecord(registry, { pid: process.pid, procStart: 'Mon Oct 27  1:00:00 2026', kind: 'interactive', name: 'live', messagingSocketPath: '/tmp/cc-socks/a.sock', updatedAt: 2 });
  writeRecord(registry, { pid: gone, procStart: 'x', kind: 'interactive', name: 'dead', messagingSocketPath: '/tmp/cc-socks/b.sock' });
  const readStarts = async () => new Map([[process.pid, 'Mon Oct 27 1:00:00 2026']]);

  const sessions = await listSessions({ env: { CLAUDE_CONFIG_DIR: config }, readStarts });
  assert.deepEqual(sessions.map((s) => [s.name, s.claude, s.address]), [['live', true, 'uds:/tmp/cc-socks/a.sock']]);

  // A reused pid: same pid, different start time
  const reused = await listSessions({ env: { CLAUDE_CONFIG_DIR: config }, readStarts: async () => new Map([[process.pid, 'Tue Oct 28 2:00:00 2026']]) });
  assert.equal(reused.length, 0);

  // Start times unreadable: trust the pid
  const unchecked = await listSessions({ env: { CLAUDE_CONFIG_DIR: config }, readStarts: async () => { throw new Error('no ps'); } });
  assert.equal(unchecked.length, 1);
});

test('resolveTarget prefers the Claude Code session and explains ambiguity', () => {
  const s = (name, claude, pid) => ({ name, claude, pid, cwd: `/w/${pid}`, socketPath: `/tmp/cc-socks/${pid}.sock`, address: `uds:/tmp/cc-socks/${pid}.sock` });
  const sessions = [s('main', true, 1), s('main', false, 2), s('dup', true, 3), s('dup', true, 4), s('script', false, 5)];
  assert.equal(resolveTarget('main', sessions).pid, 1);
  assert.equal(resolveTarget('script', sessions).pid, 5);
  assert.equal(resolveTarget(' uds:/tmp/cc-socks/3.sock ', sessions).pid, 3);
  assert.deepEqual(resolveTarget('uds:/tmp/elsewhere.sock', sessions), { socketPath: '/tmp/elsewhere.sock', address: 'uds:/tmp/elsewhere.sock', claude: false });
  assert.throws(() => resolveTarget('dup', sessions), /Several Claude Code sessions are named "dup".*uds:\/tmp\/cc-socks\/3\.sock.*uds:\/tmp\/cc-socks\/4\.sock/);
  assert.throws(() => resolveTarget('nope', sessions), /No live session is named "nope"\. Claude Code sessions: "main", "dup", "dup"\./);
  assert.throws(() => resolveTarget('nope', []), /No Claude Code sessions are running/);
});

test('naming helpers', () => {
  assert.equal(slugify('My Project (v2)!'), 'my-project-v2');
  assert.equal(slugify('---'), '');
  assert.equal(uniqueName('codex-x', [{ name: 'codex-x' }, { name: 'codex-x-2' }]), 'codex-x-3');
  assert.equal(uniqueName('codex-y', [{ name: 'codex-x' }]), 'codex-y');
  assert.equal(socketDirFor([{ claude: true, socketPath: '/run/a/1.sock' }, { claude: false, socketPath: '/x/2.sock' }]), '/run/a');
  assert.equal(socketDirFor([]), '/tmp/cc-socks');
});

/** A peer and a fake Claude Code session registered in temp folders. */
async function setup(t, onFrame) {
  const config = tempDir(t);
  const socks = tempDir(t, 'ccs-');
  const env = { CLAUDE_CONFIG_DIR: config };
  const registry = path.join(config, 'sessions');
  const claude = await fakeClaude(t, path.join(socks, `${process.pid}.sock`), onFrame);
  writeRecord(registry, { pid: process.pid, procStart: 'start', kind: 'interactive', name: 'fake-claude', messagingSocketPath: claude.socketPath, cwd: '/w' });
  const messages = [];
  const statuses = [];
  const peer = await createPeer({
    name: 'codex-test',
    version: '9.9.9',
    cwd: '/project',
    env,
    pid: 4_000_001,
    socketDir: socks,
    readProcStart: async () => 'peer-start',
    readPidDomain: async () => 'darwin',
    readStarts: async () => new Map([[process.pid, 'start']]),
    statusWaitMs: 300,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
  });
  t.after(() => peer.close());
  return { peer, claude, registry, socks, messages, statuses };
}

test('createPeer registers, sends, receives and cleans up', async (t) => {
  const { peer, claude, registry, socks, messages } = await setup(t);
  const recordFile = path.join(registry, '4000001.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(record.name, 'codex-test');
  assert.equal(record.cwd, '/project');
  assert.equal(record.procStart, 'peer-start');
  assert.equal(record.entrypoint, 'codex-claude-bridge');
  assert.equal(record.version, 'codex-claude-bridge@9.9.9');
  assert.equal(record.kind, undefined);
  assert.equal(record.messagingSocketPath, path.join(socks, '4000001.sock'));
  assert.equal(fs.statSync(record.messagingSocketPath).mode & 0o777, 0o600);

  const sessions = await peer.sessions();
  assert.deepEqual(sessions.map((s) => s.name), ['fake-claude']);

  const result = await peer.send('fake-claude', 'please review a.js');
  assert.equal(result.status, 'delivered');
  await waitFor(() => claude.frames.length === 1, { what: 'frame at fake Claude' });
  const frame = claude.frames[0];
  assert.equal(frame.msg_id, result.msgId);
  assert.deepEqual(parseWrapper(frame.message.content), { from: peer.info().address, fromName: 'codex-test', body: 'please review a.js' });

  await writeLines(peer.info().socketPath, [claudeFrame({ from: socketAddress(claude.socketPath), fromName: 'fake-claude', text: 'looks good' })]);
  await waitFor(() => messages.length === 1, { what: 'inbound message' });
  assert.equal(messages[0].fromName, 'fake-claude');
  assert.equal(messages[0].text, 'looks good');
  assert.equal(typeof messages[0].id, 'string');

  peer.rename('codex-renamed', '/other');
  const renamed = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(renamed.name, 'codex-renamed');
  assert.equal(renamed.cwd, '/other');
  assert.equal(peer.info().name, 'codex-renamed');

  await assert.rejects(peer.send(peer.info().address, 'loop'), /this bridge itself/);
  await assert.rejects(peer.send('nobody', 'x'), /No live session is named "nobody"/);

  peer.close();
  assert.equal(fs.existsSync(recordFile), false);
  assert.equal(fs.existsSync(path.join(socks, '4000001.sock')), false);
  await assert.rejects(peer.send('fake-claude', 'x'), /shut down/);
});

test('send reports a held message, and later statuses become notices', async (t) => {
  const { peer, statuses } = await setup(t, (frame) => [
    { type: 'control', action: 'peer_message_status', status: 'held', reason: 'awaiting approval', orig_msg_id: frame.msg_id },
  ]);
  const result = await peer.send('fake-claude', 'hello');
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'awaiting approval');

  await writeLines(peer.info().socketPath, [
    { type: 'control', action: 'peer_message_status', status: 'expired', orig_msg_id: result.msgId },
  ]);
  await waitFor(() => statuses.length === 1, { what: 'late status' });
  assert.deepEqual(statuses[0], { status: 'expired', origMsgId: result.msgId, to: 'fake-claude' });
});

test('a stale socket file is replaced, a live one is refused', async (t) => {
  const config = tempDir(t);
  const socks = tempDir(t, 'ccs-');
  const opts = {
    name: 'codex-a',
    version: '1',
    env: { CLAUDE_CONFIG_DIR: config },
    pid: 4_000_002,
    socketDir: socks,
    readProcStart: async () => 's',
    readPidDomain: async () => 'darwin',
    readStarts: async () => new Map(),
  };
  fs.writeFileSync(path.join(socks, '4000002.sock'), '');
  const peer = await createPeer(opts);
  t.after(() => peer.close());
  await assert.rejects(createPeer(opts), /already listening/);
});

test('unsupported platforms are refused', async () => {
  await assert.rejects(createPeer({ name: 'x', version: '1', platform: 'win32' }), /isn't supported on win32/);
});
