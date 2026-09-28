import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the actual Edge Function handler with Auth/database transport mocked.
// Strip its few TypeScript annotations so Node can run it without Deno.
const source = (await readFile('supabase/functions/delete-my-account/index.ts', 'utf8'))
  .replace(/^import .*;\r?\n/m, '')
  .replace(/type DeleteAccountPayload = \{[\s\S]*?\};/, '')
  .replace(' as DeleteAccountPayload', '')
  .replace('name: string', 'name')
  .replace('body: unknown', 'body');

function fixture(user, options = {}) {
  let handler;
  const calls = [];
  const client = {
    auth: {
      getUser: async token => { calls.push(['verify', token]); return { data: { user }, error: options.authError }; },
      admin: { deleteUser: async id => { calls.push(['delete', id]); return {}; } },
    },
    rpc: async (name, params) => {
      calls.push([name, params.target_user_id]);
      return { data: {}, error: options.rpcError };
    },
  };
  vm.runInNewContext(source, {
    createClient: () => client, Response, console: { error() {} },
    Deno: { env: { get: () => 'test-only' }, serve: callback => { handler = callback; } },
  });
  return {
    calls,
    request: (body, token = 'valid-token') => handler(new Request('https://example.test/delete', {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {},
      body: JSON.stringify(body),
    })),
  };
}

test('guest deletion uses verified identity, requires confirmation and needs no email', async () => {
  const f = fixture({ id: 'own-guest', is_anonymous: true });
  assert.equal((await f.request({})).status, 400);
  assert.equal((await f.request({ confirmGuest: 'true' })).status, 400);
  assert.equal(f.calls.filter(call => call[0] !== 'verify').length, 0);
  const result = await f.request({ confirmGuest: true, target_user_id: 'someone-else', userId: 'someone-else' });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).deleted, true);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'verify'), [['delete_guest_account', 'own-guest']]);
});

test('missing or invalid sessions cannot delete an account', async () => {
  const f = fixture(null, { authError: new Error('invalid') });
  assert.equal((await f.request({ confirmGuest: true }, '')).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request({ confirmGuest: true })).status, 401);
  assert.deepEqual(f.calls, [['verify', 'valid-token']]);
});

test('ordinary accounts still require matching email, even with a guest flag in the body', async () => {
  const f = fixture({ id: 'own-account', is_anonymous: false, email: 'user@example.test' });
  assert.equal((await f.request({ confirmGuest: true, is_anonymous: true })).status, 400);
  assert.equal((await f.request({ confirmEmail: 'wrong@example.test' })).status, 400);
  assert.equal(f.calls.filter(call => call[0] !== 'verify').length, 0);
  assert.equal((await f.request({ confirmEmail: ' USER@EXAMPLE.TEST ', target_user_id: 'someone-else' })).status, 200);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'verify'), [
    ['prepare_delete_user_account', 'own-account'], ['delete', 'own-account'],
  ]);
});

test('failed guest cleanup does not report success or fall back to destructive admin deletion', async () => {
  const f = fixture({ id: 'own-guest', is_anonymous: true }, { rpcError: new Error('database failure') });
  const result = await f.request({ confirmGuest: true });
  assert.equal(result.status, 400);
  assert.equal((await result.json()).deleted, undefined);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'verify'), [['delete_guest_account', 'own-guest']]);
});
