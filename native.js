import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-xin505-notify');
const settingsPath = resolve(directory, 'settings.json');
const logPath = join(directory, 'toast.log');
const scriptPath = fileURLToPath(new URL('./toast.ps1', import.meta.url));
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const maxConcurrent = 2;
const maxPerWindow = 10;
const rateWindowMs = 10_000;
let active = 0;
let starts = [];

function readPolicy() {
  let raw;
  try { raw = readFileSync(settingsPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { enabled: true, preview: false, enabledEpoch: '', previewEpoch: '', persisted: false };
    throw error;
  }
  const saved = JSON.parse(raw);
  if (typeof saved?.enabled !== 'boolean' || (saved.preview !== undefined && typeof saved.preview !== 'boolean') ||
      [saved.enabledEpoch, saved.previewEpoch].some(epoch => epoch !== undefined && typeof epoch !== 'string')) {
    throw new Error('Invalid notification settings');
  }
  return { enabled: saved.enabled, preview: saved.preview ?? false,
    enabledEpoch: saved.enabledEpoch ?? '', previewEpoch: saved.previewEpoch ?? '', persisted: true };
}

export function readSettings() {
  const { enabled, preview } = readPolicy();
  return { enabled, preview };
}

export function updateSettings(patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0 || !keys.every(key => ['enabled', 'preview'].includes(key) && typeof patch[key] === 'boolean')) {
    throw new TypeError('Invalid notification preferences');
  }
  const previous = readPolicy();
  const enabled = patch.enabled ?? previous.enabled;
  const preview = patch.preview ?? previous.preview;
  // Revocations survive a subsequent re-enable while a PowerShell process starts.
  const settings = { enabled, preview,
    enabledEpoch: previous.enabled && !enabled ? randomUUID() : previous.enabledEpoch,
    previewEpoch: previous.preview && !preview ? randomUUID() : previous.previewEpoch };
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, `settings-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(settings) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, settingsPath);
  } finally {
    try { unlinkSync(temp); } catch { /* A successful rename consumed the temporary file. */ }
  }
  return { enabled, preview };
}

export function appendLog(line) {
  try {
    mkdirSync(directory, { recursive: true });
    if (statSync(logPath, { throwIfNoEntry: false })?.size > 256 * 1024) writeFileSync(logPath, '');
    appendFileSync(logPath, new Date().toISOString() + ' ' + line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch { /* Diagnostics must never prevent notification delivery. */ }
}

function cleanText(value, maxCharacters) {
  if (typeof value !== 'string') return '';
  const flat = value.toWellFormed().replace(/[\u0000-\u001f\u007f\ufffe\uffff]/g, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(flat).slice(0, maxCharacters).join('');
}

/** Check the persisted privacy preference at the instant of delivery, including retries. */
export async function showToast(input) {
  let settings;
  try { settings = readPolicy(); }
  catch { return { ok: false, exit: 'settings-error' }; }
  if (!settings.enabled) return { ok: false, exit: 'disabled' };

  const now = Date.now();
  starts = starts.filter(start => now - start < rateWindowMs);
  if (active >= maxConcurrent || starts.length >= maxPerWindow) return { ok: false, exit: 'rate-limited' };

  const title = cleanText(input.title, 120) || 'DeepSeek Harness';
  const fallbackBody = cleanText(input.fallbackBody, 400);
  const body = settings.preview ? cleanText(input.body, 400) : fallbackBody;
  const silent = input.silent === true;
  // Even two 400-character bodies and a 120-character title fit in 4096 UTF-8 bytes.
  const payload = Buffer.from(JSON.stringify({ title, body, silent, ...(body !== fallbackBody ? { fallbackBody } : {}) }), 'utf8');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath];
  const source = /^(?:client|host:[a-z-]{1,32})$/.test(input.source) ? input.source : 'unknown';
  starts.push(now);
  active++;

  return new Promise(resolve => {
    let finished = false;
    let timer;
    const finish = exit => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active--;
      appendLog(`exit=${exit} source=${source} silent=${silent}`);
      resolve({ ok: exit === 0, exit });
    };
    let child;
    try {
      const env = { ...process.env, DSH_NOTIFY_SETTINGS_PATH: settingsPath,
        DSH_NOTIFY_SETTINGS_EXISTED: settings.persisted ? '1' : '0',
        DSH_NOTIFY_ENABLED_EPOCH: settings.enabledEpoch, DSH_NOTIFY_PREVIEW_EPOCH: settings.previewEpoch };
      child = spawn(powershell, args, { env, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch { finish('spawn-error'); return; }
    timer = setTimeout(() => {
      child.kill();
      finish('timeout');
    }, 10_000);
    let stdinFailed = false;
    child.once('error', () => finish('spawn-error'));
    child.once('close', code => finish(stdinFailed ? 'stdin-error' : code === 3 ? 'disabled' : code ?? 'interrupted'));
    child.stdin.once('error', () => { stdinFailed = true; });
    child.stdin.end(payload);
  });
}
