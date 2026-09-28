import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createTimedCache } from '../src/timed-cache.js';

const source = (await readFile('src/map.js', 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '');

function fixture(load) {
  let time = 0;
  const appState = { user: { id: 'user' }, activeGroupId: 'a' };
  const api = vm.runInNewContext(`${source}
    ({ refresh: refreshGroupGeoTiffList, files: () => groupGeoTiffs,
       invalidate: () => groupGeoTiffCache.invalidate() });`, {
    appState, console,
    createTimedCache: (ttl) => createTimedCache(ttl, () => time),
    isApprovedMember: () => Boolean(appState.activeGroupId),
    listGroupGeoTiffs: load,
    window: { addEventListener() {} },
    localStorage: { getItem: () => null },
  });
  return { api, appState, advance: (ms) => { time += ms; } };
}

for (const files of [[], [{ path: 'a/map.tif' }]]) {
  test(`map list caches ${files.length ? 'populated' : 'empty'} results for one minute and shares concurrent requests`, async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return files; });
    await Promise.all([f.api.refresh(), f.api.refresh(), f.api.refresh()]);
    f.advance(59999);
    await f.api.refresh();
    assert.equal(calls, 1);
    assert.equal(f.api.files(), files);
    f.advance(1);
    await f.api.refresh();
    assert.equal(calls, 2);
  });
}

test('group and user changes, upload invalidation and forced deletion refresh bypass expiry', async () => {
  const calls = [];
  const f = fixture(async (group) => { calls.push(group); return []; });
  await f.api.refresh();
  f.appState.activeGroupId = 'b';
  await f.api.refresh();
  f.appState.user.id = 'another-user';
  await f.api.refresh();
  f.api.invalidate();
  await f.api.refresh();
  await f.api.refresh(true);
  assert.deepEqual(calls, ['a', 'b', 'b', 'b', 'b']);
});

test('late response from previous group cannot replace current maps', async () => {
  let finishOld;
  const current = [{ path: 'b/map.tif' }];
  const f = fixture((group) => group === 'a'
    ? new Promise((resolve) => { finishOld = resolve; }) : current);
  const old = f.api.refresh();
  await Promise.resolve();
  f.appState.activeGroupId = 'b';
  await f.api.refresh();
  finishOld([{ path: 'a/old.tif' }]);
  await old;
  assert.equal(f.api.files(), current);
});

test('leaving a group clears cached results before returning to it', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return []; });
  await f.api.refresh();
  f.appState.activeGroupId = null;
  await f.api.refresh();
  f.appState.activeGroupId = 'a';
  await f.api.refresh();
  assert.equal(calls, 2);
});

test('failed storage requests wait one minute before retrying', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('offline'); });
  await assert.rejects(f.api.refresh(), /offline/);
  await assert.rejects(f.api.refresh(), /offline/);
  assert.equal(calls, 1);
  f.advance(60000);
  await assert.rejects(f.api.refresh(), /offline/);
  assert.equal(calls, 2);
});
