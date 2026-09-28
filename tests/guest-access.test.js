import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL SQL/RLS/trigger execution, with a minimal Supabase Auth schema.
// Hosted Auth, CAPTCHA, cron scheduling and multi-connection concurrency still
// need the deployment smoke checks documented in SUPABASE_SETUP.md.
let db;
const owner = randomUUID();
const guest = randomUUID();
const otherAccount = randomUUID();
let group;

async function asUser(id, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
    await tx.exec('set local role authenticated');
    return tx.query(sql, params);
  });
}

async function addUser(id, anonymous) {
  await db.query('insert into auth.users(id, is_anonymous) values ($1, $2)', [id, anonymous]);
  await asUser(id, 'select public.ensure_own_profile()');
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create publication supabase_realtime;
    create table auth.users (
      id uuid primary key, is_anonymous boolean not null default false,
      email text, created_at timestamptz not null default now()
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb; $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated;
  `);
  const files = (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    if (/^(003|004|028)_/.test(file)) continue; // Hosted Realtime, Storage and cron.
    const sql = (await readFile(`supabase/migrations/${file}`, 'utf8'))
      .replace(/^\uFEFF/, '')
      .replace('create extension if not exists pgcrypto;', ''); // gen_random_uuid is built in.
    try { await db.exec(sql); } catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
  }
  // Model Supabase's public-schema defaults; account_activity explicitly
  // revokes writes in migration 027 and must keep those restricted.
  await db.exec(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
    revoke insert, update, delete on public.account_activity from authenticated;
  `);
  await addUser(owner, false);
  await addUser(guest, true);
  await addUser(otherAccount, false);
  group = (await asUser(owner, "select public.create_group_with_owner('Testgrupp') as id")).rows[0].id;
});

after(async () => { await db?.close(); });

test('guest flag is authoritative, and a guest cannot create a group', async () => {
  await asUser(guest, 'update public.profiles set is_guest = false where id = $1', [guest]);
  assert.equal((await db.query('select is_guest from public.profiles where id = $1', [guest])).rows[0].is_guest, true);
  await assert.rejects(asUser(guest, "select public.create_group_with_owner('Forbidden')"), /konto/);
});

test('wrong group codes consume the limit; a valid code also waits after five attempts', async () => {
  for (let i = 0; i < 5; i++) {
    const result = await asUser(guest, "select public.request_group_membership('wrong') as result");
    assert.match(result.rows[0].result.error, /felaktig/);
  }
  const { join_code: code } = (await db.query('select join_code from public.groups where id = $1', [group])).rows[0];
  const blocked = await asUser(guest, 'select public.request_group_membership($1) as result', [code]);
  assert.match(blocked.rows[0].result.error, /många gruppkodsförsök/);
  await db.query("update private.request_limits set started_at = now() - interval '2 minutes' where user_id = $1", [guest]);
  const joined = await asUser(guest, 'select public.request_group_membership($1) as result', [code]);
  assert.equal(joined.rows[0].result.group_id, group);
});

test('pending guests cannot read chat or post; approved guests can', async () => {
  await asUser(owner, "insert into public.messages(group_id, user_id, text) values ($1, $2, 'Owner message')", [group, owner]);
  assert.equal((await asUser(guest, 'select * from public.messages')).rows.length, 0);
  await assert.rejects(asUser(guest, "insert into public.messages(group_id, user_id, text) values ($1, $2, 'Forbidden')", [group, guest]), /row-level security/);
  await asUser(owner, "update public.group_members set status = 'approved' where user_id = $1 and group_id = $2", [guest, group]);
  assert.equal((await asUser(guest, 'select * from public.messages')).rows.length, 1);
  await asUser(guest, "insert into public.messages(group_id, user_id, text) values ($1, $2, 'Guest message')", [group, guest]);
});

test('even an owner cannot promote a guest or transfer the group to one', async () => {
  await assert.rejects(asUser(owner, "update public.group_members set role = 'admin' where user_id = $1", [guest]), /Gäster/);
  await assert.rejects(asUser(owner, 'update public.groups set owner_id = $1 where id = $2', [guest, group]), /konto/);
  await assert.rejects(asUser(owner, 'select public.leave_group($1)', [group]), /konto/);
});

test('chat and map pin quotas also protect direct database writes', async () => {
  // One guest message was already sent in the previous test.
  for (let i = 0; i < 19; i++) {
    await asUser(guest, "insert into public.messages(group_id, user_id, text) values ($1, $2, 'Message')", [group, guest]);
  }
  await assert.rejects(asUser(guest, "insert into public.messages(group_id, user_id, text) values ($1, $2, 'Spam')", [group, guest]), /många uppdateringar/);
  assert.equal((await db.query('select count(*)::int as n from public.messages where user_id = $1', [guest])).rows[0].n, 20);
  await db.query('delete from private.request_limits where user_id = $1', [guest]);
  for (let i = 0; i < 10; i++) {
    await asUser(guest, "insert into public.messages(group_id, user_id, type, latitude, longitude) values ($1, $2, 'location', 59, 18)", [group, guest]);
  }
  await assert.rejects(asUser(guest, "insert into public.messages(group_id, user_id, type, latitude, longitude) values ($1, $2, 'location', 59, 18)", [group, guest]), /många platsnålar/);
});

test('location upserts count once; 31st update is blocked', async () => {
  for (let i = 0; i < 30; i++) {
    await asUser(guest, `insert into public.locations(group_id, user_id, latitude, longitude, accuracy)
      values ($1, $2, 59, 18, 5) on conflict(group_id,user_id) do update set updated_at = now()`, [group, guest]);
  }
  await assert.rejects(asUser(guest, `insert into public.locations(group_id, user_id, latitude, longitude, accuracy)
    values ($1, $2, 59, 18, 5) on conflict(group_id,user_id) do update set updated_at = now()`, [group, guest]), /många uppdateringar/);
});

test('logout clears live data without deleting the guest or membership', async () => {
  await asUser(guest, 'insert into public.group_presence(group_id, user_id) values ($1, $2)', [group, guest]);
  await asUser(guest, 'select public.clear_own_live_data()');
  for (const table of ['locations', 'group_presence']) {
    assert.equal((await db.query(`select count(*)::int as n from public.${table} where user_id = $1`, [guest])).rows[0].n, 0);
  }
  assert.equal((await db.query('select count(*)::int as n from auth.users where id = $1', [guest])).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int as n from public.group_members where user_id = $1', [guest])).rows[0].n, 1);
});

test('a hundred guest slots are a hard cap, while permanent accounts still work', async () => {
  for (let i = 1; i < 100; i++) await db.query('insert into auth.users(id, is_anonymous) values ($1, true)', [randomUUID()]);
  assert.equal((await db.query('select public.guest_capacity_available() as available')).rows[0].available, false);
  await assert.rejects(db.query('insert into auth.users(id, is_anonymous) values ($1, true)', [randomUUID()]), /guest capacity/);
  await addUser(randomUUID(), false);
  assert.equal((await db.query('select count(*)::int as n from auth.users where is_anonymous')).rows[0].n, 100);
  // Existing guests can still save a profile and send activity at capacity.
  await asUser(guest, "update public.profiles set alias = 'Aktiv gäst' where id = $1", [guest]);
  await asUser(guest, 'select public.touch_account_activity()');
});

test('activity uses server time and private controls cannot be invoked by users', async () => {
  await assert.rejects(asUser(guest, "update public.account_activity set last_seen = now() + interval '100 years' where user_id = $1", [guest]), /permission denied/);
  await assert.rejects(asUser(guest, 'select private.cleanup_guests()'), /permission denied/);
  await assert.rejects(asUser(guest, 'select * from private.guest_slots'), /permission denied/);
  await db.query("update private.guest_slots set last_seen = now() - interval '25 hours' where user_id = $1", [guest]);
  await asUser(guest, 'select public.touch_account_activity()');
  assert.equal((await db.query('select private.cleanup_guests() as n')).rows[0].n, 0);
});

test('cleanup keeps guest contributions and regular accounts; frees a slot', async () => {
  await db.query('delete from private.request_limits where user_id = $1', [guest]);
  const questionMessage = (await asUser(guest, "select public.create_question_message($1, 'Vart?', array['Norr', 'Söder']) as id", [group])).rows[0].id;
  const question = (await db.query('select id from public.questions where message_id = $1', [questionMessage])).rows[0].id;
  const option = (await db.query('select id from public.question_options where question_id = $1 limit 1', [question])).rows[0].id;
  await asUser(guest, 'insert into public.question_answers(question_id, group_id, option_id, user_id) values ($1, $2, $3, $4)', [question, group, option, guest]);
  await db.query("update private.guest_slots set last_seen = now() - interval '25 hours' where user_id = $1", [guest]);
  const before = (await db.query('select count(*)::int as n from public.messages')).rows[0].n;
  assert.equal((await db.query('select private.cleanup_guests() as n')).rows[0].n, 1);
  assert.equal((await db.query('select * from auth.users where id = $1', [guest])).rows.length, 0);
  assert.equal((await db.query('select * from public.profiles where id = $1', [guest])).rows.length, 0);
  assert.equal((await db.query('select * from public.group_members where user_id = $1', [guest])).rows.length, 0);
  assert.equal((await db.query('select * from auth.users where id = $1', [owner])).rows.length, 1);
  assert.equal((await db.query('select count(*)::int as n from public.messages')).rows[0].n, before);
  assert.equal((await db.query('select created_by from public.questions where id = $1', [question])).rows[0].created_by, null);
  assert.equal((await db.query('select user_id from public.question_answers where question_id = $1', [question])).rows[0].user_id, null);
  assert.equal((await db.query('select public.guest_capacity_available() as available')).rows[0].available, true);
  await addUser(randomUUID(), true);
});

test('ownership transfer skips guests and chooses a permanent member', async () => {
  const nextGuest = (await db.query('select id from auth.users where is_anonymous limit 1')).rows[0].id;
  await asUser(nextGuest, 'select public.ensure_own_profile()');
  await db.query("insert into public.group_members(group_id, user_id, role, status) values ($1, $2, 'member', 'approved'), ($1, $3, 'member', 'approved')", [group, nextGuest, otherAccount]);
  await asUser(owner, 'select public.leave_group($1)', [group]);
  assert.equal((await db.query('select owner_id from public.groups where id = $1', [group])).rows[0].owner_id, otherAccount);
});

test('immediate guest deletion is service-only, preserves contributions and frees the slot', async () => {
  const id = (await db.query('select id from auth.users where is_anonymous limit 1')).rows[0].id;
  await asUser(id, 'select public.ensure_own_profile()');
  await db.query("insert into public.group_members(group_id, user_id, status) values ($1,$2,'approved') on conflict do nothing", [group, id]);
  const message = (await asUser(id, "insert into public.messages(group_id,user_id,type,text,latitude,longitude) values ($1,$2,'location','Keep this pin',59,18) returning id", [group, id])).rows[0].id;
  await asUser(id, 'insert into public.locations(group_id,user_id,latitude,longitude,accuracy) values ($1,$2,59,18,5)', [group, id]);
  await asUser(id, 'insert into public.group_presence(group_id,user_id) values ($1,$2)', [group, id]);
  await asUser(id, 'select public.touch_account_activity()');
  await assert.rejects(asUser(id, 'select public.delete_guest_account($1)', [id]), /permission denied/);
  await assert.rejects(asUser(otherAccount, 'select public.delete_guest_account($1)', [id]), /permission denied/);
  await assert.rejects(db.transaction(async tx => {
    await tx.exec('set local role anon');
    await tx.query('select public.delete_guest_account($1)', [id]);
  }), /permission denied/);
  await assert.rejects(db.query('select public.delete_guest_account($1)', [otherAccount]), /Guest account not found/);
  await db.transaction(async tx => {
    await tx.exec('set local role service_role');
    await tx.query('select public.delete_guest_account($1)', [id]);
  });
  assert.equal((await db.query('select id from auth.users where id=$1', [id])).rows.length, 0);
  for (const table of ['profiles', 'group_members', 'locations', 'group_presence', 'account_activity']) {
    const key = table === 'profiles' ? 'id' : 'user_id';
    assert.equal((await db.query(`select * from public.${table} where ${key}=$1`, [id])).rows.length, 0);
  }
  const retained = (await db.query('select user_id,text,latitude from public.messages where id=$1', [message])).rows[0];
  assert.equal(retained.user_id, null);
  assert.equal(retained.text, 'Keep this pin');
  assert.equal(retained.latitude, 59);
  assert.equal((await db.query('select public.guest_capacity_available() as available')).rows[0].available, true);
  assert.equal((await db.query('select id from auth.users where id=$1', [otherAccount])).rows.length, 1);
});
