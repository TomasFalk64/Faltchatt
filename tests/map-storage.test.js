import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadTileMap, deleteTileMap, listStorageFiles } from '../src/map-storage.js';
import { removeGroupMapFiles } from '../supabase/functions/_shared/map-cleanup.js';

const prepared = { manifest: { version: 1 }, tiles: Array.from({ length: 8 }, (_, x) => ({ key: `17/${x}/1`, blob: new Blob(['png']) })) };

test('manifest is published only after bounded parallel uploads finish', async () => {
  const events = []; let active = 0, maximum = 0;
  const bucket = {
    async upload(path) {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      events.push(path); active--;
      return {};
    },
  };
  await uploadTileMap(bucket, 'group/map.tiles.json', prepared, () => {});
  assert.equal(events.at(-1), 'group/map.tiles.json');
  assert.equal(events.length, 9);
  assert.equal(maximum, 4);
});

test('failed upload waits for in-flight work, removes attempted files and never publishes', async () => {
  let active = 0;
  const attempted = [], removed = [];
  const bucket = {
    async upload(path) {
      active++; attempted.push(path);
      await new Promise((resolve) => setTimeout(resolve, path.includes('17-1-') ? 0 : 10));
      active--;
      return path.includes('17-1-') ? { error: new Error('offline') } : {};
    },
    async remove(paths) { assert.equal(active, 0); removed.push(...paths); return {}; },
  };
  await assert.rejects(uploadTileMap(bucket, 'group/map.tiles.json', prepared, () => {}), /offline/);
  assert.deepEqual(removed.sort(), attempted.sort());
  assert.ok(!attempted.includes('group/map.tiles.json'));
});

test('group change aborts uploads before publication', async () => {
  let uploads = 0;
  const bucket = { async upload() { uploads++; return {}; }, async remove() { return {}; } };
  await assert.rejects(uploadTileMap(bucket, 'a/map.tiles.json', prepared, () => {}, () => { throw new Error('group changed'); }), /group changed/);
  assert.equal(uploads, 0);
});

test('deleting a map lists its own folder and removes the manifest last', async () => {
  const deleted = [];
  const bucket = {
    async list(folder) { assert.equal(folder, 'group/map'); return { data: [{ id: 'a', name: '17-1-2.png' }] }; },
    async remove(paths) { deleted.push(paths); return {}; },
  };
  await deleteTileMap(bucket, 'group/map.tiles.json');
  assert.deepEqual(deleted, [['group/map/17-1-2.png'], ['group/map.tiles.json']]);
});

test('storage listing paginates without dropping maps past the first page', async () => {
  const files = Array.from({ length: 1003 }, (_, i) => ({ id: String(i), name: `${i}.tif` }));
  const bucket = { async list(folder, { offset, limit }) { return { data: files.slice(offset, offset + limit) }; } };
  assert.equal((await listStorageFiles(bucket, 'group')).length, 1003);
});

test('group cleanup removes nested tiles, legacy TIFFs and unfinished imports in batches', async () => {
  const deleted = [];
  const files = Array.from({ length: 1003 }, (_, i) => ({ id: String(i), name: `${i}.png` }));
  const tree = { group: [{ id: null, name: 'map' }, { id: null, name: 'unfinished' }, { id: 'old', name: 'old.tif' }, { id: 'manifest', name: 'map.tiles.json' }],
    'group/map': files, 'group/unfinished': [{ id: 'tile', name: '1.png' }] };
  const bucket = {
    async list(folder, { offset, limit }) { return { data: tree[folder].slice(offset, offset + limit) }; },
    async remove(paths) { assert.ok(paths.length <= 100); deleted.push(...paths); return {}; },
  };
  assert.equal(await removeGroupMapFiles({ storage: { from: () => bucket } }, 'group'), 1006);
  assert.equal(new Set(deleted).size, 1006);
  assert.ok(deleted.includes('group/unfinished/1.png'));
  assert.ok(deleted.includes('group/old.tif'));
});
