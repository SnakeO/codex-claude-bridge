import test from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../plugins/claude-bridge/server/inbox.mjs';
import { waitFor } from './helpers.mjs';

const msg = (text) => ({ id: text, from: 'uds:/tmp/c.sock', fromName: 'main', text, ts: 0 });

test('messages are pushed in one batch after the debounce', async () => {
  const pushed = [];
  const inbox = createInbox({ push: async (batch) => pushed.push(batch.map((m) => m.text)), debounceMs: 30 });
  inbox.add(msg('a'));
  inbox.add(msg('b'));
  await waitFor(() => pushed.length === 1, { what: 'push' });
  assert.deepEqual(pushed, [['a', 'b']]);
  const taken = inbox.take();
  assert.deepEqual(taken.messages, []);
  assert.equal(taken.pushedSinceRead, 2);
  assert.equal(inbox.take().pushedSinceRead, 0);
  inbox.close();
});

test('a waiting read gets the message and nothing is pushed', async () => {
  const pushed = [];
  const inbox = createInbox({ push: async (batch) => pushed.push(batch), debounceMs: 30 });
  const reading = inbox.wait(5);
  setTimeout(() => inbox.add(msg('reply')), 20);
  const { messages } = await reading;
  assert.deepEqual(messages.map((m) => m.text), ['reply']);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pushed.length, 0);
  inbox.close();
});

test('a read during the debounce takes the message before it is pushed', async () => {
  const pushed = [];
  const inbox = createInbox({ push: async (batch) => pushed.push(batch), debounceMs: 50 });
  inbox.add(msg('quick'));
  assert.deepEqual(inbox.take().messages.map((m) => m.text), ['quick']);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pushed.length, 0);
  inbox.close();
});

test('a failed push leaves the messages unread', async () => {
  const errors = [];
  const inbox = createInbox({ push: async () => { throw new Error('no thread'); }, debounceMs: 10, onPushError: (e) => errors.push(e) });
  inbox.add(msg('kept'));
  await waitFor(() => errors.length === 1, { what: 'push error' });
  assert.equal(inbox.status().lastPushError, 'no thread');
  assert.equal(inbox.status().unread, 1);
  assert.deepEqual(inbox.take().messages.map((m) => m.text), ['kept']);
  inbox.close();
});

test('without push, messages wait for a read; notices come along', async () => {
  const inbox = createInbox({ push: null });
  inbox.add(msg('x'));
  inbox.notice('Your message to "main" is now expired.');
  await new Promise((r) => setTimeout(r, 30));
  const taken = inbox.take();
  assert.deepEqual(taken.messages.map((m) => m.text), ['x']);
  assert.deepEqual(taken.notices, ['Your message to "main" is now expired.']);
  assert.deepEqual(inbox.take(), { messages: [], notices: [], pushedSinceRead: 0 });
  inbox.close();
});

test('wait times out empty, and stops early when aborted', async () => {
  const inbox = createInbox({ push: null });
  const started = Date.now();
  assert.deepEqual((await inbox.wait(0.05)).messages, []);
  assert.ok(Date.now() - started >= 40);

  const controller = new AbortController();
  const reading = inbox.wait(30, controller.signal);
  setTimeout(() => controller.abort(), 20);
  assert.deepEqual((await reading).messages, []);
  assert.equal(inbox.status().waiting, 0);
  inbox.close();
});
