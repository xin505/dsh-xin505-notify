import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dsh-notify-test-'));
process.env.DSH_HOME = home;
process.env.SystemRoot = join(home, 'missing-windows');
const { apply } = await import('../index.js');
const routes = new Map();
const routeModes = new Map();
const registeredPaths = new Set();
const events = new Map();
const dispose = [];
const ctx = {
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') dispose.push(cleanup); },
  connection: { fetch: { register(route) { assert.ok(!registeredPaths.has(route.path), 'DSH requires unique route path'); registeredPaths.add(route.path); for (const method of route.methods) { routes.set(`${method} ${route.path}`, route.fetch); routeModes.set(`${method} ${route.path}`, route.requestBody); } return () => {}; } } },
  on(name, handler) { events.set(name, handler); return () => events.delete(name); },
};
apply(ctx);
const base = '/api/dsh-xin505-notify/';
async function request(method, path, body) {
  const routePath = method === 'POST' && path === 'settings' ? 'settings/update' : path;
  const handler = routes.get(`${method} ${base}${routePath}`);
  assert.ok(handler, `${method} ${path} registered`);
  return handler(new Request('http://localhost' + base + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) }));
}
test('settings read uses buffered transport while updates remain streaming', () => {
  assert.equal(routeModes.get('GET ' + base + 'settings'), 'buffered');
  assert.equal(routeModes.get('POST ' + base + 'settings/update'), 'streaming');
});
test('persistent setting controls host and client notifications without leaking content', async () => {
  const initial = await request('GET', 'settings');
  assert.deepEqual(await initial.json(), { ok: true, enabled: true });
  const disabled = await request('POST', 'settings', { enabled: false });
  assert.deepEqual(await disabled.json(), { ok: true, enabled: false });
  assert.equal(JSON.parse(await readFile(join(home, 'dsh-xin505-notify', 'settings.json'), 'utf8')).enabled, false);
  const toast = await request('POST', 'toast', { title: 'private-title-123', body: 'private-body-456' });
  assert.equal((await toast.json()).exit, 'disabled');
  let nextCalled = false;
  events.get('agent/request-error')({ failure: { code: 'QUOTA', message: 'private-quota-789' } }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  const log = await readFile(join(home, 'dsh-xin505-notify', 'toast.log'), 'utf8');
  assert.doesNotMatch(log, /private-title-123|private-body-456|private-quota-789/);
});
test('disabled setting survives a new host module instance', async () => {
  const restarted = await import('../index.js?restart=1');
  const restartRoutes = new Map();
  const callbacks = [];
  const restartContext = {
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') callbacks.push(cleanup); },
    connection: { fetch: { register(route) { restartRoutes.set(route.path, route.fetch); return () => {}; } } },
    on() { return () => {}; },
  };
  restarted.apply(restartContext);
  const handler = restartRoutes.get(base + 'settings');
  const response = await handler(new Request('http://localhost' + base + 'settings'));
  assert.deepEqual(await response.json(), { ok: true, enabled: false });
  const previousEpoch = await (await routes.get('GET ' + base + 'events')(new Request('http://localhost' + base + 'events'))).json();
  const restartedEpoch = await (await restartRoutes.get(base + 'events')(new Request('http://localhost' + base + 'events'))).json();
  assert.equal(typeof previousEpoch.epoch, 'string');
  assert.equal(typeof restartedEpoch.epoch, 'string');
  assert.notEqual(previousEpoch.epoch, restartedEpoch.epoch);
  for (const cleanup of callbacks) cleanup();
});
test('settings reject invalid data and toast rejects oversized input', async () => {
  assert.equal((await request('POST', 'settings', { enabled: 'false' })).status, 400);
  assert.equal((await request('POST', 'toast', JSON.stringify({ body: 'x'.repeat(8192) }))).status, 413);
});
test('enabled toast log excludes private content even on a spawn failure', async () => {
  await request('POST', 'settings', { enabled: true });
  await request('POST', 'toast', { title: 'secret-title-abc', body: 'secret-body-xyz' });
  const log = await readFile(join(home, 'dsh-xin505-notify', 'toast.log'), 'utf8');
  assert.doesNotMatch(log, /secret-title-abc|secret-body-xyz/);
});
test('disabling host events does not suppress a later alert after re-enabling', async () => {
  await request('POST', 'settings', { enabled: false });
  const send = () => events.get('agent/request-error')({ agent: { id: 'new-session' }, failure: { code: 'QUOTA', message: 'private' } }, () => {});
  send();
  await request('POST', 'settings', { enabled: true });
  send();
  await new Promise(resolve => setTimeout(resolve, 50));
  const log = await readFile(join(home, 'dsh-xin505-notify', 'toast.log'), 'utf8');
  assert.match(log, /source=host:quota/);
});
test('live turn events are bounded to metadata and distinguish completion, failure and subagents', async () => {
  const poll = async (after) => {
    const handler = routes.get(`GET ${base}events`);
    assert.ok(handler, 'GET events registered');
    const query = after === undefined ? '' : `?after=${after}`;
    return (await handler(new Request('http://localhost' + base + 'events' + query))).json();
  };
  const first = await poll();
  assert.deepEqual(first.events, []);
  const emit = (session, data) => events.get('session/event')(session, { type: 'turn/end', data });
  emit({ id: 'top', header: {} }, { turn: 1, reason: { kind: 'completed' } });
  emit({ id: 'child', header: { origin: 'subagent' } }, { turn: 1, reason: { kind: 'completed' } });
  emit({ id: 'top', header: {} }, { turn: 2, reason: { kind: 'error', error: { code: 'QUOTA', message: 'secret-content-must-not-leak' } } });
  const result = await poll(first.cursor);
  assert.deepEqual(result.events.map(({ sessionId, kind, code }) => ({ sessionId, kind, code })), [
    { sessionId: 'top', kind: 'completed', code: undefined },
    { sessionId: 'top', kind: 'error', code: 'QUOTA' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret-content-must-not-leak/);
  assert.deepEqual((await poll(result.cursor)).events, []);
  assert.deepEqual((await poll()).events, []);
  events.get('agent/request-error')({ agent: { id: 'top' }, turn: 20, failure: { code: 'QUOTA', message: 'secret-key' } }, () => {});
  emit({ id: 'top', header: {} }, { turn: 20, reason: { kind: 'error', error: { code: 'QUOTA', message: 'secret-key' } } });
  const failedNativeToast = await poll(result.cursor);
  assert.equal(failedNativeToast.events.at(-1).hostAnnounced, false, 'native failure must not suppress terminal fallback');
  assert.doesNotMatch(JSON.stringify(failedNativeToast), /secret-key/);
  for (let turn = 3; turn < 140; turn++) emit({ id: 'top', header: {} }, { turn, reason: { kind: 'completed' } });
  assert.equal((await poll(first.cursor)).events.length, 128);
  await request('POST', 'settings', { enabled: false });
  const beforeDisabled = await poll();
  emit({ id: 'top', header: {} }, { turn: 140, reason: { kind: 'completed' } });
  assert.deepEqual((await poll(beforeDisabled.cursor)).events, []);
  await request('POST', 'settings', { enabled: true });
});
test('toast requests are capped under concurrent and repeated load', async () => {
  const requests = Array.from({ length: 15 }, () => request('POST', 'toast', { title: 'load-test' }));
  const results = await Promise.all(requests);
  const bodies = await Promise.all(results.map(result => result.json()));
  assert.ok(bodies.some(body => body.exit === 'rate-limited'));
});
test.after(async () => { for (const fn of dispose) fn(); await rm(home, { recursive: true, force: true }); });
