/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, tools only.
 * Small enough to ship without dependencies, since Codex installs plugins without running npm.
 */

import readline from 'node:readline';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * tools: [{ name, description, inputSchema, annotations?, handler(args, { meta, signal }) -> string }]
 * A handler's thrown error becomes an `isError` result, so the model sees the message.
 */
export function createMcpServer({ name, version, instructions, tools, input = process.stdin, output = process.stdout, onClose }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  /** request id -> AbortController of a running tool call, for notifications/cancelled */
  const running = new Map();

  const send = (message) => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  async function callTool(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    const controller = new AbortController();
    running.set(id, controller);
    let result;
    try {
      const text = await tool.handler(params.arguments ?? {}, { meta: params._meta ?? {}, signal: controller.signal });
      result = { content: [{ type: 'text', text }] };
    } catch (err) {
      result = { content: [{ type: 'text', text: err?.message ?? String(err) }], isError: true };
    } finally {
      running.delete(id);
    }
    // A cancelled request gets no response
    if (!controller.signal.aborted) reply(id, result);
  }

  function handle(message) {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return reply(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name, version },
          ...(instructions && { instructions }),
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: tools.map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            ...(annotations && { annotations }),
          })),
        });
      case 'tools/call':
        return void callTool(id, params);
      case 'notifications/cancelled':
        return void running.get(params?.requestId)?.abort();
      default:
        // Other notifications (initialized, roots changed...) need nothing
        if (isRequest) fail(id, -32601, `Method not found: ${method}`);
    }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    handle(message);
  });
  lines.on('close', () => onClose?.());

  return { close: () => lines.close() };
}
