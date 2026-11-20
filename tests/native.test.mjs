import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

const home = await mkdtemp(join(tmpdir(), 'notify-native-'));
process.env.DSH_HOME = home;
const settingsDir = join(home, 'dsh-xin505-notify');
const settingsFile = join(settingsDir, 'settings.json');
test.after(() => rm(home, { recursive: true, force: true }));

test('settings default to status only and preserve a legacy disabled preference', async () => {
  const { readSettings, updateSettings } = await import('../native.js');
  assert.deepEqual(readSettings(), { enabled: true, preview: false });
  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsFile, '{"enabled":false}');
  assert.deepEqual(readSettings(), { enabled: false, preview: false });
  assert.deepEqual(updateSettings({ preview: true }), { enabled: false, preview: true });
  assert.deepEqual(updateSettings({ enabled: true }), { enabled: true, preview: true });
  const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.deepEqual({ enabled: saved.enabled, preview: saved.preview }, readSettings());
  assert.throws(() => updateSettings({ preview: 'true' }));
  assert.equal(readSettings().preview, true);
});

test('delivery rechecks privacy and puts bounded Unicode text only on stdin', async t => {
  const { updateSettings, showToast } = await import('../native.js');
  const calls = [];
  t.mock.method(childProcess, 'spawn', (program, args, options) => {
    const child = new EventEmitter();
    const chunks = [];
    child.stdin = new Writable({
      write(chunk, encoding, done) { chunks.push(chunk); done(); },
      final(done) { done(); setImmediate(() => child.emit('close', 0)); },
    });
    calls.push({ program, args, options, chunks });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const title = 'DeepSeek Harness · 完成';
  const body = '内容 🐳 "第一行"\n<&> __BODY__ __SILENT__';
  const notification = { title, body, fallbackBody: '任务已完成', silent: true, source: 'client' };
  updateSettings({ enabled: true, preview: true });
  updateSettings({ preview: false });
  assert.deepEqual(await showToast(notification), { ok: true, exit: 0 });
  updateSettings({ preview: true });
  assert.deepEqual(await showToast(notification), { ok: true, exit: 0 });
  await showToast({ ...notification, body: '🐳'.repeat(2000) });
  updateSettings({ enabled: false });
  assert.deepEqual(await showToast(notification), { ok: false, exit: 'disabled' });
  assert.equal(calls.length, 3);
  for (const { args, options, chunks } of calls) {
    assert.equal(args.includes('-Body') || args.includes('-Title'), false);
    assert.ok(args.every(a => !a.includes('内容') && !a.includes('完成')));
    assert.equal(options.stdio[0], 'pipe');
    assert.ok(Buffer.concat(chunks).byteLength <= 4096);
  }
  const payloads = calls.map(call => JSON.parse(Buffer.concat(call.chunks).toString('utf8')));
  assert.deepEqual(payloads[0], { title, body: '任务已完成', silent: true });
  assert.deepEqual(payloads[1], { title, body: body.replace('\n', ' '), fallbackBody: '任务已完成', silent: true });
  assert.equal([...payloads[2].body].length, 400);
  const log = await readFile(join(settingsDir, 'toast.log'), 'utf8');
  assert.doesNotMatch(log, /🐳|内容|第一行|任务已完成/);
});

test('the native script reads structured input and keeps user text out of parameter binding', async () => {
  const script = await readFile(new URL('../toast.ps1', import.meta.url), 'utf8');
  assert.match(script, /OpenStandardInput/);
  assert.match(script, /ConvertFrom-Json/);
  assert.doesNotMatch(script, /\[Parameter\(Mandatory\s*=\s*\$true\)\]\[string\]\$(Title|Body)/i);
});

test('the final Windows policy check downgrades or cancels already-started toasts after a revoke and re-enable', {
  skip: process.platform !== 'win32',
}, async t => {
  const { updateSettings, showToast } = await import('../native.js');
  const script = fileURLToPath(new URL('../toast.ps1', import.meta.url));
  let env;
  t.mock.method(childProcess, 'spawn', (program, args, options) => {
    env = options.env;
    const child = new EventEmitter();
    child.stdin = new Writable({ write(chunk, encoding, done) { done(); } });
    setImmediate(() => child.emit('close', 0));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const mode = () => {
    // Run precisely the policy function used immediately before Show, without a desktop popup.
    const command = [
      '$tree = [Management.Automation.Language.Parser]::ParseFile($env:DSH_TEST_SCRIPT, [ref]$null, [ref]$null)',
      "$fn = $tree.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ToastContentMode' }, $true)",
      '. ([scriptblock]::Create($fn.Extent.Text))', 'Get-ToastContentMode',
    ].join('; ');
    const probe = childProcess.spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { env: { ...env, DSH_TEST_SCRIPT: script }, windowsHide: true, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    return probe.stdout.trim();
  };
  updateSettings({ enabled: true, preview: true });
  await showToast({ title: 'Status', body: 'sensitive', fallbackBody: 'Generic' });
  assert.equal(mode(), 'detail');
  updateSettings({ preview: false });
  updateSettings({ preview: true });
  assert.equal(mode(), 'summary');
  updateSettings({ enabled: false });
  updateSettings({ enabled: true });
  assert.equal(mode(), 'disabled');
  await writeFile(settingsFile, '{broken');
  assert.equal(mode(), 'disabled');
  await writeFile(settingsFile, '{"enabled":true,"preview":false}');
});
