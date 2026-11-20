import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const clientScript = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const baseUrl = 'http://localhost/';

async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the notification bridge');
    await wait(15);
  }
}

// Only the Windows process and the DSH view are simulated. Both plugin halves,
// their JSON endpoints, settings file and native transport execute unmodified.
function connectPage(fetch, disposers) {
  let plugin;
  let status = new Map();
  const watchers = new Set();
  const listeners = new Map();
  const timers = new Set();
  const window = {
    __ModuleLoader__: { load: mod => { plugin = mod.factory(() => ({ createElement() {} })); } },
    __DSH_TRANSPORT__: { fetch }, crypto: webcrypto,
    localStorage: { getItem: () => '1', setItem() {} },
    setTimeout(...args) { const id = setTimeout(...args); timers.add(id); return id; },
    setInterval(...args) { const id = setInterval(...args); timers.add(id); return id; },
    clearInterval, clearTimeout,
    addEventListener(type, fn) {
      const group = listeners.get(type) ?? new Set();
      group.add(fn); listeners.set(type, group);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  disposers.push(() => { for (const timer of timers) clearTimeout(timer); });
  vm.runInNewContext(clientScript, {
    window, console, crypto: webcrypto, TextEncoder, TextDecoder, AbortController,
    document: { visibilityState: 'visible', hasFocus: () => true },
  });
  plugin.apply({
    effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); },
    slots: { inject() {}, register() {} }, get() {},
    locale: { register() {}, bind: () => key => key },
    uiSession: { sessionStatus: {
      getSnapshot: () => status,
      subscribe(fn) { watchers.add(fn); return () => watchers.delete(fn); },
    } },
  });
  return {
    focus() { for (const fn of listeners.get('focus') ?? []) fn(); },
    approval(key, callId, reason) {
      status = new Map([['shared-session', { pendingInteraction: { key, callId, kind: 'approval', reason } }]]);
      for (const fn of watchers) fn();
    },
  };
}

test('two windows share an approval delivery across a lost acknowledgement and respect the preview preference', async t => {
  const originalHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-notify-bridge-'));
  process.env.DSH_HOME = home;
  const native = [];
  const disposers = [];
  t.after(async () => {
    for (const off of disposers.reverse()) await off();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });
  t.mock.method(childProcess, 'spawn', (_exe, args) => {
    const process = new EventEmitter();
    process.stdin = new PassThrough();
    let data = '';
    process.stdin.setEncoding('utf8').on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      native.push({ args, payload: JSON.parse(data) });
      process.emit('close', 0);
    });
    return process;
  });
  syncBuiltinESMExports();
  const { apply } = await import('../index.js');
  const routes = new Map();
  apply({
    effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    on() { return () => {}; },
  });
  const settingsPath = '/api/dsh-xin505-notify/settings';
  const send = (path, options) => {
    const request = new Request(new URL(path, baseUrl), options);
    return routes.get(new URL(request.url).pathname).fetch(request);
  };
  const offers = [];
  let settingsReads = 0;
  let dropped = false;
  const page = () => connectPage(async (path, options) => {
    const response = await send(path, options);
    if (path.endsWith('/settings')) settingsReads++;
    if (path.endsWith('/toast')) {
      const payload = JSON.parse(options.body);
      offers.push(payload);
      if (!dropped && payload.type === 'pending' && response.ok && (await response.clone().json()).ok) {
        dropped = true;
        throw new TypeError('connection closed after delivery');
      }
    }
    return response;
  }, disposers);
  const first = page();
  const second = page();
  await until(() => settingsReads >= 2);
  const detail = 'synthetic-private-approval';
  first.approval('local-A', 'call-01', detail);
  second.approval('local-B', 'call-01', detail);
  await until(() => dropped && offers.length >= 3);
  assert.ok(dropped);
  assert.equal(new Set(offers.map(offer => offer.key)).size, 1, 'both windows and the retry use the same tool call');
  assert.equal(native.length, 1);
  assert.ok(!JSON.stringify([...offers, ...native]).includes(detail));

  const change = await send(settingsPath + '/update', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview: true }),
  });
  assert.deepEqual(await change.json(), { ok: true, enabled: true, preview: true });
  const readsBeforeFocus = settingsReads;
  first.focus();
  await until(() => settingsReads > readsBeforeFocus);
  const nextDetail = 'synthetic-opt-in-preview';
  first.approval('local-C', 'call-02', nextDetail);
  await until(() => native.length === 2);
  assert.equal(native[1].payload.body, nextDetail);
  assert.ok(!native[1].args.join(' ').includes(nextDetail));
});
