/**
 * Browser half of the desktop-notify bundle.
 *
 * It consumes bounded Host turn-end metadata and asks the Host for a toast.
 *
 * - Turn-end outcomes distinguish successful work, failures and user stops.
 * - `uiSession.sessionStatus` exposes pending approvals and questions after
 *   the built-in UI has accepted them, without relying on waterfall ordering.
 *
 * Account and quota failures are announced by the Host half instead, because
 * the failure codes never reach the page.
 *
 * One preference row in Settings > General switches the feature off and sends
 * a test notification on demand.
 */
window.__ModuleLoader__.load({
  id: 'dsh-xin505-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace owned by this plugin. */
    const NS = 'desktopNotify';
    /** The Host route that raises the actual Windows toast. */
    const TOAST_ENDPOINT = '/api/dsh-xin505-notify/toast';
    const SETTINGS_ENDPOINT = '/api/dsh-xin505-notify/settings';
    const EVENTS_ENDPOINT = '/api/dsh-xin505-notify/events';
    /** Longest detail a toast shows before it gets truncated. */
    const BODY_LIMIT = 180;

    const DICTS = {
      zh: {
        'row.title': '桌面通知',
        'row.description': '回复完成、需要你确认或需要你回答时弹出系统弹窗；也包含额度和登录失效的提醒。',
        'row.test': '发送测试弹窗',
        'row.sent': '已发出测试弹窗。没看到的话，检查 Windows 通知设置里 DeepSeek Harness 是否被关掉了。',
        'row.failed': '弹窗没发出去，请查看 DSH 日志里的 toast.log。',
        'row.notReady': '宿主通知通道还没就绪，重启一次 DeepSeek Harness 再试。',
        'row.systemOff': 'Windows 把这个应用的通知关掉了：设置 › 系统 › 通知 里打开 DeepSeek Harness。',
        'row.disabled': '桌面通知已关闭，先打开右侧开关。',
        'switch.label': '桌面通知',
        'notify.doneTitle': '回复完成',
        'notify.doneBody': '请回到 DeepSeek Harness 查看结果。',
        'notify.failedTitle': '执行出错',
        'notify.failedBody': '这一轮没有正常完成。',
        'notify.quotaTitle': '额度或余额不足',
        'notify.authTitle': '需要登录或检查凭证',
        'notify.configTitle': '请检查模型配置',
        'notify.rateTitle': '请求受到限流',
        'notify.approvalTitle': '需要你的确认',
        'notify.approvalBody': '有一个操作在等你授权。',
        'notify.questionTitle': '需要你回答',
        'notify.questionBody': '代理有一个问题在等你回答。',
        'notify.testTitle': '回复完成',
        'notify.testBody': '通知已开启，这是回复完成时的提醒。',
        'notify.readyTitle': '桌面通知已就绪',
        'notify.readyBody': '以后回复完成、需要你授权、额度用完时会像这样弹出来。',
      },
      en: {
        'row.title': 'Desktop notifications',
        'row.description': 'Pops up a Windows notification when a reply finishes, an approval is pending, a question waits for you, or the account needs attention.',
        'row.test': 'Send a test popup',
        'row.sent': 'Test popup sent. If you did not see it, check that DeepSeek Harness is allowed in Windows notification settings.',
        'row.failed': 'The popup could not be sent. Check toast.log in the DSH log directory.',
        'row.notReady': 'The host notification channel is not ready yet — restart DeepSeek Harness and try again.',
        'row.systemOff': 'Windows notifications are off for this app. Turn on DeepSeek Harness under Settings > System > Notifications.',
        'row.disabled': 'Desktop notifications are off. Turn on the switch first.',
        'switch.label': 'Desktop notifications',
        'notify.doneTitle': 'Reply finished',
        'notify.doneBody': 'Return to DeepSeek Harness to see the result.',
        'notify.failedTitle': 'Turn failed',
        'notify.failedBody': 'This turn did not finish.',
        'notify.quotaTitle': 'Quota or balance exhausted',
        'notify.authTitle': 'Sign in or check credentials',
        'notify.configTitle': 'Check model configuration',
        'notify.rateTitle': 'Request rate limited',
        'notify.approvalTitle': 'Approval needed',
        'notify.approvalBody': 'An operation is waiting for your decision.',
        'notify.questionTitle': 'Answer needed',
        'notify.questionBody': 'The agent is waiting for your answer.',
        'notify.testTitle': 'Reply finished',
        'notify.testBody': 'Notifications are on. This is what a finished reply looks like.',
        'notify.readyTitle': 'Desktop notifications are ready',
        'notify.readyBody': 'Finished replies, pending approvals and exhausted quota will pop up like this.',
      },
    };

    // ---- the one stored preference -------------------------------------

    // The Host owns the preference for all windows and Host-generated events.
    // Stay quiet until it has supplied the persisted setting.
    let enabled = false;
    let settingsReady = false;
    let settingsLoading = false;
    const listeners = new Set();

    function setEnabled(next) {
      enabled = next !== false;
      for (const listener of [...listeners]) {
        try {
          listener(enabled);
        } catch {
          // A broken row must not break the notifier.
        }
      }
    }

    async function settingsRequest(value) {
      if (value === undefined && settingsLoading) return false;
      if (value === undefined) settingsLoading = true;
      const transport = window.__DSH_TRANSPORT__?.fetch;
      const send = transport ?? ((...args) => window.fetch(...args));
      const endpoint = value === undefined ? SETTINGS_ENDPOINT : SETTINGS_ENDPOINT + '/update';
      const url = transport ? endpoint.slice(1) : endpoint;
      const options = value === undefined ? { credentials: 'same-origin' } : {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: value }),
      };
      try {
        const response = await send(url, options);
        if (!response.ok) return false;
        const result = await response.json();
        if (result?.ok !== true || typeof result.enabled !== 'boolean') return false;
        settingsReady = true;
        setEnabled(result.enabled);
        return true;
      } catch {
        return false;
      } finally {
        if (value === undefined) settingsLoading = false;
      }
    }

    function subscribeEnabled(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    // ---- asking the Host for a toast -----------------------------------

    /** True while the page is visible and focused, i.e. the user is already looking. */
    function attentionOnPage() {
      try {
        if (document.visibilityState !== 'visible') return false;
        return typeof document.hasFocus !== 'function' || document.hasFocus();
      } catch {
        return false;
      }
    }

    /**
     * Ask the Host to raise one Windows toast.
     * @returns `ok`, or the reason / PowerShell exit code when it did not work,
     *          so the settings row can say what went wrong.
     */
    async function sendToast(title, body, silent) {
      if (!enabled) return { ok: false, reason: 'disabled' };
      // The desktop shell may carry the authenticated fetch itself; the plain
      // page fetch falls back to the loopback origin's session cookie.
      const transport = window.__DSH_TRANSPORT__?.fetch;
      const send = transport ?? ((...args) => window.fetch(...args));
      try {
        const response = await send(transport ? TOAST_ENDPOINT.slice(1) : TOAST_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, body, silent: silent === true }),
          credentials: 'same-origin',
        });
        if (!response.ok) {
          // No route yet (Host half not loaded), or the peer lost access.
          const missing = response.status === 401 || response.status === 403 || response.status === 404;
          return { ok: false, reason: missing ? 'not-ready' : 'http-' + String(response.status) };
        }
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (payload?.ok === true) return { ok: true };
        return { ok: false, exit: payload?.exit, reason: 'invalid-response' };
      } catch {
        return { ok: false, reason: 'network' };
      }
    }

    function clipped(value) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') return '';
      return [...text].slice(0, BODY_LIMIT).join('');
    }

    // ---- the settings row ----------------------------------------------

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
      const translate = typeof props.t === 'function' ? props.t : (key) => key;
      const [on, setOn] = React.useState(enabled);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => subscribeEnabled(setOn), []);

      /** Explain a failed toast attempt in the row itself. */
      const explain = (result) => {
        if (result.ok) {
          setNotice(translate('row.sent'));
          return;
        }
        if (result.reason === 'disabled') setNotice(translate('row.disabled'));
        else if (result.reason === 'not-ready' || result.reason === 'network') setNotice(translate('row.notReady'));
        else if (result.exit === 2) setNotice(translate('row.systemOff'));
        else setNotice(translate('row.failed'));
      };

      const sendTest = async () => {
        if (!enabled) {
          setNotice(translate('row.disabled'));
          return;
        }
        setBusy(true);
        try {
          explain(await sendToast('DeepSeek Harness · ' + translate('notify.testTitle'), translate('notify.testBody'), false));
        } finally {
          setBusy(false);
        }
      };

      const onToggle = async () => {
        const next = !on;
        setBusy(true);
        setNotice(null);
        if (!await settingsRequest(next)) {
          setNotice(translate('row.notReady'));
          setBusy(false);
          return;
        }
        setBusy(false);
        if (!next) return;
        setBusy(true);
        void sendToast('DeepSeek Harness · ' + translate('notify.testTitle'), translate('notify.testBody'), false)
          .then(explain)
          .finally(() => setBusy(false));
      };

      return h('div', { className: 'dsn-row' },
        h('style', null, ROW_CSS),
        h('div', { className: 'dsn-text' },
          h('div', { className: 'dsn-title' }, translate('row.title')),
          h('div', { className: 'dsn-desc' }, translate('row.description')),
          notice === null ? null : h('div', { className: 'dsn-notice', role: 'status' }, notice),
        ),
        h('div', { className: 'dsn-actions' },
          h('button', {
            type: 'button',
            className: 'dsn-test',
            disabled: busy,
            onClick: () => { void sendTest(); },
          }, translate('row.test')),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': on,
            'aria-label': translate('switch.label'),
            className: 'dsn-switch',
            disabled: busy,
            onClick: onToggle,
          }, h('span', { className: 'dsn-thumb' })),
        ),
      );
    }

    // ---- the notifier --------------------------------------------------

    const inject = ['slots', 'locale', 'remote', 'uiSession'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-xin505-notify: dictionaries');
      ctx.effect(() => {
        const refresh = () => { void settingsRequest(); };
        refresh();
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
      }, 'dsh-xin505-notify: settings');

      /** The interface language decides both the row and the toast copy. */
      const t = ctx.locale.bind(NS);
      const chineseUi = () => {
        try {
          return t('row.title') === DICTS.zh['row.title'];
        } catch {
          return false;
        }
      };

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'desktop-notify',
        order: 23,
        locale: NS,
      }, NotifyRow));

      // One-time self-test: the first page load that reaches the Host toast
      // route says so with a real popup, and only then is the flag stored, so a
      // page loaded before the Host half exists simply tries again later.
      const VERIFIED_KEY = 'dsh-xin505-notify:verified';
      let verified = false;
      try {
        verified = window.localStorage.getItem(VERIFIED_KEY) === '1';
      } catch {
        // An unreadable flag only repeats the self-test.
      }
      if (!verified) {
        const attempt = (delays) => {
          if (delays.length === 0) return;
          window.setTimeout(() => {
            void sendToast('DeepSeek Harness · ' + t('notify.readyTitle'), t('notify.readyBody'), false).then((result) => {
              if (result.ok) {
                try {
                  window.localStorage.setItem(VERIFIED_KEY, '1');
                } catch {
                  // Retrying the self-test on the next load is harmless.
                }
                return;
              }
              attempt(delays.slice(1));
            });
          }, delays[0]);
        };
        // A page loaded before the Host half exists retries instead of giving up.
        attempt([1500, 5000, 15000]);
      }

      /** Durable display title of one Session, when the Client catalog already knows it. */
      const titleOf = (sessionId) => {
        try {
          const sessions = ctx.get('sessions');
          const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
          if (row === undefined) return undefined;
          if (typeof row.title === 'string' && row.title !== '') return row.title;
          if (typeof row.displayTitle === 'string' && row.displayTitle !== sessionId) return row.displayTitle;
        } catch {
          // A missing catalog only costs the title in the toast.
        }
        return undefined;
      };

      // Only use an already-retained, permission-scoped client history. Never
      // open another session or ask the Host bridge for message contents.
      const previewOf = (sessionId, turn) => {
        try {
          const entries = ctx.get('sessions')?.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.entries;
          if (!Array.isArray(entries)) return '';
          for (let i = entries.length - 1; i >= 0; i--) {
            const event = entries[i]?.event;
            if (event?.type !== 'assistant/message' || event.data?.turn !== turn || event.data.interrupted) continue;
            const content = event.data.message?.content;
            if (!Array.isArray(content)) return '';
            const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ');
            return clipped(text);
          }
        } catch { /* No permission-scoped loaded history; use a generic body. */ }
        return '';
      };

      /** The human-readable approval reason for the interface language. */
      const reasonOf = (request) => {
        const display = request?.displayReason;
        if (display !== null && typeof display === 'object') {
          const preferred = chineseUi() ? 'zh' : 'en';
          if (typeof display[preferred] === 'string' && display[preferred] !== '') return display[preferred];
          if (typeof display.en === 'string' && display.en !== '') return display.en;
        }
        const reason = clipped(request?.reason);
        return reason === '' ? undefined : reason;
      };

      ctx.effect(() => {
        const disposers = [];
        let cursor;
        let epoch;
        let polling = false;
        let disposed = false;
        let queue = Promise.resolve();
        const delays = new Map();
        const delay = (ms) => new Promise(resolve => {
          const timer = window.setTimeout(() => { delays.delete(timer); resolve(); }, ms);
          delays.set(timer, resolve);
        });
        const queueToast = (title, body, silent, stillRelevant = () => true) => {
          const send = async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
              if (disposed || !enabled || !stillRelevant()) return { ok: false, reason: 'cancelled' };
              const result = await sendToast(title, body, silent);
              if (result.ok) return result;
              const retryable = ['rate-limited', 'busy'].includes(result.exit) || ['http-429', 'http-503'].includes(result.reason);
              if (!retryable || attempt === 2) return result;
              // The Host permits ten toasts per ten-second window.
              await delay(10_500);
            }
            return { ok: false };
          };
          const result = queue.then(send, send);
          queue = result.catch(() => {});
          return result;
        };
        const pollTurns = async () => {
          if (polling || disposed) return;
          // Keep the initial event cursor while the preference is unknown so
          // a slow settings response does not discard newly completed turns.
          if (cursor !== undefined && !settingsReady) {
            void settingsRequest();
            return;
          }
          polling = true;
          try {
            const transport = window.__DSH_TRANSPORT__?.fetch;
            const send = transport ?? ((...args) => window.fetch(...args));
            const base = transport ? EVENTS_ENDPOINT.slice(1) : EVENTS_ENDPOINT;
            const read = async after => {
              const endpoint = base + (after === undefined ? '' : '?after=' + encodeURIComponent(after));
              const response = await send(endpoint, { credentials: 'same-origin' });
              if (!response.ok) return null;
              const value = await response.json();
              return value?.ok === true && typeof value.epoch === 'string' && Number.isSafeInteger(value.cursor) && Array.isArray(value.events) ? value : null;
            };
            let result = await read(cursor);
            if (disposed || !result) return;
            if (epoch !== undefined && result.epoch !== epoch) {
              const newEpoch = result.epoch;
              result = await read(0);
              if (disposed || !result || result.epoch !== newEpoch) return;
            }
            // The first read establishes a baseline; previously settled turns
            // must not be repeated when the page starts or reconnects.
            const initial = cursor === undefined;
            cursor = result.cursor;
            epoch = result.epoch;
            if (initial) return;
            for (const event of result.events) {
              if (!enabled || event?.hostAnnounced || typeof event?.sessionId !== 'string') continue;
              if (event.kind === 'completed') {
                const body = previewOf(event.sessionId, event.turn) || clipped(titleOf(event.sessionId)) || t('notify.doneBody');
                await queueToast('DeepSeek Harness · ' + t('notify.doneTitle'), body, attentionOnPage());
              } else if (['error', 'blocked', 'max-tokens'].includes(event.kind)) {
                const code = String(event.code ?? '').toUpperCase();
                const key = ['QUOTA', 'ACCOUNT_QUOTA'].includes(code) ? 'notify.quotaTitle'
                  : ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID'].includes(code) ? 'notify.authTitle'
                    : code === 'NO_ADAPTER' ? 'notify.configTitle' : code === 'RATE_LIMIT' ? 'notify.rateTitle' : 'notify.failedTitle';
                await queueToast('DeepSeek Harness · ' + t(key), t('notify.failedBody'), attentionOnPage());
              }
            }
          } catch { /* Host temporarily unavailable; retry on the next tick. */ }
          finally { polling = false; }
        };
        void pollTurns();
        const pollTimer = window.setInterval(pollTurns, 1500);
        disposers.push(() => {
          disposed = true;
          window.clearInterval(pollTimer);
          for (const [timer, resolve] of delays) { window.clearTimeout(timer); resolve(); }
          delays.clear();
        });

        // The built-in answerers may stop the request waterfall before a later
        // listener sees it. Observe their published pending state instead.
        const seenPending = new Set();
        const pendingInFlight = new Set();
        const pendingExhausted = new Set();
        const remember = (set, id) => {
          set.add(id);
          if (set.size > 1024) set.delete(set.values().next().value);
        };
        const scanPending = () => {
          if (!enabled) return;
          try {
            for (const [sessionId, status] of ctx.uiSession.sessionStatus.getSnapshot()) {
              const request = status?.pendingInteraction;
              if (!request || typeof request.key !== 'string') continue;
              if (!['approval', 'question', 'plan-review'].includes(request.kind)) continue;
              const id = JSON.stringify([sessionId, request.key]);
              if (seenPending.has(id) || pendingInFlight.has(id) || pendingExhausted.has(id)) continue;
              pendingInFlight.add(id);
              const relevant = () => {
                const current = ctx.uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction;
                return current?.key === request.key && current.kind === request.kind;
              };
              let title;
              let body;
              if (request.kind === 'approval') {
                title = t('notify.approvalTitle');
                body = reasonOf(request) ?? t('notify.approvalBody');
              } else {
                const first = Array.isArray(request.questions) ? request.questions[0] : undefined;
                const asked = clipped(first?.question);
                title = t('notify.questionTitle');
                body = asked === '' ? t('notify.questionBody')
                  : (typeof first?.header === 'string' && first.header.trim() !== '' ? first.header.trim() + '：' + asked : asked);
              }
              void queueToast('DeepSeek Harness · ' + title, body, attentionOnPage(), relevant).then(result => {
                pendingInFlight.delete(id);
                if (result.ok) remember(seenPending, id);
                else if (result.reason !== 'cancelled') remember(pendingExhausted, id);
                else if (!disposed && enabled && relevant()) scanPending();
              });
            }
          } catch (error) {
            console.warn('[dsh-xin505-notify] cannot read pending interactions:', error);
          }
        };
        disposers.push(ctx.uiSession.sessionStatus.subscribe(scanPending));
        let previouslyEnabled = enabled;
        disposers.push(subscribeEnabled(value => {
          if (value && !previouslyEnabled) pendingExhausted.clear();
          previouslyEnabled = value;
          scanPending();
        }));
        scanPending();

        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // Disposal must not keep other registrations alive.
            }
          }
        };
      }, 'dsh-xin505-notify: forwarded events');
    }

    return { inject, apply };
  },
});
