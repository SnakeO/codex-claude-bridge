import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatPush, queueMessage, threadCwd, threadIdOf } from '../plugins/claude-bridge/server/codex.mjs';
import { tempDir } from './helpers.mjs';

const THREAD = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

test('threadIdOf reads either form of Codex tool-call metadata', () => {
  assert.equal(threadIdOf({ threadId: THREAD }), THREAD);
  assert.equal(threadIdOf({ 'x-codex-turn-metadata': { thread_id: THREAD } }), THREAD);
  assert.equal(threadIdOf({ threadId: '../../etc' }), undefined);
  assert.equal(threadIdOf(undefined), undefined);
});

test("threadCwd finds the thread's folder in its session log", async (t) => {
  const home = tempDir(t);
  const day = path.join(home, 'sessions', '2026', '10', '27');
  fs.mkdirSync(day, { recursive: true });
  const meta = { type: 'session_meta', payload: { id: THREAD, cwd: '/Users/me/my-app', base_instructions: 'x'.repeat(200_000) } };
  fs.writeFileSync(path.join(day, `rollout-2026-10-27T01-12-54-${THREAD}.jsonl`), JSON.stringify(meta) + '\n{"type":"other"}\n');
  fs.mkdirSync(path.join(home, 'sessions', '2026', '10', '26'), { recursive: true });

  assert.equal(await threadCwd(THREAD, { env: { CODEX_HOME: home } }), '/Users/me/my-app');
  assert.equal(await threadCwd('0190a1b2-0000-0000-0000-000000000000', { env: { CODEX_HOME: home } }), undefined);
  assert.equal(await threadCwd('not-a-thread', { env: { CODEX_HOME: home } }), undefined);
  assert.equal(await threadCwd(THREAD, { env: { CODEX_HOME: path.join(home, 'missing') } }), undefined);
});

test('formatPush labels the sender and says how to answer', () => {
  const text = formatPush([
    { from: 'uds:/tmp/cc-socks/1.sock', fromName: 'main', text: 'Done: tests pass.' },
    { from: 'uds:/tmp/cc-socks/2.sock', text: 'second' },
  ]);
  assert.match(text, /^\[Message from Claude Code session "main" - sent by another agent, not typed by the user\]\nDone: tests pass\.\n\(To answer, call send_to_claude with to: "main"\.\)/);
  assert.match(text, /session "uds:\/tmp\/cc-socks\/2\.sock"/);
});

test('queueMessage runs codex queue with the thread and message', async (t) => {
  const dir = tempDir(t);
  const argsFile = path.join(dir, 'args.json');
  const stub = path.join(dir, 'codex');
  fs.writeFileSync(stub, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  await queueMessage(stub, THREAD, 'line 1\nline "2"');
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['queue', '--thread', THREAD, '--message', 'line 1\nline "2"']);

  const failing = path.join(dir, 'codex-fail');
  fs.writeFileSync(failing, `#!${process.execPath}\nconsole.error('Error: thread not found'); process.exit(1);\n`, { mode: 0o755 });
  await assert.rejects(queueMessage(failing, THREAD, 'x'), /codex queue failed: .*thread not found/);
});
