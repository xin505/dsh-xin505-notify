import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

async function startClient(enabled, focused = false, config = {}) {
  const handlers = new Map();
  const requests = [];
  let snapshot = new Map();
  let eventRows = [];
  let epoch = 'first';
  const toastResults = [];
  const timers = [];
  let poll;
  const statusListeners = new Set();
  let module;
  const window = {
    __ModuleLoader__: { load(value) { module = value.factory(() => ({ createElement() {} })); } },
    localStorage: { getItem(key) { return key.endsWith(':verified') ? '1' : null; }, setItem() {} },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    setInterval(fn) { poll = fn; return 1; }, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
    async fetch(url, options = {}) {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() {
        if (url.includes('/settings')) { if (config.settingsGate) await config.settingsGate; return { ok: true, enabled }; }
        if (url.includes('/events')) {
          const after = /[?&]after=(\d+)/.exec(url);
          return { ok: true, epoch, cursor: eventRows.length, events: after ? eventRows.filter(row => row.id > Number(after[1])) : [] };
        }
        return toastResults.shift() ?? { ok: true };
      } };
    },
  };
  vm.runInNewContext(source, { window, document: { visibilityState: focused ? 'visible' : 'hidden', hasFocus: () => focused }, console });
  const ctx = {
    effect(fn) { fn(); },
    locale: { register() {}, bind() { return key => key; } },
    slots: { inject() {}, register() {} },
    remote: { $on(event, listener) { handlers.set(event, listener); return () => {}; } },
    uiSession: { sessionStatus: {
      getSnapshot() { return snapshot; },
      subscribe(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    } },
    get(name) { return name === 'sessions' ? { binding(id) {
      if (id !== 's1') return undefined;
      return { eventSource: { getSnapshot: () => ({ entries: config.entries ?? [{ type: 'event', event: {
        type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '任务已经做好' }] } },
      } }] }) } };
    } } : undefined; },
  };
  module.apply(ctx);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { handlers, requests, pushEvents(rows) { eventRows = rows; }, restart(rows) { epoch = 'second'; eventRows = rows; }, toastResults, async fireTimer() { const fn = timers.shift(); if (fn) fn(); await new Promise(resolve => setTimeout(resolve, 0)); }, async poll() { if (poll) await poll(); await new Promise(resolve => setTimeout(resolve, 0)); }, update(entries) {
    snapshot = new Map(entries);
    for (const listener of statusListeners) listener();
  } };
}

test('a disabled host preference prevents pending interaction notifications', async () => {
  const { update, requests } = await startClient(false);
  update([['s1', { pendingInteraction: { kind: 'approval', key: 'a1', reason: 'approve?' } }]]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(requests.some(({ url }) => url.includes('/settings')));
  assert.equal(requests.filter(({ url }) => url.includes('/toast')).length, 0);
});

test('host restart fetches events in the new epoch rather than skipping early turns', async () => {
  const { requests, pushEvents, restart, poll } = await startClient(true);
  pushEvents([{ id: 1, sessionId: 's1', turn: 7, kind: 'completed' }]);
  await poll();
  restart([{ id: 1, sessionId: 's2', turn: 8, kind: 'completed' }]);
  await poll();
  const eventUrls = requests.filter(x => x.url.includes('/events')).map(x => x.url);
  assert.ok(eventUrls.at(-1).endsWith('?after=0'));
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 2);
});

test('events wait for the initial host preference instead of being discarded', async () => {
  let ready;
  const settingsGate = new Promise(resolve => { ready = resolve; });
  const { requests, pushEvents, poll } = await startClient(true, false, { settingsGate });
  pushEvents([{ id: 1, sessionId: 's1', turn: 7, kind: 'completed' }]);
  await poll();
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 0);
  ready();
  await new Promise(resolve => setTimeout(resolve, 0));
  await poll();
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 1);
});

test('busy pending notification retries and is marked seen only after successful delivery', async () => {
  const { requests, toastResults, update, fireTimer } = await startClient(true);
  toastResults.push({ ok: false, exit: 'rate-limited' }, { ok: true });
  const approval = { kind: 'approval', key: 'retry', reason: 'approve?' };
  update([['s1', { pendingInteraction: approval }]]);
  await new Promise(resolve => setTimeout(resolve, 0));
  update([['s1', { pendingInteraction: approval }]]);
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 1);
  await fireTimer();
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 2);
  update([['s1', { pendingInteraction: approval }]]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 2);
});

test('a busy pending notification retries at most twice', async () => {
  const { requests, toastResults, update, fireTimer } = await startClient(true);
  toastResults.push(...Array(3).fill({ ok: false, exit: 'rate-limited' }));
  const pending = [['s1', { pendingInteraction: { kind: 'approval', key: 'busy', reason: 'Allow?' } }]];
  update(pending);
  await new Promise(resolve => setTimeout(resolve, 0));
  await fireTimer();
  await fireTimer();
  update(pending);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 3);
});

test('completed turn notifications are sent serially', async () => {
  const { requests, toastResults, pushEvents, poll } = await startClient(true);
  let finish;
  toastResults.push(new Promise(resolve => { finish = resolve; }), { ok: true });
  pushEvents([{ id: 1, sessionId: 's1', turn: 7, kind: 'completed' }, { id: 2, sessionId: 's2', turn: 3, kind: 'completed' }]);
  const running = poll();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 1);
  finish({ ok: true });
  await running;
  assert.equal(requests.filter(x => x.url.includes('/toast')).length, 2);
});

test('settled turns notify with reply preview, while aborted and host-announced errors do not duplicate', async () => {
  const { requests, pushEvents, poll } = await startClient(true);
  pushEvents([
    { id: 1, sessionId: 's1', turn: 7, kind: 'completed' },
    { id: 2, sessionId: 's2', kind: 'aborted' },
    { id: 3, sessionId: 's3', kind: 'error', hostAnnounced: true },
    { id: 4, sessionId: 's4', kind: 'error' },
  ]);
  await poll();
  const toasts = requests.filter(({ url }) => url.includes('/toast')).map(({ options }) => JSON.parse(options.body));
  assert.deepEqual(toasts.map(x => x.body), ['任务已经做好', 'notify.failedBody']);
});

test('a completed turn still displays a silent notification when DSH has focus', async () => {
  const { requests, pushEvents, poll } = await startClient(true, true);
  pushEvents([{ id: 1, sessionId: 's1', turn: 7, kind: 'completed' }]);
  await poll();
  const toast = requests.filter(({ url }) => url.includes('/toast')).map(({ options }) => JSON.parse(options.body));
  assert.equal(toast.length, 1);
  assert.equal(toast[0].silent, true);
});

test('a tool-only final assistant message never previews an earlier step as the final reply', async () => {
  const entries = [
    { type: 'event', event: { type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '正在处理' }] } } } },
    { type: 'event', event: { type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'tool-call', name: 'check' }] } } } },
  ];
  const { requests, pushEvents, poll } = await startClient(true, false, { entries });
  pushEvents([{ id: 1, sessionId: 's1', turn: 7, kind: 'completed' }]);
  await poll();
  const toast = requests.filter(({ url }) => url.includes('/toast')).map(({ options }) => JSON.parse(options.body));
  assert.equal(toast[0].body, 'notify.doneBody');
});

test('missing adapter asks to check model configuration, not sign in', async () => {
  const { requests, pushEvents, poll } = await startClient(true);
  pushEvents([{ id: 1, sessionId: 's2', turn: 3, kind: 'error', code: 'NO_ADAPTER' }]);
  await poll();
  const toast = requests.filter(({ url }) => url.includes('/toast')).map(({ options }) => JSON.parse(options.body));
  assert.equal(toast[0].title, 'DeepSeek Harness · notify.configTitle');
});

test('new pending approvals and questions produce one notification each without waterfall ordering', async () => {
  const { update, requests, handlers } = await startClient(true);
  const approval = { kind: 'approval', key: 'a1', reason: 'approve?' };
  const question = { kind: 'question', key: 'q1', questions: [{ question: 'Which?' }] };
  update([['s1', { pendingInteraction: approval }]]);
  update([['s1', { pendingInteraction: approval }], ['s2', { pendingInteraction: question }]]);
  update([['s1', { pendingInteraction: approval }]]);
  update([['s1', { pendingInteraction: approval }], ['s2', { pendingInteraction: question }]]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const toasts = requests.filter(({ url }) => url.includes('/toast')).map(({ options }) => JSON.parse(options.body));
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0].body, 'approve?');
  assert.equal(toasts[1].body, 'Which?');
  assert.equal(handlers.has('approval/request'), false);
  assert.equal(handlers.has('user-questions/request'), false);
});
