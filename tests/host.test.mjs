import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { registerNotifications } from '../index.js';

function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const routes = new Map();
  const listeners = new Map();
  const cleanups = [];
  const calls = [];
  const answers = [];
  const logs = [];
  let settings = { enabled: true, preview: false };
  const ctx = {
    effect(fn) { cleanups.push(fn()); },
    connection: { fetch: { register(route) {
      assert.ok(!routes.has(route.path));
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    } } },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
  };
  registerNotifications(ctx, {
    appendLog(line) { logs.push(line); },
    readSettings() { return settings; },
    updateSettings(patch) { settings = { ...settings, ...patch }; return settings; },
    async showToast(toast) { calls.push(toast); return await (answers.shift() ?? { ok: true, exit: 0 }); },
  });
  const close = () => { for (const fn of cleanups.splice(0).reverse()) fn?.(); };
  t.after(close);
  return {
    routes, calls, answers, logs, close,
    emit(name, ...args) { return listeners.get(name)?.(...args); },
    end(turn, reason, session = { id: 's', header: {} }) {
      listeners.get('session/event')(session, { type: 'turn/end', data: { turn, reason } });
    },
    error(turn, code, session = { id: 's', header: {} }) {
      let continued = false;
      listeners.get('agent/request-error')({ agent: { id: session.id, session }, turn, failure: { code, message: 'private failure' } }, () => { continued = true; });
      assert.equal(continued, true);
    },
    async tick(ms) { t.mock.timers.tick(ms); await flush(); t.mock.timers.tick(0); await flush(); },
    async request(path, data) {
      const url = new URL('/api/dsh-xin505-notify/' + path, 'http://localhost');
      const route = routes.get(url.pathname);
      const request = new Request(url, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      assert.ok(route.methods.includes(request.method));
      return route.fetch(request);
    },
  };
}

test('settings preserve previous fields, allow only booleans and keep transport modes', async t => {
  const host = setup(t);
  assert.deepEqual(await (await host.request('settings')).json(), { ok: true, enabled: true, preview: false });
  assert.equal(host.routes.get('/api/dsh-xin505-notify/settings').requestBody, 'buffered');
  assert.equal(host.routes.get('/api/dsh-xin505-notify/settings/update').requestBody, 'streaming');
  assert.deepEqual(await (await host.request('settings/update', { preview: true })).json(), { ok: true, enabled: true, preview: true });
  assert.deepEqual(await (await host.request('settings/update', { enabled: false })).json(), { ok: true, enabled: false, preview: true });
  for (const patch of [null, {}, { unknown: true }, { enabled: 'false' }, { preview: null }])
    assert.equal((await host.request('settings/update', patch)).status, 400);
  assert.equal((await host.request('toast', { type: 'test', body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await host.request('toast', { title: 'arbitrary', body: 'private' })).status, 400);
  assert.equal((await (await host.request('toast', { type: 'test' })).json()).exit, 'disabled');
  assert.equal(host.calls.length, 0);
});

test('without a page the host delivers completed/error/interrupted top-level turns and skips user stops', async t => {
  const host = setup(t);
  host.end(1, { kind: 'completed' });
  host.end(2, { kind: 'error', error: { code: 'UNKNOWN', message: 'private failure' } });
  host.end(3, { kind: 'aborted', reason: { kind: 'user' } });
  host.end(4, { kind: 'aborted', reason: { kind: 'hook', reason: 'private hook' } });
  host.end(5, { kind: 'completed' }, { id: 'child', header: { delegationDepth: 1 } });
  assert.deepEqual((await (await host.request('events')).json()).events, []);
  const feed = await (await host.request('events?after=0')).json();
  assert.deepEqual(feed.events.map(e => e.turn), [1, 2, 3, 4]);
  assert.equal(feed.events.at(-1).cause, 'hook');
  assert.doesNotMatch(JSON.stringify(feed), /private/);
  assert.equal(host.calls.length, 0);
  await host.tick(2300);
  assert.equal(host.calls.length, 3);
  assert.equal(new Set(host.calls.map(toast => toast.title)).size, 3);
});

test('two windows and a replay enrich just one terminal toast; preview-off rejects private details', async t => {
  const host = setup(t);
  host.end(1, { kind: 'completed' });
  const { epoch, events } = await (await host.request('events?after=0')).json();
  const input = { type: 'turn', epoch, id: events[0].id, silent: false, locale: 'zh', body: 'private preview' };
  for (const silent of [false, true, false]) assert.equal((await (await host.request('toast', { ...input, silent })).json()).ok, true);
  await host.tick(2300);
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].silent, true);
  assert.doesNotMatch(JSON.stringify(host.calls), /private preview/);
  assert.equal((await (await host.request('toast', input)).json()).ok, true);
  await host.tick(3000);
  assert.equal(host.calls.length, 1);
});

test('private preview is retained only for eligible completion and is cleared upon disabling previews', async t => {
  const host = setup(t);
  const update = async (turn, body) => {
    host.end(turn, { kind: 'completed' });
    const { epoch, events } = await (await host.request('events?after=0')).json();
    await host.request('toast', { type: 'turn', epoch, id: events.at(-1).id, locale: 'zh', body });
  };
  await host.request('settings/update', { preview: true });
  await update(1, 'opt-in preview');
  await host.tick(2300);
  assert.equal(host.calls[0].body, 'opt-in preview');
  assert.notEqual(host.calls[0].fallbackBody, host.calls[0].body);
  await update(2, 'stale preview');
  await host.request('settings/update', { preview: false });
  await host.request('settings/update', { preview: true });
  await host.tick(2300);
  assert.doesNotMatch(JSON.stringify(host.calls), /stale preview/);
});

test('retry success and a different terminal failure notify; matching warning and duplicate sign-in do not', async t => {
  const host = setup(t);
  host.error(1, 'RATE_LIMIT');
  await host.tick(1);
  host.end(1, { kind: 'completed' });
  host.error(2, 'RATE_LIMIT');
  await host.tick(1);
  host.end(2, { kind: 'error', error: { code: 'QUOTA' } });
  host.error(3, 'ACCOUNT_SIGN_IN_REQUIRED');
  host.emit('deepseek-account/model-sign-in-required');
  host.end(3, { kind: 'error', error: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } });
  host.error(4, 'QUOTA', { id: 'child', header: { origin: 'subagent' } });
  await host.tick(2500);
  assert.equal(host.calls.length, 5);
  assert.equal(new Set(host.calls.map(toast => toast.title)).size, 4);
  assert.doesNotMatch(JSON.stringify(host.calls), /private failure/);
});

test('account delivery retries an initial limit; the next independent expiration is still delivered', async t => {
  const host = setup(t);
  host.answers.push({ ok: false, exit: 'rate-limited' });
  host.emit('deepseek-account/session-expired');
  await host.tick(1);
  assert.equal(host.calls.length, 1);
  await host.tick(11000);
  assert.equal(host.calls.length, 2);
  host.emit('deepseek-account/session-expired');
  await host.tick(1);
  assert.equal(host.calls.length, 3);
});

test('concurrent and repeated pending requests share actual native outcome; a transient failure remains eligible', async t => {
  const host = setup(t);
  const item = { type: 'pending', kind: 'approval', key: 'same-interaction', body: 'private reason', locale: 'en' };
  let finish;
  host.answers.push(new Promise(resolve => { finish = resolve; }));
  const first = host.request('toast', item), second = host.request('toast', item);
  await flush();
  assert.equal(host.calls.length, 1);
  finish({ ok: false, exit: 'timeout' });
  for (const response of await Promise.all([first, second])) assert.equal((await response.json()).exit, 'timeout');
  assert.equal((await (await host.request('toast', item)).json()).ok, true);
  assert.equal((await (await host.request('toast', item)).json()).ok, true);
  assert.equal(host.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(host.calls), /private reason/);
});

test('a Windows process interruption or transient WinRT failure retries, while a disabled notification channel stays quiet', async t => {
  const host = setup(t);
  host.answers.push({ ok: false, exit: 'interrupted' }, { ok: false, exit: 1 }, { ok: true, exit: 0 });
  host.end(1, { kind: 'completed' });
  await host.tick(2300);
  await host.tick(600);
  await host.tick(1100);
  assert.equal(host.calls.length, 3);
  host.answers.push({ ok: false, exit: 2 });
  host.end(2, { kind: 'completed' });
  await host.tick(2300);
  await host.tick(11000);
  assert.equal(host.calls.length, 4);
});

test('disabling and disposing cancel queued notices and turn enrichment cannot revive stale events', async t => {
  const host = setup(t);
  host.end(1, { kind: 'completed' });
  const { epoch, events } = await (await host.request('events?after=0')).json();
  await host.request('settings/update', { enabled: false });
  await host.request('settings/update', { enabled: true });
  await host.request('toast', { type: 'turn', epoch, id: events[0].id, body: 'stale' });
  await host.tick(2300);
  assert.equal(host.calls.length, 0);
  host.end(2, { kind: 'completed' });
  host.close();
  await host.tick(2300);
  assert.equal(host.calls.length, 0);
});

test('a late renderer offer cannot revive a settled Host approval or question', async t => {
  const host = setup(t);
  const agent = { session: { id: 's', header: {} } };
  for (const [event, kind, ids] of [
    ['approval/request', 'approval', { callId: 'call' }],
    ['user-questions/request', 'plan-review', { wait: { callId: 'call' } }],
    ['user-questions/request', 'question', {}],
  ]) {
    let finish;
    const answer = host.emit(event, { agent, ...ids }, () => new Promise(resolve => { finish = resolve; }));
    await flush();
    finish('expected-answer');
    assert.equal(await answer, 'expected-answer');
    const result = await (await host.request('toast', {
      type: 'pending', kind, key: kind, ref: ['s', ids.callId ?? ids.wait?.callId ?? null],
    })).json();
    assert.equal(result.exit, 'stale');
  }
  assert.equal(host.calls.length, 0);
});

test('overlapping anonymous requests remain eligible until the last Host request ends', async t => {
  const host = setup(t);
  const agent = { session: { id: 's', header: {} } };
  let complete;
  const second = host.emit('user-questions/request', { agent }, () => new Promise(ok => { complete = ok; }));
  await host.emit('user-questions/request', { agent }, () => Promise.resolve('first resolved'));
  const item = { type: 'pending', kind: 'question', key: 'active', ref: ['s', null] };
  assert.equal((await (await host.request('toast', item)).json()).ok, true);
  complete('second resolved'); await second;
  assert.equal((await (await host.request('toast', { ...item, key: 'late' })).json()).exit, 'stale');
  assert.equal(host.calls.length, 1);
});
