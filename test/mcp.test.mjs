import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMcpServer } from '../plugins/claude-bridge/server/mcp.mjs';
import { waitFor } from './helpers.mjs';

function harness(t, tools) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      responses.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  let closed = false;
  const server = createMcpServer({ name: 'test', version: '1.2.3', instructions: 'Be nice.', tools, input, output, onClose: () => (closed = true) });
  t.after(() => server.close());
  const send = (message) => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const response = (id) => waitFor(() => responses.find((r) => r.id === id), { what: `response ${id}` });
  return { send, response, responses, input, isClosed: () => closed };
}

const echo = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  handler: async (args, { meta }) => `${args.text}|${meta.threadId ?? '-'}`,
};

test('initialize echoes a supported protocol version and falls back otherwise', async (t) => {
  const h = harness(t, [echo]);
  h.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
  assert.deepEqual((await h.response(1)).result, {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'test', version: '1.2.3' },
    instructions: 'Be nice.',
  });
  h.send({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal((await h.response(2)).result.protocolVersion, '2025-06-18');
});

test('lists and calls tools, passing _meta through', async (t) => {
  const boom = { name: 'boom', description: 'Fails', inputSchema: { type: 'object' }, handler: async () => { throw new Error('kaput'); } };
  const h = harness(t, [echo, boom]);
  h.send({ id: 1, method: 'tools/list' });
  assert.deepEqual((await h.response(1)).result.tools, [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'boom', description: 'Fails', inputSchema: { type: 'object' } },
  ]);

  h.send({ id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' }, _meta: { threadId: 't1' } } });
  assert.deepEqual((await h.response(2)).result, { content: [{ type: 'text', text: 'hi|t1' }] });

  h.send({ id: 3, method: 'tools/call', params: { name: 'boom' } });
  assert.deepEqual((await h.response(3)).result, { content: [{ type: 'text', text: 'kaput' }], isError: true });

  h.send({ id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.equal((await h.response(4)).error.code, -32602);
});

test('answers ping, rejects unknown methods, ignores notifications', async (t) => {
  const h = harness(t, [echo]);
  h.send({ method: 'notifications/initialized' });
  h.send({ id: 'p', method: 'ping' });
  assert.deepEqual((await h.response('p')).result, {});
  h.send({ id: 9, method: 'resources/list' });
  assert.equal((await h.response(9)).error.code, -32601);
  assert.equal(h.responses.length, 2);
});

test('reports parse errors', async (t) => {
  const h = harness(t, [echo]);
  h.input.write('{not json\n');
  const error = await waitFor(() => h.responses.find((r) => r.error?.code === -32700), { what: 'parse error' });
  assert.equal(error.id, null);
});

test('a cancelled call aborts its handler and gets no response', async (t) => {
  let aborted = false;
  const slow = {
    name: 'slow',
    description: 'Waits',
    inputSchema: { type: 'object' },
    handler: (args, { signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve('late'); })),
  };
  const h = harness(t, [slow]);
  h.send({ id: 1, method: 'tools/call', params: { name: 'slow' } });
  await new Promise((r) => setTimeout(r, 30));
  h.send({ method: 'notifications/cancelled', params: { requestId: 1 } });
  await waitFor(() => aborted, { what: 'abort' });
  h.send({ id: 2, method: 'ping' });
  await h.response(2);
  assert.equal(h.responses.some((r) => r.id === 1), false);
});

test('calls onClose when input ends', async (t) => {
  const h = harness(t, [echo]);
  h.input.end();
  await waitFor(() => h.isClosed(), { what: 'close' });
});
