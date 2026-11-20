/** Client integration for DeepSeek Harness Windows notifications. */
window.__ModuleLoader__.load({
  id: 'dsh-xin505-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'desktopNotify';
    const BASE = '/api/dsh-xin505-notify/';
    const BODY_LIMIT = 180;
    const encoder = new TextEncoder();

    const DICTS = {
      zh: {
        'row.title': '桌面通知',
        'row.description': '回复完成、出错或需要你处理时显示 Windows 通知。',
        'row.preview': '显示内容预览',
        'row.previewDescription': '在通知中显示回复、会话标题或待办详情。内容可能出现在锁屏和共享屏幕上。',
        'row.test': '发送测试通知',
        'row.sent': '测试通知已发送。',
        'row.failed': '发送失败，请查看插件的 toast.log。',
        'row.notReady': '暂时无法连接通知服务，请稍后重试。',
        'row.systemOff': '请在 Windows 设置 › 系统 › 通知中允许 DeepSeek Harness 发送通知。',
        'row.disabled': '请先打开桌面通知。',
      },
      en: {
        'row.title': 'Desktop notifications',
        'row.description': 'Show Windows notifications when a reply finishes, a task fails, or your attention is needed.',
        'row.preview': 'Show content previews',
        'row.previewDescription': 'Include reply text, session titles and pending request details. They may appear on your lock screen or a shared screen.',
        'row.test': 'Send test notification',
        'row.sent': 'Test notification sent.',
        'row.failed': 'Delivery failed. See the plugin’s toast.log.',
        'row.notReady': 'The notification service is unavailable. Try again shortly.',
        'row.systemOff': 'Allow DeepSeek Harness in Windows Settings › System › Notifications.',
        'row.disabled': 'Turn on desktop notifications first.',
      },
    };

    async function api(path, data) {
      const transport = window.__DSH_TRANSPORT__?.fetch;
      const url = BASE + path;
      const send = transport ?? ((...args) => window.fetch(...args));
      const init = { credentials: 'same-origin' };
      if (data !== undefined) Object.assign(init, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
      });
      let timeout;
      const controller = new AbortController();
      const expired = new Promise(resolve => {
        timeout = window.setTimeout(() => { controller.abort(); resolve({ ok: false, exit: 'timeout' }); }, 15_000);
      });
      // Desktop carriers may serialize options across IPC. Only native browser fetch takes the AbortSignal.
      if (!transport) init.signal = controller.signal;
      try {
        const read = async () => {
          const response = await send(transport ? url.slice(1) : url, init);
          if (!response.ok) return { ok: false, exit: 'http-' + response.status };
          return await response.json();
        };
        return await Promise.race([read(), expired]);
      } catch {
        return { ok: false, exit: 'network' };
      } finally {
        window.clearTimeout(timeout);
      }
    }

    let settings = { enabled: false, preview: false };
    let ready = false;
    let revision = 0;
    let reading;
    let writing;
    const listeners = new Set();
    const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    const readState = () => settings;

    async function receiveSettings(patch, version) {
      const value = await api(patch ? 'settings/update' : 'settings', patch);
      if (version !== revision || value?.ok !== true || typeof value.enabled !== 'boolean') return false;
      const changed = !ready || settings.enabled !== value.enabled || settings.preview !== (value.preview === true);
      ready = true;
      if (changed) {
        settings = { enabled: value.enabled, preview: value.preview === true };
        for (const fn of listeners) fn();
      }
      return true;
    }

    function refreshSettings() {
      if (writing) return writing;
      if (reading) return reading;
      const promise = receiveSettings(undefined, revision).finally(() => { if (reading === promise) reading = undefined; });
      reading = promise;
      return promise;
    }

    function updateSettings(patch) {
      const version = ++revision;
      reading = undefined;
      const save = () => receiveSettings(patch, version);
      const promise = (writing ? writing.then(save, save) : save()).finally(() => { if (writing === promise) writing = undefined; });
      writing = promise;
      return promise;
    }

    function attentionOnPage() {
      return document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus());
    }

    function clipped(value) {
      if (typeof value !== 'string') return '';
      let result = '', count = 0;
      for (const char of value.trimStart()) {
        if (count++ >= BODY_LIMIT) break;
        result += char;
      }
      return result.trimEnd();
    }

    async function notify(payload, getDetail, relevant = () => true) {
      if (!settings.enabled || !relevant()) return { ok: false, exit: 'cancelled' };
      // Re-read the Host setting before touching private text. Another window may have disabled previews.
      if (getDetail && settings.preview && await refreshSettings() && settings.preview && settings.enabled && relevant()) {
        const body = clipped(getDetail());
        if (body) payload.body = body;
      }
      if (!settings.enabled || !relevant()) return { ok: false, exit: 'cancelled' };
      if (encoder.encode(JSON.stringify(payload)).length > 4096) delete payload.body;
      return await api('toast', payload);
    }

    function localeOf(t) {
      return t('row.title') === DICTS.zh['row.title'] ? 'zh' : 'en';
    }

    const ROW_CSS = `
.dsn-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
.dsn-text{min-width:0;}
.dsn-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);}
.dsn-desc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dsn-notice{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dsn-actions{display:flex;align-items:center;gap:12px;flex:none;}
.dsn-test{flex:none;height:28px;padding:0 12px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l2);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease;}
.dsn-test:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dsn-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;}
.dsn-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);}
.dsn-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px;}
.dsn-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease;}
.dsn-switch[aria-checked=false] .dsn-thumb{background:var(--dsw-alias-switch-thumb);}
.dsn-switch[aria-checked=true] .dsn-thumb{transform:translate(16px);}
`;

    function NotifyRow(props) {
      const t = typeof props.t === 'function' ? props.t : key => key;
      const prefs = React.useSyncExternalStore(subscribe, readState);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const explain = result => {
        if (result.ok) return 'row.sent';
        if (result.exit === 2) return 'row.systemOff';
        if (result.exit === 'disabled' || result.exit === 'cancelled') return 'row.disabled';
        return ['network', 'timeout', 'http-401', 'http-403', 'http-404'].includes(result.exit) ? 'row.notReady' : 'row.failed';
      };
      const test = async () => {
        setBusy(true);
        try { setNotice(t(explain(await notify({ type: 'test', locale: localeOf(t), silent: false })))); }
        finally { setBusy(false); }
      };
      const toggle = async name => {
        setBusy(true);
        setNotice(null);
        try {
          const next = !prefs[name];
          if (!await updateSettings({ [name]: next })) setNotice(t('row.notReady'));
          else if (name === 'enabled' && next) setNotice(t(explain(await notify({ type: 'test', locale: localeOf(t), silent: false }))));
        } finally { setBusy(false); }
      };
      const sw = (name, label) => h('button', {
        type: 'button', role: 'switch', 'aria-label': t(label), 'aria-checked': prefs[name],
        className: 'dsn-switch', disabled: busy || (name === 'preview' && !prefs.enabled),
        onClick: () => toggle(name),
      }, h('span', { className: 'dsn-thumb' }));
      const row = (name, title, description, testButton) => h('div', { className: 'dsn-row' },
        h('div', { className: 'dsn-text' },
          h('div', { className: 'dsn-title' }, t(title)),
          h('div', { className: 'dsn-desc' }, t(description)),
          testButton && notice ? h('div', { className: 'dsn-notice', role: 'status' }, notice) : null,
        ),
        h('div', { className: 'dsn-actions' },
          testButton ? h('button', { type: 'button', className: 'dsn-test', disabled: busy || !prefs.enabled, onClick: test }, t('row.test')) : null,
          sw(name, title),
        ),
      );
      return h('div', null, h('style', null, ROW_CSS),
        row('enabled', 'row.title', 'row.description', true),
        row('preview', 'row.preview', 'row.previewDescription', false),
      );
    }

    function previewOf(ctx, sessionId, turn) {
      try {
        // Only borrow a history the Client already retained.
        const sessions = ctx.get('sessions');
        const entries = sessions?.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.entries;
        if (Array.isArray(entries)) {
          for (let i = entries.length - 1; i >= 0; i--) {
            const event = entries[i]?.event;
            if (event?.type !== 'assistant/message' || event.data?.turn !== turn || event.data.interrupted) continue;
            const blocks = event.data.message?.content;
            let text = '';
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                if (block?.type !== 'text') continue;
                const piece = clipped(block.text);
                if (piece) text += (text ? ' ' : '') + piece;
                if (text.length >= BODY_LIMIT * 2) break;
              }
            }
            if (text) return clipped(text);
            break;
          }
        }
        const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
        return clipped(row?.title) || (row?.displayTitle !== sessionId ? clipped(row?.displayTitle) : '');
      } catch { return ''; }
    }

    function actionable(request) {
      if (!request || typeof request.key !== 'string' || !['approval', 'question', 'plan-review'].includes(request.kind)) return false;
      if (request.kind === 'approval') return request.answerable !== false;
      if (request.review !== undefined) return false;
      const card = request.getSnapshot?.();
      return !card?.closed && card?.state !== 'continued' && card?.waitState !== 'continued';
    }

    function pendingDetail(request, locale) {
      if (request.kind === 'approval') {
        return clipped(request.displayReason?.[locale]) || clipped(request.displayReason?.en) || clipped(request.reason);
      }
      const item = request.questions?.[0];
      const question = clipped(item?.question);
      const header = clipped(item?.header);
      return header && question ? clipped(header + '：' + question) : question;
    }

    // Most cards have a Host tool call ID. Unnamed legacy cards have only a renderer-local number.
    const pageId = window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
    function identity(sessionId, request) {
      if (typeof request.callId === 'string' && request.callId) return JSON.stringify([sessionId, request.kind, 'call', request.callId]);
      return JSON.stringify([sessionId, request.kind, pageId, request.key]);
    }

    function wireKey(id) {
      const bytes = encoder.encode(id);
      if (bytes.length <= 384) return id;
      // Routing only. Use the same bounded identity even on pages without SubtleCrypto.
      let fnv = 2166136261;
      let djb = 5381;
      for (const byte of bytes) {
        fnv = Math.imul(fnv ^ byte, 16777619);
        djb = Math.imul(djb, 33) ^ byte;
      }
      return 'id:' + bytes.length + ':' + (fnv >>> 0).toString(16) + ':' + (djb >>> 0).toString(16);
    }

    const inject = ['slots', 'locale', 'remote', 'uiSession'];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-xin505-notify: dictionaries');
      const t = ctx.locale.bind(NS);
      const locale = () => localeOf(t);
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: 'desktop-notify', order: 23, locale: NS,
      }, NotifyRow));

      ctx.effect(() => {
        let disposed = false, polling = false, cursor, epoch, pollCount = 0;
        let readyTimer;
        let disconnected = false;
        const pending = new Map();
        const sent = new Set();
        const retryMs = [1500, 5000, 10500, 30000, 60000];
        const status = ctx.uiSession.sessionStatus;
        const isCurrent = (sessionId, id) => {
          const request = status.getSnapshot().get(sessionId)?.pendingInteraction;
          return !disposed && settings.enabled && actionable(request) && JSON.stringify([sessionId, request.key]) === id;
        };
        const clear = item => { window.clearTimeout(item.timer); pending.delete(item.id); };
        const sendPending = async item => {
          const valid = () => pending.get(item.id) === item && isCurrent(item.sessionId, item.id);
          if (!valid()) return;
          item.timer = undefined;
          try {
            const request = status.getSnapshot().get(item.sessionId)?.pendingInteraction;
            const key = wireKey(identity(item.sessionId, request));
            const ref = [item.sessionId, request.callId ?? null];
            if (!valid()) return;
            const getRequest = () => status.getSnapshot().get(item.sessionId)?.pendingInteraction;
            const language = locale();
            const result = await notify({
              type: 'pending', kind: getRequest().kind, key, locale: language, silent: attentionOnPage(),
              ...(encoder.encode(JSON.stringify(ref)).length <= 1024 ? { ref } : {}),
            }, () => pendingDetail(getRequest(), language), valid);
            if (!valid()) return;
            if (result.ok || result.exit === 'stale') {
              sent.add(item.id);
              if (sent.size > 1024) sent.delete(sent.values().next().value);
              clear(item);
              return;
            }
            // Permanent rejection can be reconsidered after settings, focus or connectivity changes.
            if (result.exit === 2 || result.exit === 'disabled' || ['http-400','http-413'].includes(result.exit)) {
              item.paused = true;
              return;
            }
          } catch { /* Keep the still-pending action eligible after a carrier failure. */ }
          if (valid()) {
            if (item.attempt >= retryMs.length) { item.paused = true; return; }
            const ms = retryMs[item.attempt++];
            item.timer = window.setTimeout(() => { void sendPending(item); }, ms);
          }
        };
        function scanPending() {
          for (const item of pending.values()) if (!isCurrent(item.sessionId, item.id)) clear(item);
          if (disposed || !settings.enabled) return;
          for (const [sessionId, state] of status.getSnapshot()) {
            const request = state?.pendingInteraction;
            if (!actionable(request)) continue;
            const id = JSON.stringify([sessionId, request.key]);
            if (pending.has(id) || sent.has(id)) continue;
            const item = { id, sessionId, attempt: 0, timer: undefined, paused: false };
            pending.set(id, item);
            void sendPending(item);
          }
        }
        const resume = () => {
          if (disposed) return;
          for (const item of pending.values()) {
            if (item.timer !== undefined || item.paused) clear(item);
          }
          scanPending();
        };
        const reconnect = () => { void refreshSettings().then(ok => { if (ok) resume(); }); };

        async function pollTurns() {
          if (polling || disposed) return;
          if (++pollCount % 10 === 0) void refreshSettings();
          if (cursor !== undefined && !ready) { void refreshSettings(); return; }
          polling = true;
          try {
            const read = after => api(after === undefined ? 'events' : 'events?after=' + encodeURIComponent(after));
            let batch = await read(cursor);
            if (disposed) return;
            if (!batch?.ok) { disconnected = true; return; }
            if (epoch !== undefined && batch.epoch !== epoch) {
              const receivedEpoch = batch.epoch;
              batch = await read(0);
              if (!batch?.ok || batch.epoch !== receivedEpoch || disposed) return;
            }
            if (typeof batch.epoch !== 'string' || !Number.isSafeInteger(batch.cursor) || !Array.isArray(batch.events)) return;
            if (disconnected) {
              disconnected = false;
              reconnect();
            }
            const initial = cursor === undefined;
            cursor = batch.cursor;
            epoch = batch.epoch;
            if (initial || !settings.enabled) return;
            // The Host owns the terminal notification even if every optional hint is lost.
            for (const event of batch.events) {
              if (disposed || !settings.enabled) break;
              if (!Number.isSafeInteger(event?.id) || typeof event.sessionId !== 'string') continue;
              const detail = event.kind === 'completed' ? () => previewOf(ctx, event.sessionId, event.turn) : undefined;
              await notify({ type: 'turn', epoch, id: event.id, locale: locale(), silent: attentionOnPage() }, detail, () => !disposed);
            }
          } finally { polling = false; }
        }

        const VERIFIED_KEY = 'dsh-xin505-notify:verified';
        async function readyTest(attempt) {
          if (disposed) return;
          const result = await notify({ type: 'ready', locale: locale(), silent: false }, undefined, () => !disposed);
          if (disposed) return;
          if (result.ok) {
            try { window.localStorage.setItem(VERIFIED_KEY, '1'); } catch {}
          } else if (attempt < 2) {
            readyTimer = window.setTimeout(() => { void readyTest(attempt + 1); }, attempt === 0 ? 5000 : 15000);
          }
        }
        let verified;
        try { verified = window.localStorage.getItem(VERIFIED_KEY); } catch {}
        if (verified !== '1') readyTimer = window.setTimeout(() => { void readyTest(0); }, 1500);

        const offState = status.subscribe(scanPending);
        const offSettings = subscribe(scanPending);
        window.addEventListener('online', reconnect);
        window.addEventListener('focus', reconnect);
        void refreshSettings();
        scanPending();
        void pollTurns();
        const pollTimer = window.setInterval(pollTurns, 1500);
        return () => {
          disposed = true;
          offState(); offSettings();
          window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect);
          window.clearInterval(pollTimer); window.clearTimeout(readyTimer);
          for (const item of pending.values()) clear(item);
          revision++;
          reading = undefined;
          ready = false;
          settings = { enabled: false, preview: false };
        };
      }, 'dsh-xin505-notify: page events');
    }
    return { inject, apply };
  },
});
