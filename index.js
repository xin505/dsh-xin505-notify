/**
 * Host half of the desktop-notify bundle.
 *
 * Two jobs:
 *
 * 1. It owns the actual Windows popup. `POST /api/dsh-xin505-notify/toast`
 *    runs Windows PowerShell 5.1 — which carries the WinRT projections — with
 *    `toast.ps1` and the application's own AppUserModelId, so the notification
 *    appears as "DeepSeek Harness". The browser half decides *when* to notify,
 *    because only the page knows whether the window is in front, and calls
 *    this route.
 *
 * 2. Account and quota failures are announced here, because the Host — not the
 *    page — sees the provider-neutral failure codes (`QUOTA`, `ACCOUNT_QUOTA`,
 *    `AUTH`, `RATE_LIMIT`).
 *
 * Every attempt is appended to `$DSH_HOME/dsh-xin505-notify/toast.log` so a
 * missing popup can be diagnosed without a debugger.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Required Host service: the connection owns the authenticated page-facing route. */
export const inject = ['connection'];

const HERE = dirname(fileURLToPath(import.meta.url));
const TOAST_SCRIPT = join(HERE, 'toast.ps1');
/** The desktop shell's own AppUserModelId, registered by its Start Menu shortcut. */
const APP_ID = 'com.deepseek.dsh';
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
const MAX_TITLE = 120;
const MAX_BODY = 400;
const MAX_LOG_BYTES = 256 * 1024;
const SPAWN_TIMEOUT_MS = 10_000;

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const LOG_DIR = join(HOME, 'dsh-xin505-notify');
const LOG_FILE = join(LOG_DIR, 'toast.log');
const SETTINGS_FILE = join(LOG_DIR, 'settings.json');
const MAX_REQUEST_BYTES = 4096;
const MAX_CONCURRENT = 2;
const RATE_LIMIT_COUNT = 10;
const RATE_LIMIT_MS = 10_000;
let active = 0;
let recentToasts = [];

function readEnabled() {
  let raw;
  try { raw = readFileSync(SETTINGS_FILE, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
  const value = JSON.parse(raw);
  if (!value || typeof value.enabled !== 'boolean') throw new Error('invalid settings');
  return value.enabled;
}
function saveEnabled(enabled) {
  mkdirSync(LOG_DIR, { recursive: true });
  const temp = join(LOG_DIR, `settings-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ enabled }) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, SETTINGS_FILE);
  } finally { try { unlinkSync(temp); } catch {} }
}
async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return { status: 400 };
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return { status: 413 };
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) return { status: 413 };
      chunks.push(value);
    }
    try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
    catch { return { status: 400 }; }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}


const TITLES = {
  quota: { zh: '额度不足 / 余额用完', en: 'Quota or balance exhausted' },
  auth: { zh: '需要检查登录或凭证', en: 'Sign-in or credentials need attention' },
  config: { zh: '需要配置模型', en: 'Model configuration required' },
  rate: { zh: '请求被限流了', en: 'Rate limited' },
  expired: { zh: '登录已过期', en: 'Session expired' },
};

function chineseHost() {
  try {
    const raw = process.env.LC_ALL ?? process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    return String(raw).toLowerCase().includes('zh');
  } catch {
    return true;
  }
}

/** Localized copy for a Host-initiated toast. */
function titleOf(kind) {
  const entry = TITLES[kind];
  if (entry === undefined) return 'DeepSeek Harness';
  return 'DeepSeek Harness · ' + (chineseHost() ? entry.zh : entry.en);
}

function appendLog(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > MAX_LOG_BYTES) writeFileSync(LOG_FILE, '');
    } catch {
      // No log file yet.
    }
    appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n', 'utf8');
  } catch {
    // Diagnostics must never break the notifier.
  }
}

/** One-line, length-bounded, control-free text safe to hand to PowerShell. */
function clean(value, limit) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, limit).join('');
}

/**
 * Raise one Windows popup.
 * @returns `{ ok, exit }`; `exit` is the PowerShell exit code or a transport word.
 */
function showToast(input) {
  try { if (!readEnabled()) return Promise.resolve({ ok: false, exit: 'disabled' }); }
  catch { return Promise.resolve({ ok: false, exit: 'settings-error' }); }
  const now = Date.now();
  recentToasts = recentToasts.filter(at => now - at < RATE_LIMIT_MS);
  if (active >= MAX_CONCURRENT || recentToasts.length >= RATE_LIMIT_COUNT) return Promise.resolve({ ok: false, exit: 'rate-limited' });
  recentToasts.push(now);
  active++;
  const title = clean(input.title, MAX_TITLE) || 'DeepSeek Harness';
  const body = clean(input.body, MAX_BODY);
  const source = typeof input.source === 'string' ? input.source : 'unknown';
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', TOAST_SCRIPT,
    '-Title', title,
    '-Body', body === '' ? ' ' : body,
    '-AppId', APP_ID,
  ];
  if (input.silent === true) args.push('-Silent');

  return new Promise((resolve) => {
    let settled = false;
    let stdoutText = '';
    let stderrText = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      active--;
      appendLog(`exit=${String(result.exit)} source=${source} silent=${input.silent === true}`);
      resolve(result);
    };

    let child;
    try {
      child = spawn(POWERSHELL, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, exit: 'spawn-threw' });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      finish({ ok: false, exit: 'timeout' });
    }, SPAWN_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      if (stdoutText.length < 2000) stdoutText += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderrText.length < 2000) stderrText += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, exit: 'spawn-error' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exit = typeof code === 'number' ? code : String(code);
      if (typeof exit === 'string') {
        stdoutText = stdoutText.trim();
        stderrText = stderrText.trim();
      } else {
        stdoutText = stdoutText.trim().slice(0, 300);
        stderrText = stderrText.trim().slice(0, 300);
      }
      finish({ ok: exit === 0, exit });
    });
  });
}

/** Provider-neutral failure code -> notification kind, or undefined to stay quiet. */
function failureKind(code) {
  switch (String(code ?? '').toUpperCase()) {
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return 'quota';
    case 'AUTH':
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'ACCOUNT_TOKEN_INVALID':
      return 'auth';
    case 'NO_ADAPTER':
      return 'config';
    case 'RATE_LIMIT':
      return 'rate';
    default:
      return undefined;
  }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

export function apply(ctx) {
  appendLog('plugin applied');
  // The shared owner route has no workspace-scoped principal. Expose only
  // bounded routing metadata, never assistant or provider error text.
  let eventCursor = 0;
  const epoch = randomUUID();
  const eventBuffer = [];
  const immediateAlerts = new Map();
  const turnKey = (sessionId, turn) => JSON.stringify([sessionId, turn]);

  ctx.effect(() => {
    const registrations = [];
    registrations.push(ctx.connection.fetch.register({
      path: '/api/dsh-xin505-notify/events', methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        const raw = new URL(request.url).searchParams.get('after');
        if (raw === null) return json({ ok: true, epoch, cursor: eventCursor, events: [] });
        if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) return json({ ok: false }, 400);
        const after = Number(raw);
        const cursor = eventCursor;
        const snapshot = eventBuffer.filter(event => event.id > after && event.id <= cursor);
        const events = await Promise.all(snapshot.map(async ({ alert, ...event }) => ({
          ...event, ...(alert ? { hostAnnounced: await alert } : {}),
        })));
        return json({ ok: true, epoch, cursor, events });
      },
    }));
    registrations.push(ctx.connection.fetch.register({
      path: '/api/dsh-xin505-notify/settings', methods: ['GET'], requestBody: 'buffered',
      fetch: async () => {
        try { return json({ ok: true, enabled: readEnabled() }); }
        catch { return json({ ok: false, exit: 'settings-error' }, 503); }
      },
    }));
    registrations.push(ctx.connection.fetch.register({
      path: '/api/dsh-xin505-notify/settings/update', methods: ['POST'], requestBody: 'streaming',
      fetch: async (request) => {
        const body = await readBody(request);
        if (body.status) return json({ ok: false, exit: 'invalid-request' }, body.status);
        if (!body.value || Array.isArray(body.value) || typeof body.value.enabled !== 'boolean') return json({ ok: false, exit: 'invalid-request' }, 400);
        try { saveEnabled(body.value.enabled); return json({ ok: true, enabled: readEnabled() }); }
        catch { return json({ ok: false, exit: 'settings-error' }, 503); }
      },
    }));
    registrations.push(ctx.connection.fetch.register({
      path: '/api/dsh-xin505-notify/toast', methods: ['POST'], requestBody: 'streaming',
      fetch: async (request) => {
        const body = await readBody(request);
        if (body.status) return json({ ok: false, exit: 'invalid-request' }, body.status);
        if (!body.value || Array.isArray(body.value) || typeof body.value !== 'object') return json({ ok: false, exit: 'invalid-request' }, 400);
        const result = await showToast({ title: body.value.title, body: body.value.body, silent: body.value.silent === true, source: 'client' });
        return json(result);
      },
    }));
    return () => { for (const dispose of registrations) void dispose(); };
  }, 'dsh-xin505-notify: routes');

  // ---- account and quota announcements -------------------------------

  ctx.effect(() => {
    const recent = new Map();
    const throttled = (key, windowMs) => {
      const now = Date.now();
      for (const [id, at] of recent) if (now - at > windowMs) recent.delete(id);
      const last = recent.get(key);
      if (last !== undefined && now - last < windowMs) return true;
      recent.set(key, now);
      return false;
    };

    const announce = (kind, body, key, windowMs) => {
      try { if (!readEnabled()) return Promise.resolve(false); } catch { return Promise.resolve(false); }
      if (throttled(key, windowMs)) return Promise.resolve(false);
      return showToast({ title: titleOf(kind), body, source: 'host:' + kind }).then(result => result.ok);
    };

    const offSessionEvent = ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end' || !session || typeof session.id !== 'string') return;
      try { if (!readEnabled()) return; } catch { return; }
      if (session.header?.origin === 'subagent' || session.header?.delegationDepth > 0) return;
      const { turn, reason } = event.data ?? {};
      if (!Number.isSafeInteger(turn) || turn < 0 || !['completed', 'error', 'aborted', 'blocked', 'max-tokens'].includes(reason?.kind)) return;
      const code = reason.kind === 'error' && typeof reason.error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(reason.error.code)
        ? reason.error.code : undefined;
      const key = turnKey(session.id, turn);
      const alert = immediateAlerts.get(key);
      immediateAlerts.delete(key);
      eventBuffer.push({ id: ++eventCursor, sessionId: session.id, turn, kind: reason.kind,
        ...(code ? { code } : {}), ...(alert ? { alert } : {}) });
      if (eventBuffer.length > 128) eventBuffer.shift();
    });

    // One failed model request: quota, credential and rate-limit codes are the
    // ones the user must act on; every other failure is already visible in chat.
    const offRequestError = ctx.on('agent/request-error', function (payload, next) {
      try {
        const failure = payload?.failure;
        const kind = failureKind(failure?.code);
        if (kind !== undefined) {
          const fallback = kind === 'quota'
            ? '这一轮因为额度或余额不足停下了，充值后可以继续。'
            : kind === 'auth'
              ? '请检查模型服务的登录状态或凭证。'
              : kind === 'config'
                ? '未找到可用的模型服务，请检查模型配置。'
                : '请求过于频繁，请查看会话中的重试状态。';
          const sessionId = String(payload?.agent?.session?.id ?? payload?.agent?.id ?? 'session');
          const alert = announce(kind, fallback, kind + ':' + sessionId, 60_000);
          if (Number.isSafeInteger(payload?.turn)) {
            const key = turnKey(sessionId, payload.turn);
            const previous = immediateAlerts.get(key);
            immediateAlerts.set(key, previous ? Promise.all([previous, alert]).then(values => values.some(Boolean)) : alert);
            if (immediateAlerts.size > 128) immediateAlerts.delete(immediateAlerts.keys().next().value);
          }
        }
      } catch (error) {
        appendLog('request-error listener failed');
      }
      return next();
    });

    const offSignIn = ctx.on('deepseek-account/model-sign-in-required', () => {
      announce('auth', '有一条请求需要你登录 DeepSeek Harness 账号。', 'sign-in-required', 300_000);
    });

    const offExpired = ctx.on('deepseek-account/session-expired', () => {
      announce('expired', '登录已过期，请重新登录 DeepSeek Harness 账号。', 'session-expired', 300_000);
    });

    return () => {
      offSessionEvent();
      offRequestError();
      offSignIn();
      offExpired();
    };
  }, 'dsh-xin505-notify: account events');
}
