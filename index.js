import { randomUUID } from 'node:crypto';
import { createDelivery } from './delivery.js';
import * as native from './native.js';

export const inject = ['connection'];

const BASE = '/api/dsh-xin505-notify/';
const MAX_REQUEST_BYTES = 4096;
const TURN_GRACE_MS = 2200;
const PENDING_KINDS = new Set(['approval', 'question', 'plan-review']);
const END_KINDS = new Set(['completed', 'error', 'blocked', 'max-tokens', 'aborted']);
const CANCEL_CAUSES = new Set(['user', 'hook', 'parent', 'disposed']);
const COPY = {
  completed: ['回复完成', '请回到 DeepSeek Harness 查看结果。', 'Reply finished', 'Return to DeepSeek Harness to see the result.'],
  failed: ['执行出错', '这一轮没有正常完成。', 'Turn failed', 'This turn did not finish.'],
  interrupted: ['任务已中断', '请回到 DeepSeek Harness 查看中断的任务。', 'Task interrupted', 'Return to DeepSeek Harness to check the interrupted task.'],
  quota: ['额度或余额不足', '模型服务报告可用额度不足，请检查余额或配额。', 'Quota or balance exhausted', 'The model service reported insufficient quota or balance.'],
  auth: ['需要登录或检查凭证', '请检查模型服务的登录状态或凭证。', 'Sign-in or credentials need attention', 'Check the model service sign-in or credentials.'],
  config: ['请检查模型配置', '未找到可用的模型服务。', 'Check model configuration', 'No model service is available.'],
  rate: ['请求受到限流', '请查看会话中的重试状态。', 'Rate limited', 'Check the retry status in the session.'],
  expired: ['登录已过期', '请重新登录 DeepSeek Harness 账号。', 'Session expired', 'Sign in to DeepSeek Harness again.'],
  approval: ['需要你的确认', '有一个操作在等你授权。', 'Approval needed', 'An operation is waiting for your decision.'],
  question: ['需要你回答', '代理有一个问题在等你回答。', 'Answer needed', 'The agent is waiting for your answer.'],
  'plan-review': ['需要审阅计划', '有一份计划在等你审阅。', 'Plan review needed', 'A plan is waiting for your review.'],
  ready: ['桌面通知已就绪', '桌面通知已经开启。', 'Desktop notifications are ready', 'Desktop notifications are on.'],
  test: ['测试通知', '桌面通知通道正常。', 'Test notification', 'Desktop notifications are working.'],
};

function defaultLocale() {
  const locale = process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh/i.test(locale) ? 'zh' : 'en';
}

function makeMessage(kind, locale, silent = false, detail = '') {
  const offset = locale === 'zh' ? 0 : 2;
  const text = COPY[kind];
  const fallbackBody = text[offset + 1];
  return {
    title: 'DeepSeek Harness · ' + text[offset], body: detail || fallbackBody, fallbackBody,
    silent, source: 'host:' + kind,
  };
}

function failureKind(code) {
  switch (code) {
    case 'QUOTA': case 'ACCOUNT_QUOTA': return 'quota';
    case 'AUTH': case 'MISSING_CREDENTIAL': case 'INVALID_CREDENTIAL':
    case 'ACCOUNT_SIGN_IN_REQUIRED': case 'ACCOUNT_TOKEN_INVALID': return 'auth';
    case 'NO_ADAPTER': return 'config';
    case 'RATE_LIMIT': return 'rate';
    default: return undefined;
  }
}

function terminalKind(event) {
  if (event.kind === 'aborted') return ['parent', 'hook', 'disposed'].includes(event.cause) ? 'interrupted' : undefined;
  if (event.kind === 'completed') return 'completed';
  return failureKind(event.code) ?? 'failed';
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mainSession = session => typeof session?.id === 'string' && session.header?.origin !== 'subagent' && !(session.header?.delegationDepth > 0);
const turnKey = (sessionId, turn, kind) => JSON.stringify(['turn', sessionId, turn, kind]);
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const invalid = () => json({ ok: false, exit: 'invalid-request' }, 400);

async function readBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !request.body) return { status: 400 };
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) return { status: 413 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) return { status: 413 };
      chunks.push(value);
    }
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch { return { status: 400 }; }
  finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

export function apply(ctx) { registerNotifications(ctx, native); }

export function registerNotifications(ctx, { readSettings, updateSettings, showToast, appendLog }) {
  appendLog('plugin applied');
  const delivery = createDelivery(showToast, appendLog);
  const epoch = randomUUID();
  const feed = [];
  // The waterfall owns the decision. Keep only its lifetime and routing identity.
  const pendingRequests = new Map();
  let requestGeneration = 0;
  function pendingRef(kind, sessionId, callId) {
    return JSON.stringify([kind === 'approval' ? 'approval' : 'question', sessionId, callId]);
  }

  function observePending(kind) {
    return async (request, next) => {
      const sessionId = request?.agent?.session?.id;
      if (typeof sessionId !== 'string') return next();
      const callId = (kind === 'approval' ? request.callId : request.wait?.callId) ?? null;
      const key = pendingRef(kind, sessionId, callId);
      let record = pendingRequests.get(key);
      if (!record || !record.active) {
        if (record) pendingRequests.delete(key);
        if (pendingRequests.size >= 2048) {
          // Eviction makes an identity unknown. An unobserved request remains eligible.
          pendingRequests.delete(pendingRequests.keys().next().value);
        }
        record = { active: 0, generation: ++requestGeneration };
        pendingRequests.set(key, record);
      }
      record.active++;
      let finished = false;
      const finish = () => {
        if (!finished) { finished = true; record.active--; }
      };
      const signal = request.signal;
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
      try { return await next(); }
      finally { finish(); signal?.removeEventListener('abort', finish); }
    };
  }
  let cursor = 0;
  let expiration = 0;

  function enabled() {
    try { return readSettings().enabled; } catch { return false; }
  }

  function getEvents(request) {
    const raw = new URL(request.url).searchParams.get('after');
    if (raw === null) return json({ ok: true, epoch, cursor, events: [] });
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) return invalid();
    return json({ ok: true, epoch, cursor, events: feed.filter(e => e.id > Number(raw)) });
  }

  function changeSettings(patch) {
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !['enabled', 'preview'].includes(key) || typeof patch[key] !== 'boolean')) return invalid();
    const settings = updateSettings(patch);
    if (!settings.enabled) { delivery.clear(); feed.length = 0; }
    else if (!settings.preview) delivery.clearPreviews();
    return json({ ok: true, ...settings });
  }

  async function handleToast(input) {
    if (!['test', 'ready', 'pending', 'turn'].includes(input.type)) return invalid();
    const settings = readSettings();
    if (!settings.enabled) return json({ ok: false, exit: 'disabled' });
    const locale = ['zh', 'en'].includes(input.locale) ? input.locale : defaultLocale();
    const silent = input.silent === true;
    const detail = settings.preview && typeof input.body === 'string' ? [...input.body].slice(0, 180).join('') : '';
    if (input.type === 'turn') {
      if (!Number.isSafeInteger(input.id) || typeof input.epoch !== 'string') return invalid();
      const event = input.epoch === epoch && feed.find(e => e.id === input.id);
      if (!event) return json({ ok: false, exit: 'stale' });
      const kind = terminalKind(event);
      if (kind) delivery.enrich(turnKey(event.sessionId, event.turn, kind), makeMessage(kind, locale, silent, kind === 'completed' ? detail : ''));
      // Final delivery belongs to the Host even when this response is lost.
      return json({ ok: true });
    }
    if (input.type === 'pending') {
      if (!PENDING_KINDS.has(input.kind) || typeof input.key !== 'string' || !input.key.length || Buffer.byteLength(input.key) > 512) return invalid();
      let record;
      if (input.ref !== undefined) {
        const ref = input.ref;
        if (!Array.isArray(ref) || ref.length !== 2 || typeof ref[0] !== 'string' ||
            (ref[1] !== null && typeof ref[1] !== 'string')) return invalid();
        record = pendingRequests.get(pendingRef(input.kind, ref[0], ref[1]));
        if (record && !record.active) return json({ ok: false, exit: 'stale' });
      }
      const key = JSON.stringify(['pending', input.kind, input.key, record?.generation ?? 0]);
      return json(await delivery.once(key, makeMessage(input.kind, locale, silent, detail)));
    }
    const message = makeMessage(input.type, locale, silent);
    return json(await (input.type === 'ready' ? delivery.once('ready', message) : showToast(message)));
  }

  function onTurn(session, event) {
    if (event?.type !== 'turn/end' || !mainSession(session) || !enabled()) return;
    const { turn, reason } = event.data ?? {};
    if (!Number.isSafeInteger(turn) || turn < 0 || !END_KINDS.has(reason?.kind)) return;
    // Owner pages only receive routing metadata. Free-form hook reasons and
    // provider messages stay on their original, session-scoped paths.
    const row = { id: ++cursor, sessionId: session.id, turn, kind: reason.kind };
    if (reason.kind === 'error' && typeof reason.error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(reason.error.code)) row.code = reason.error.code;
    if (reason.kind === 'aborted' && CANCEL_CAUSES.has(reason.reason?.kind)) row.cause = reason.reason.kind;
    feed.push(row);
    if (feed.length > 128) feed.shift();
    const kind = terminalKind(row);
    if (kind) delivery.schedule(turnKey(session.id, turn, kind), makeMessage(kind, defaultLocale()), TURN_GRACE_MS);
  }

  function onRequest(payload, next) {
    try {
      const kind = failureKind(payload?.failure?.code);
      const session = payload?.agent?.session;
      if (kind && mainSession(session) && Number.isSafeInteger(payload.turn) && payload.turn >= 0 && enabled()) {
        delivery.schedule(turnKey(session.id, payload.turn, kind), makeMessage(kind, defaultLocale()));
      }
    } catch { appendLog('request-error listener failed'); }
    return next();
  }

  ctx.effect(() => {
    const handlers = [];
    function route(path, method, handler) {
      handlers.push(ctx.connection.fetch.register({
        path: BASE + path, methods: [method], requestBody: method === 'POST' ? 'streaming' : 'buffered',
        fetch: async request => {
          try {
            if (method === 'GET') return await handler(request);
            const body = await readBody(request);
            if (body.status) return json({ ok: false, exit: 'invalid-request' }, body.status);
            if (!isRecord(body.value)) return invalid();
            return await handler(body.value);
          } catch { return json({ ok: false, exit: 'host-error' }, 503); }
        },
      }));
    }
    route('events', 'GET', getEvents);
    route('settings', 'GET', () => json({ ok: true, ...readSettings() }));
    route('settings/update', 'POST', changeSettings);
    route('toast', 'POST', handleToast);
    handlers.push(ctx.on('session/event', onTurn), ctx.on('agent/request-error', onRequest));
    handlers.push(ctx.on('approval/request', observePending('approval'), { prepend: true }));
    handlers.push(ctx.on('user-questions/request', observePending('question'), { prepend: true }));
    // rc.3 emits model-sign-in-required from the same ACCOUNT_SIGN_IN_REQUIRED
    // agent/error. The request/turn listeners already own that notification.
    handlers.push(ctx.on('deepseek-account/session-expired', () => {
      if (enabled()) delivery.schedule('expired:' + ++expiration, makeMessage('expired', defaultLocale()));
    }));
    return () => {
      delivery.dispose();
      pendingRequests.clear();
      for (const off of handlers) void off();
    };
  }, 'dsh-xin505-notify: notifications');
}
