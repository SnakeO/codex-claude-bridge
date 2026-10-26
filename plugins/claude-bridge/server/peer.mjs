/**
 * Claude Code's local peer protocol: the session registry, the per-session Unix sockets, and the
 * NDJSON frames sessions exchange. Ported from Inspector Jake's session-bridge.ts.
 *
 * Each Claude Code session listens on `<socket dir>/<pid>.sock` and registers itself in
 * `<config dir>/sessions/<pid>.json`, which is how names resolve to sockets. The bridge does the
 * same, so sessions can find it by name and reply to it.
 *
 * This is Claude Code's internal protocol (observed in Claude Code 2.1.303 to 2.1.310), not a
 * public API, so any release can change it.
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

const SEND_TIMEOUT_MS = 5000;
/** Claude Code's own client half-closes this long after writing. */
const HALF_CLOSE_DELAY_MS = 150;
/** How long send() waits for a held/refused status before calling a message delivered. */
const STATUS_WAIT_MS = 1500;
/** Larger than Claude Code's 1 MiB per-message limit, so a valid frame always fits. */
const MAX_INBOUND_BUFFER = 2 * 1024 * 1024;
/** Where Claude Code puts its sockets when no live session says otherwise. */
const DEFAULT_SOCKET_DIR = '/tmp/cc-socks';
const WRAPPER_TAG = 'cross-session-message';

const WRAPPER_RE = new RegExp(
  `^<${WRAPPER_TAG}` +
    '(?: from="([^"]+)")?' +
    '(?: from-session="([^"]+)")?' +
    '(?: hop-chain="([^"]+)")?' +
    '(?: from-name="([^"<>\\n\\r]+)")?' +
    '(?: from-mode="([^"]+)")?' +
    '(?: from-plugin="([^"<>\\n\\r]+)")?' +
    `>\\n([\\s\\S]*)\\n</${WRAPPER_TAG}>$`
);

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Address form Claude Code uses for a socket path: `uds:` plus the path, with any byte
 * outside [A-Za-z0-9:_/.\-] percent-encoded.
 */
export function socketAddress(socketPath) {
  const encoded = socketPath.replace(/[^A-Za-z0-9:_/.\\-]/gu, (ch) =>
    Array.from(Buffer.from(ch, 'utf8'), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  );
  return `uds:${encoded}`;
}

/** Socket path of a `uds:` address, or undefined for anything else. */
export function socketPathOf(address) {
  if (typeof address !== 'string' || !address.startsWith('uds:')) return undefined;
  try {
    return decodeURIComponent(address.slice(4));
  } catch {
    return undefined;
  }
}

/** Wrap a body the way Claude Code wraps cross-session messages. */
export function wrapContent(from, fromName, body) {
  const attrs = [`from="${from}"`];
  const name = fromName?.replace(/["<>\n\r]/g, '');
  if (name) attrs.push(`from-name="${name}"`);
  return `<${WRAPPER_TAG} ${attrs.join(' ')}>\n${body}\n</${WRAPPER_TAG}>`;
}

/** One NDJSON line carrying a message. No `from-mode`: the bridge has no permission mode to attest. */
export function encodeFrame(from, fromName, body, msgId = randomUUID()) {
  return (
    JSON.stringify({
      msgV: 1,
      msg_id: msgId,
      type: 'user',
      message: { role: 'user', content: wrapContent(from, fromName, body) },
      priority: 'next',
      from,
    }) + '\n'
  );
}

export function parseWrapper(content) {
  const m = content.match(WRAPPER_RE);
  if (!m) return null;
  return {
    ...(m[1] !== undefined && { from: m[1] }),
    ...(m[2] !== undefined && { fromSession: m[2] }),
    ...(m[4] !== undefined && { fromName: m[4] }),
    ...(m[5] !== undefined && { fromMode: m[5] }),
    ...(m[6] !== undefined && { fromPlugin: m[6] }),
    body: m[7],
  };
}

/**
 * Interpret one line received on the bridge socket:
 * `{kind:'message', message}`, `{kind:'status', status}`, or null for auth lines and anything else.
 */
export function parseFrameLine(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object') return null;

  if (frame.type === 'user') {
    const content = frame.message?.content;
    if (typeof content !== 'string') return null;
    const wrapped = parseWrapper(content);
    const from = wrapped?.from ?? (typeof frame.from === 'string' ? frame.from : 'unknown');
    return {
      kind: 'message',
      message: {
        from,
        ...(wrapped?.fromName && { fromName: wrapped.fromName }),
        text: wrapped ? wrapped.body : content,
      },
    };
  }

  if (frame.type === 'control' && frame.action === 'peer_message_status' && typeof frame.status === 'string') {
    return {
      kind: 'status',
      status: {
        status: frame.status,
        ...(typeof frame.reason === 'string' && { reason: frame.reason }),
        ...(typeof frame.orig_msg_id === 'string' && { origMsgId: frame.orig_msg_id }),
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function registryDirFor(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

/** Every well-formed record in the registry, live or not. */
export function readRecords(registryDir) {
  let files;
  try {
    files = fs.readdirSync(registryDir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(registryDir, file), 'utf8'));
      return record && Number.isInteger(record.pid) && typeof record.messagingSocketPath === 'string' ? [record] : [];
    } catch {
      return []; // torn or foreign file
    }
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Field 22 (starttime, in clock ticks since boot) of /proc/<pid>/stat. The command
 * name in field 2 can contain spaces, so split after its closing parenthesis.
 */
export function parseStatStartTime(stat) {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/**
 * Process start time as Claude Code records it (`procStart`). Claude Code re-reads it to decide
 * whether a record is live, so it must match:
 * - macOS: `ps -o lstart=` in UTC, C locale
 * - Linux: the starttime field of /proc/<pid>/stat
 */
export async function readProcStart(pid, platform = process.platform) {
  if (platform === 'linux') {
    return parseStatStartTime(await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8')) ?? '';
  }
  const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeout: 2000,
  });
  return stdout.trim();
}

/** Start times of several processes in one `ps` call; pids that are gone are left out. */
export async function readProcStarts(pids, platform = process.platform) {
  const starts = new Map();
  if (pids.length === 0) return starts;
  if (platform === 'linux') {
    await Promise.all(
      pids.map((pid) =>
        readProcStart(pid, platform).then(
          (start) => start && starts.set(pid, start),
          () => {}
        )
      )
    );
    return starts;
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 3000,
    }));
  } catch (err) {
    // ps exits 1 when some pid is gone, but still prints the live ones
    stdout = err.stdout ?? '';
  }
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) starts.set(Number(m[1]), m[2]);
  }
  return starts;
}

/**
 * The `pidDomain` Claude Code stamps on records; records from another domain are ignored.
 * - macOS: the platform name
 * - Linux (WSL too): platform, machine-id and PID namespace, so containers don't mix
 */
export async function readPidDomain(platform = process.platform) {
  if (platform !== 'linux') return platform;
  const [machineId, pidNamespace] = await Promise.all([
    fs.promises.readFile('/etc/machine-id', 'utf8').then((s) => s.trim(), () => ''),
    fs.promises.readlink('/proc/self/ns/pid').catch(() => ''),
  ]);
  return `linux:${machineId}:${pidNamespace}`;
}

const sameStart = (a, b) => a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ');

/**
 * Live sessions in the registry, newest first. A record is live when its pid runs and, if the
 * record has a `procStart`, that pid started at the recorded time (so a reused pid doesn't count).
 * `claude` is true for Claude Code sessions (records with a `kind`); other peers are bridges and scripts.
 */
export async function listSessions({ env = process.env, platform = process.platform, excludePid, readStarts = readProcStarts } = {}) {
  const records = readRecords(registryDirFor(env)).filter((r) => r.pid !== excludePid && pidAlive(r.pid));
  let starts;
  try {
    starts = await readStarts(records.map((r) => r.pid), platform);
  } catch {
    starts = undefined; // can't check start times, so trust the pids
  }
  return records
    .filter((r) => !starts || typeof r.procStart !== 'string' || (starts.has(r.pid) && sameStart(starts.get(r.pid), r.procStart)))
    .map((r) => ({
      pid: r.pid,
      name: typeof r.name === 'string' ? r.name : undefined,
      cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
      status: typeof r.status === 'string' ? r.status : undefined,
      kind: typeof r.kind === 'string' ? r.kind : undefined,
      version: typeof r.version === 'string' ? r.version : undefined,
      socketPath: r.messagingSocketPath,
      address: socketAddress(r.messagingSocketPath),
      claude: typeof r.kind === 'string',
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The session `to` names: a `uds:` address, or a registered name. A name shared by several
 * sessions resolves to the Claude Code session if exactly one has it, else it's an error.
 */
export function resolveTarget(to, sessions) {
  const target = String(to ?? '').trim();
  const socketPath = socketPathOf(target);
  if (socketPath) {
    return sessions.find((s) => s.socketPath === socketPath) ?? { socketPath, address: target, claude: false };
  }
  const named = sessions.filter((s) => s.name === target);
  const claude = named.filter((s) => s.claude);
  if (claude.length === 1 || (claude.length === 0 && named.length > 0)) return claude[0] ?? named[0];
  if (claude.length > 1) {
    const choices = claude.map((s) => `${s.address} (pid ${s.pid}, ${s.cwd ?? 'unknown folder'})`).join('; ');
    throw new Error(`Several Claude Code sessions are named "${target}". Send to one of their addresses instead: ${choices}`);
  }
  const live = sessions.filter((s) => s.claude && s.name).map((s) => `"${s.name}"`);
  throw new Error(
    `No live session is named "${target}".` +
      (live.length ? ` Claude Code sessions: ${live.join(', ')}.` : ' No Claude Code sessions are running.')
  );
}

/** Lowercase letters, digits and dashes, as Claude Code session names are. */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** `base`, or `base-2`, `base-3`... whichever no live session uses. */
export function uniqueName(base, sessions) {
  const taken = new Set(sessions.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** The directory Claude Code sessions listen in. Claude Code only replies to sockets inside it. */
export function socketDirFor(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    if (!s.claude) continue;
    const dir = path.dirname(s.socketPath);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_SOCKET_DIR;
}

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Resolve whether something is accepting connections on a socket path. */
function isSocketLive(socketPath) {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const done = (live) => {
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(250, () => done(false));
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Write one frame to a session's socket and half-close, as Claude Code's own client does. */
function writeFrame(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let failed = false;
    const fail = (message) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      conn.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('Timed out sending to the session.'), SEND_TIMEOUT_MS);
    conn.on('connect', () => conn.write(frame, () => setTimeout(() => conn.end(), HALF_CLOSE_DELAY_MS)));
    conn.on('error', (err) => fail(`Could not reach the session: ${err.message}`));
    conn.on('close', () => {
      if (failed) return;
      clearTimeout(timer);
      resolve();
    });
    conn.resume();
  });
}

/**
 * Register this process as a peer session called `name` and listen for messages.
 * Throws when it can't (unsupported platform, socket in use, registry not writable).
 *
 * opts: { name, version, cwd?, onMessage(message), onStatus(status), env?, platform?, pid?,
 *         socketDir?, readProcStart?, readPidDomain?, readStarts?, statusWaitMs? }
 */
export async function createPeer(opts) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const pid = opts.pid ?? process.pid;
  const readStarts = opts.readStarts ?? readProcStarts;
  const statusWaitMs = opts.statusWaitMs ?? STATUS_WAIT_MS;

  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Claude Code peer messaging isn't supported on ${platform} yet (macOS and Linux only).`);
  }

  const sessionsNow = () => listSessions({ env, platform, excludePid: pid, readStarts });
  const registryDir = registryDirFor(env);
  const registryFile = path.join(registryDir, `${pid}.json`);
  const socketDir = opts.socketDir ?? env.CLAUDE_BRIDGE_SOCKET_DIR ?? socketDirFor(await sessionsNow());
  const socketPath = path.join(socketDir, `${pid}.sock`);
  const from = socketAddress(socketPath);

  let name = opts.name;
  let cwd = opts.cwd ?? process.cwd();
  let nameSince = Date.now();
  let closed = false;
  /** msg_id -> resolver of the send() waiting for its delivery status */
  const pendingStatus = new Map();
  /** msg_id -> who it went to, so a late status can say which message it's about */
  const sentTo = new Map();

  const handleLine = (line) => {
    if (!line.trim()) return;
    const parsed = parseFrameLine(line);
    if (parsed?.kind === 'message') {
      opts.onMessage?.({ id: randomUUID(), ...parsed.message, ts: Date.now() });
    } else if (parsed?.kind === 'status') {
      const { origMsgId } = parsed.status;
      const waiting = origMsgId && pendingStatus.get(origMsgId);
      if (waiting) waiting(parsed.status);
      else opts.onStatus?.({ ...parsed.status, ...(origMsgId && sentTo.has(origMsgId) && { to: sentTo.get(origMsgId) }) });
    }
  };

  const server = net.createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_INBOUND_BUFFER) {
        conn.destroy();
        return;
      }
      let newline;
      while (!conn.destroyed && (newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    conn.on('end', () => {
      if (!conn.destroyed) handleLine(buffer);
      conn.end();
    });
    conn.on('error', () => {});
  });

  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(socketPath)) {
    if (await isSocketLive(socketPath)) throw new Error(`Another process is already listening on ${socketPath}.`);
    fs.unlinkSync(socketPath);
  }
  await listen(server, socketPath);
  fs.chmodSync(socketPath, 0o600);

  const removeSocket = () => fs.rmSync(socketPath, { force: true });
  let procStart;
  let pidDomain;
  try {
    procStart = await (opts.readProcStart ?? ((p) => readProcStart(p, platform)))(pid);
    if (!procStart) throw new Error('empty process start time');
    pidDomain = await (opts.readPidDomain ?? (() => readPidDomain(platform)))();
  } catch (err) {
    server.close();
    removeSocket();
    throw new Error(`Could not read this process's start time: ${err.message}`);
  }

  const startedAt = Date.now();
  const writeRecord = () => {
    const now = Date.now();
    // No `kind`: Claude Code's resume logic treats interactive/bg entries as open sessions in `cwd`
    writeFileAtomic(
      registryFile,
      JSON.stringify({
        pid,
        cwd,
        startedAt,
        procStart,
        version: `codex-claude-bridge@${opts.version}`,
        peerProtocol: 1,
        peerFeatures: [],
        entrypoint: 'codex-claude-bridge',
        pidDomain,
        messagingSocketPath: socketPath,
        name,
        nameSource: 'user',
        nameSince,
        status: 'idle',
        updatedAt: now,
        statusUpdatedAt: now,
      })
    );
  };

  try {
    fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    writeRecord();
  } catch (err) {
    server.close();
    removeSocket();
    throw new Error(`Could not register in ${registryDir}: ${err.message}`);
  }

  return {
    info: () => ({ name, socketPath, address: from }),

    sessions: sessionsNow,

    /** Re-register under a new name, and optionally a new working folder. */
    rename(newName, newCwd = cwd) {
      if (closed || (newName === name && newCwd === cwd)) return;
      if (newName !== name) nameSince = Date.now();
      name = newName;
      cwd = newCwd;
      writeRecord();
    },

    /**
     * Send `text` to the session `to` names. Resolves to {msgId, target, status, reason?}, where
     * status is "delivered" unless the session reported "held", "refused" or the like in time.
     */
    async send(to, text) {
      if (closed) throw new Error('The bridge is shut down.');
      const target = resolveTarget(to, await sessionsNow());
      if (target.socketPath === socketPath) throw new Error('That address is this bridge itself.');
      const msgId = randomUUID();
      const status = new Promise((resolve) => pendingStatus.set(msgId, resolve));
      sentTo.set(msgId, target.name ?? target.address);
      if (sentTo.size > 200) sentTo.delete(sentTo.keys().next().value);
      try {
        await writeFrame(target.socketPath, encodeFrame(from, name, text, msgId));
        const reported = await Promise.race([status, new Promise((r) => setTimeout(r, statusWaitMs, null))]);
        return {
          msgId,
          target,
          status: reported?.status ?? 'delivered',
          ...(reported?.reason && { reason: reported.reason }),
        };
      } finally {
        pendingStatus.delete(msgId);
      }
    },

    /** Remove the socket and registry entry. Synchronous so it can run on exit; safe to repeat. */
    close() {
      if (closed) return;
      closed = true;
      server.close();
      removeSocket();
      fs.rmSync(registryFile, { force: true });
    },
  };
}
