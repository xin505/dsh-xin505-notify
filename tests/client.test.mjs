import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const completion = { id: 1, sessionId: 's1', turn: 7, kind: 'completed' };
const approval = { key: 'approval:3', callId: 'call-7', kind: 'approval', reason: 'private approval' };

async function startClient(options = {}) {
  const settings = { enabled: true, preview: false, ...options.settings };
  const requests = [];
  const cleanups = [], timeouts = new Map(), subscriptions = new Set(), listeners = new Map();
  const toastResults = [], visible = { value: options.focused === true };
  const readGates = options.readGates ?? [];
  let state = new Map(), rows = [], epoch = 'first', interval, module, component, ticks = 0, privateReads = 0;
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect() {},
    useSyncExternalStore(_sub, read) { return read(); },
  };
  const window = {
    crypto: options.noSubtleCrypto ? {} : webcrypto,
    __ModuleLoader__: { load(spec) { module = spec.factory(() => react); } },
    localStorage: { getItem() { return options.readyTest ? null : '1'; }, setItem() {} },
    setTimeout(fn, ms) { timeouts.set(++ticks, { fn, ms }); return ticks; },
    clearTimeout(key) { timeouts.delete(key); },
    setInterval(fn) { interval = fn; return 1; }, clearInterval() { interval = null; },
    addEventListener(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    async fetch(url, init = {}) {
      requests.push({ url, init });
      if (url.includes('/settings')) {
        if (init.method === 'POST') Object.assign(settings, JSON.parse(init.body));
        const copy = { ...settings };
        const promise = !init.method || init.method === 'GET' ? readGates.shift() : undefined;
        if (promise) await promise;
        return Response.json({ ok: true, ...copy });
      }
      if (url.includes('/events')) {
        const after = new URL(url,'http://test').searchParams.get('after');
        return Response.json({ ok: true, epoch, cursor: rows.length, events: after === null ? [] : rows.filter(row => row.id > Number(after)) });
      }
      const next = await toastResults.shift();
      if (next instanceof Error) throw next;
      return Response.json(next ?? { ok: true });
    },
  };
  vm.runInNewContext(source, { window, document: { visibilityState: visible.value ? 'visible' : 'hidden', hasFocus: () => visible.value }, console, TextEncoder, AbortController });
  const ctx = {
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); },
    locale: { register() {}, bind: () => key => key },
    slots: { inject(_name, fn) { fn(); }, register(_spec, comp) { component = comp; } },
    remote: {},
    uiSession: { sessionStatus: {
      getSnapshot() { return state; },
      subscribe(fn) { subscriptions.add(fn); return () => subscriptions.delete(fn); },
    } },
    get(name) {
      if (name !== 'sessions') return;
      privateReads++;
      return { binding: () => ({ eventSource: { getSnapshot: () => ({ entries: options.entries ?? [{ event: {
        type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: 'private final reply' }] } },
      } }] }) } }) };
    },
  };
  module.apply(ctx);
  await tick();
  return {
    settings, requests, toastResults, timeouts, get privateReads() { return privateReads; },
    toasts() { return requests.filter(r => r.url.endsWith('/toast')).map(r => JSON.parse(r.init.body)); },
    rows(value, newEpoch = epoch) { rows = value; epoch = newEpoch; },
    async poll() { await interval?.(); await tick(); },
    async update(...entries) { state = new Map(entries.map(([id, req]) => [id, { pendingInteraction: req }])); for (const fn of subscriptions) fn(); await tick(); },
    async trigger(name) { for (const fn of listeners.get(name) ?? []) fn(); await tick(); },
    unmount() { for (const fn of cleanups.reverse()) fn(); },
    async fireTimer() { const first = timeouts.entries().next().value; if (first) { timeouts.delete(first[0]); first[1].fn(); } await tick(); },
    switches() {
      const found = [];
      function visit(entry) { if (entry?.props?.role === 'switch') found.push(entry.props); for (const child of entry?.children ?? []) visit(child); }
      visit(component({ t: key => key })); return found;
    },
  };
}

test('default and legacy preferences send status only, without reading message histories', async () => {
  const c = await startClient({ settings: { preview: undefined } });
  c.rows([completion]); await c.poll();
  await c.update(['s1', approval]);
  assert.deepEqual(c.toasts().map(n => [n.type, n.body]), [['turn', undefined], ['pending', undefined]]);
  assert.equal(c.privateReads, 0);
  assert.equal(JSON.stringify(c.toasts()).includes('private'), false);
});
test('disabled preferences stop all UI requests for notifications', async () => {
  const c = await startClient({ settings: { enabled: false, preview: true } });
  c.rows([completion]); await c.poll(); await c.update(['s1', approval]);
  assert.equal(c.toasts().length, 0);
});
test('foreground, final outcomes and host epoch travel as typed hints, including recovery after a warning', async () => {
  const c = await startClient({ focused: true, settings: { preview: true } });
  c.rows([{ ...completion, hostAnnounced: true }]); await c.poll();
  c.rows([{ ...completion, kind: 'error', code: 'NO_ADAPTER' }], 'second'); await c.poll();
  assert.deepEqual(c.toasts(), [
    { type: 'turn', epoch: 'first', id: 1, locale: 'en', silent: true, body: 'private final reply' },
    { type: 'turn', epoch: 'second', id: 1, locale: 'en', silent: true },
  ]);
});
test('a tool-only final message does not preview an earlier assistant step', async () => {
  const entry = content => ({ event: { type: 'assistant/message', data: { turn: 7, message: { content } } } });
  const c = await startClient({ settings: { preview: true }, entries: [entry([{ type: 'text', text: 'working' }]), entry([{ type: 'tool-call' }])] });
  c.rows([completion]); await c.poll();
  assert.equal(c.toasts()[0].body, undefined);
});
test('delayed initial settings preserve recent events', async () => {
  let release;
  const c = await startClient({ readGates: [new Promise(r => { release = r; })] });
  c.rows([completion]); await c.poll();
  assert.equal(c.toasts().length, 0);
  release(); await tick(); await c.poll();
  assert.equal(c.toasts().length, 1);
});
test('review cards, settled questions, and questions continued by the agent stay quiet', async () => {
  const c = await startClient();
  const q = { key: 'question:2', kind: 'question', callId: 'q2', questions: [{ question: 'which?' }] };
  await c.update(['s1', { ...q, review: [] }]);
  await c.update(['s1', { ...q, kind: 'plan-review', getSnapshot: () => ({ state: 'continued' }) }]);
  await c.update(['s1', { ...q, getSnapshot: () => ({ closed: true }) }]);
  assert.equal(c.toasts().length, 0);
});
test('an outstanding approval recovers from network, timeout, and throttling with a stable identity', async () => {
  const c = await startClient({ settings: { preview: true } });
  c.toastResults.push(new Error('offline'), { ok: false, exit: 'timeout' }, { ok: false, exit: 'rate-limited' }, { ok: true });
  await c.update(['s1', approval]);
  for (let i = 0; i < 3; i++) await c.fireTimer();
  await c.update(['s1', approval]);
  assert.equal(c.toasts().length, 4);
  assert.equal(new Set(c.toasts().map(n => n.key)).size, 1);
  assert.ok(c.toasts().every(n => n.type === 'pending' && n.body === approval.reason));
});
test('recovery stops when the pending action has been answered', async () => {
  const c = await startClient();
  c.toastResults.push(new Error('offline'));
  await c.update(['s1', approval]); await c.update(); await c.fireTimer();
  assert.equal(c.toasts().length, 1);
});

test('a pending offer carries Host correlation and a settled reply is terminal', async () => {
  const c = await startClient();
  c.toastResults.push({ ok: false, exit: 'stale' });
  await c.update(['s1', approval]);
  await c.fireTimer();
  assert.equal(c.toasts().length, 1);
  assert.deepEqual(c.toasts()[0].ref, ['s1', approval.callId]);
});

test('a withdrawn approval still present in the view cannot trigger a toast', async () => {
  const c = await startClient();
  await c.update(['s1', { ...approval, answerable: false }]);
  assert.equal(c.toasts().length, 0);
});

test('a long outage pauses retries and reconnect resumes an outstanding approval', async () => {
  const c = await startClient();
  c.toastResults.push(...Array.from({ length: 6 }, () => new Error('offline')));
  await c.update(['s1', approval]);
  for (let i = 0; i < 7; i++) await c.fireTimer();
  assert.equal(c.toasts().length, 6);
  await c.trigger('online');
  assert.equal(c.toasts().length, 7);
  assert.equal(new Set(c.toasts().map(payload => payload.key)).size, 1);
});
test('related windows send the same pending key even when local approval numbers differ', async () => {
  const [one,two] = await Promise.all([startClient(),startClient()]);
  await one.update(['s1',approval]);
  await two.update(['s1',{ ...approval, key:'approval:94' }]);
  assert.ok(one.toasts()[0].key);
  assert.equal(one.toasts()[0].key, two.toasts()[0].key);
});

test('oversized shared tool IDs deduplicate across desktop and non-secure Web clients', async () => {
  const [desktop, web] = await Promise.all([startClient(), startClient({ noSubtleCrypto: true })]);
  const request = { ...approval, callId: 'tool-call-'.repeat(100) };
  await desktop.update(['s1', request]);
  await web.update(['s1', { ...request, key: 'approval:other-window' }]);
  const key = desktop.toasts()[0].key;
  assert.ok(Buffer.byteLength(key) < 512);
  assert.equal(web.toasts()[0].key, key);
});
test('arbitrary length localized approval and question text fits the JSON request limit', async () => {
  const c = await startClient({ settings: { preview: true } });
  const long = '文💬"\\'.repeat(1800);
  await c.update(['s1', { ...approval, displayReason: { en: long } }]);
  await c.update(['s2', { kind:'question', key:'q1', questions:[{ header:long, question:long }] }]);
  assert.equal(c.toasts().length, 2);
  for (const n of c.toasts()) { assert.ok(n.body); assert.ok(Buffer.byteLength(JSON.stringify(n)) <= 4096); }
});
test('switching off previews in another window prevents reading or posting private details', async () => {
  const c = await startClient({ settings: { preview: true } });
  c.settings.preview = false;
  c.rows([completion]); await c.poll();
  await c.update(['s1', approval]);
  assert.equal(c.privateReads, 0);
  assert.ok(c.toasts().every(n => !('body' in n)));
});
test('preview switch persists a partial preference update without changing the master switch', async () => {
  const c = await startClient();
  const switches = c.switches();
  assert.equal(switches.length, 2);
  await switches.find(s => s['aria-checked'] === false).onClick();
  const writes = c.requests.filter(r => r.url.endsWith('/update')).map(r => JSON.parse(r.init.body));
  assert.deepEqual(writes,[{ preview:true }]);
  assert.equal(c.settings.enabled,true);
});
test('self-test timers are cancelled on unload', async () => {
  const c = await startClient({ readyTest:true });
  assert.ok(c.timeouts.size);
  c.unmount(); await c.fireTimer();
  assert.deepEqual(c.toasts(), []);
});
