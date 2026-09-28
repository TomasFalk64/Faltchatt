import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile('src/captcha.js', 'utf8'))
  .replace('import.meta.env.VITE_TURNSTILE_SITE_KEY', 'testSitekey')
  .replace('export function createCaptcha', 'function createCaptcha');

function fixture(sitekey = 'test-site-key') {
  let options;
  let executions = 0;
  let resets = 0;
  let removals = 0;
  const timers = new Map();
  const window = {
    setTimeout: (callback) => { const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    turnstile: {
      render: (_container, suppliedOptions) => { options = suppliedOptions; return 'widget'; },
      execute: () => { executions++; },
      reset: () => { resets++; },
      remove: () => { removals++; },
    },
  };
  const create = vm.runInNewContext(`${source}\ncreateCaptcha`, { window, testSitekey: sitekey });
  return { captcha: create({}), window, timers, get options() { return options; },
    get executions() { return executions; }, get resets() { return resets; }, get removals() { return removals; } };
}

test('guest entry fails closed without CAPTCHA configuration; existing account flow remains available', async () => {
  const f = fixture('');
  assert.equal(await f.captcha.token(), undefined);
  await assert.rejects(f.captcha.token(true), /Gästläget är inte tillgängligt/);
  assert.equal(f.executions, 0);
});

test('every authentication request executes a fresh CAPTCHA and consumes its callback token', async () => {
  const f = fixture();
  const first = f.captcha.token(true);
  await Promise.resolve();
  assert.equal(f.options.execution, 'execute');
  assert.equal(f.options.appearance, 'interaction-only');
  f.options.callback('token-1');
  assert.equal(await first, 'token-1');
  assert.equal(f.timers.size, 0);
  const second = f.captcha.token();
  await Promise.resolve();
  f.options.callback('token-2');
  assert.equal(await second, 'token-2');
  assert.equal(f.executions, 2);
  assert.equal(f.resets, 1);
});

test('CAPTCHA errors reject the login and permit a fresh attempt', async () => {
  const f = fixture();
  const pending = f.captcha.token(true);
  await Promise.resolve();
  f.options['error-callback']();
  await assert.rejects(pending, /Robotkontrollen misslyckades/);
  assert.equal(f.timers.size, 0);
  const retry = f.captcha.token(true);
  await Promise.resolve();
  f.options.callback('retry-token');
  assert.equal(await retry, 'retry-token');
});

test('closing the form cancels a pending CAPTCHA and removes its widget', async () => {
  const f = fixture();
  const pending = f.captcha.token(true);
  await Promise.resolve();
  f.captcha.dispose();
  await assert.rejects(pending, /Robotkontrollen/);
  await assert.rejects(f.captcha.token(true), /stängts/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.removals, 1);
});

test('CAPTCHA timeout and execution failure cannot continue authentication', async () => {
  const f = fixture();
  const pending = f.captcha.token(true);
  await Promise.resolve();
  [...f.timers.values()][0]();
  await assert.rejects(pending, /Robotkontrollen/);
  f.window.turnstile.execute = () => { throw new Error('Execution failed'); };
  await assert.rejects(f.captcha.token(true), /Robotkontrollen/);
  assert.equal(f.timers.size, 0);
});
