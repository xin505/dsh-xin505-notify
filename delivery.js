// Host-owned delivery. A page may enrich a scheduled turn, or ask for a
// pending interaction once. Only a successful native call acknowledges a key.
const MAX_QUEUED = 512;
const MAX_SEEN = 2048;
const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const TRANSIENT = new Set([1, 'busy', 'rate-limited', 'timeout', 'interrupted', 'spawn-error', 'delivery-error', 'stdin-error', 'settings-error']);

export function createDelivery(send, log) {
  const queued = new Map();
  const pending = new Map();
  const seen = new Map();
  let wake;
  let draining = false;
  let blockedUntil = 0;
  let disposed = false;

  function alreadySent(key) {
    const at = seen.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < SEEN_FOR_MS) return true;
    seen.delete(key);
    return false;
  }

  function acknowledge(key) {
    seen.set(key, Date.now());
    if (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  }

  async function attempt(message) {
    try { return await send(message); }
    catch { return { ok: false, exit: 'delivery-error' }; }
  }

  function arm() {
    clearTimeout(wake);
    if (disposed || draining || !queued.size) return;
    let soonest = Infinity;
    for (const job of queued.values()) soonest = Math.min(soonest, job.due);
    const delay = Math.max(0, Math.max(soonest, blockedUntil) - Date.now());
    wake = setTimeout(drain, delay);
    wake.unref?.();
  }

  async function drain() {
    if (disposed || draining) return;
    draining = true;
    try {
      for (const [key, job] of queued) {
        if (disposed || blockedUntil > Date.now()) break;
        if (job.due > Date.now()) continue;
        const result = await attempt(job.message);
        if (queued.get(key) !== job) continue; // disabled, disposed or replaced while in flight
        job.attempts++;
        if (result.ok) acknowledge(key);
        if (result.ok || !TRANSIENT.has(result.exit) || job.attempts >= MAX_ATTEMPTS) {
          queued.delete(key);
          if (!result.ok) log('automatic notification delivery ended without acknowledgement');
          continue;
        }
        if (result.exit === 'rate-limited' || result.exit === 'busy') blockedUntil = Date.now() + 10500;
        job.due = Date.now() + 500 * 2 ** (job.attempts - 1);
      }
    } finally {
      draining = false;
      arm();
    }
  }

  function schedule(key, message, delay = 0) {
    if (disposed || alreadySent(key) || queued.has(key)) return;
    if (queued.size >= MAX_QUEUED) { log('automatic notification queue full'); return; }
    queued.set(key, { message, due: Date.now() + delay, attempts: 0 });
    arm();
  }

  function enrich(key, message) {
    const job = queued.get(key);
    if (job) {
      // Any focused window makes the notification silent. Windows with no
      // retained transcript must not replace another window's approved preview.
      const body = message.body !== message.fallbackBody ? message.body
        : job.message.body !== job.message.fallbackBody ? job.message.body : message.fallbackBody;
      job.message = { ...message, body, silent: Boolean(job.message.silent || message.silent) };
    }
  }

  function clearPreviews() {
    for (const job of queued.values()) job.message.body = job.message.fallbackBody;
  }

  function once(key, message) {
    if (disposed) return Promise.resolve({ ok: false, exit: 'disabled' });
    if (alreadySent(key)) return Promise.resolve({ ok: true, exit: 0 });
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= MAX_QUEUED) return Promise.resolve({ ok: false, exit: 'busy' });
    const operation = attempt(message).then(result => {
      if (pending.get(key) === operation) {
        pending.delete(key);
        if (result.ok) acknowledge(key);
      }
      return result;
    });
    pending.set(key, operation);
    return operation;
  }

  function clear() {
    clearTimeout(wake);
    queued.clear();
    pending.clear();
    seen.clear();
    blockedUntil = 0;
  }

  return { schedule, enrich, once, clearPreviews, clear, dispose() { disposed = true; clear(); } };
}
