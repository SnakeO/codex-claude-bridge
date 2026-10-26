/**
 * Holds messages from Claude Code and gets each one in front of Codex exactly once:
 * 1. handed to a read_claude_messages call that's waiting for one, else
 * 2. pushed into the Codex thread as a new turn (after a short debounce, so bursts arrive together), else
 * 3. left unread until Codex reads the inbox.
 */

const PUSH_DEBOUNCE_MS = 500;

/**
 * push(messages) -> Promise that resolves once they're queued into Codex and rejects if they
 * can't be (the messages then stay unread). Pass null to never push.
 */
export function createInbox({ push, debounceMs = PUSH_DEBOUNCE_MS, onPushError } = {}) {
  /** Messages Codex hasn't seen yet */
  const unread = [];
  /** Delivery updates for messages Codex sent, shown with the next tool result */
  const notices = [];
  /** Wake-up functions of read_claude_messages calls that are waiting */
  const waiters = new Set();
  let timer;
  let pushedSinceRead = 0;
  let lastPushError;

  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  async function flush() {
    timer = undefined;
    if (!push || waiters.size > 0 || unread.length === 0) return;
    const batch = unread.splice(0);
    // Counted from the start, so a read while `codex queue` runs says they're on their way
    pushedSinceRead += batch.length;
    try {
      await push(batch);
      lastPushError = undefined;
    } catch (err) {
      pushedSinceRead = Math.max(0, pushedSinceRead - batch.length);
      unread.unshift(...batch);
      lastPushError = err?.message ?? String(err);
      onPushError?.(lastPushError);
      wake(); // a read may have started while the push was running
    }
  }

  return {
    add(message) {
      unread.push(message);
      if (waiters.size > 0) wake();
      else if (push && !timer) timer = setTimeout(flush, debounceMs);
    },

    notice(text) {
      notices.push(text);
    },

    /** Unread messages and notices, which this marks as seen. */
    take() {
      const taken = { messages: unread.splice(0), notices: notices.splice(0), pushedSinceRead };
      pushedSinceRead = 0;
      return taken;
    },

    /** Like take(), but first waits up to `seconds` for a message if none is unread. */
    async wait(seconds, signal) {
      if (unread.length === 0 && seconds > 0 && !signal?.aborted) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', done);
            waiters.delete(done);
            resolve();
          };
          const timeout = setTimeout(done, seconds * 1000);
          signal?.addEventListener('abort', done, { once: true });
          waiters.add(done);
        });
      }
      return this.take();
    },

    status: () => ({ unread: unread.length, notices: notices.length, waiting: waiters.size, lastPushError }),

    close() {
      clearTimeout(timer);
      wake();
    },
  };
}
