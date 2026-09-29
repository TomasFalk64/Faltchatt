import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { tileKeys } from '../src/map-tiles.js';
import { tilePath } from '../src/map-storage.js';

const source = (await readFile('src/map-tile-layer.js', 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const manifest = { minZoom: 15, maxZoom: 16, bounds: [[59, 15], [60, 16]], levels: [
  { z: 15, minX: 1, maxX: 1, minY: 1, maxY: 1 },
  { z: 16, minX: 2, maxX: 3, minY: 2, maxY: 3 },
] };

function fixture(sign) {
  let time = 0;
  const L = {
    latLngBounds: (bounds) => bounds,
    GridLayer: { extend(methods) {
      return class {
        constructor(options) { this.options = options; this.events = {}; Object.assign(this, methods); }
        on(name, callback) { this.events[name] = callback; }
      };
    } },
  };
  const create = vm.runInNewContext(`${source}\ncreateMapTileLayer`, {
    L, tileKeys, tilePath, Date: { now: () => time }, queueMicrotask,
    document: { createElement: () => ({ setAttribute() {}, removeAttribute(name) { delete this[name]; } }) },
  });
  const layer = create({ createSignedUrls: sign }, 'group/map.tiles.json', manifest, 1);
  return { layer, advance(ms) { time += ms; } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('tile requests share signing, use private paths and refresh expired URLs', async () => {
  let calls = 0;
  const { layer, advance } = fixture(async (paths, expires) => {
    calls++;
    assert.equal(expires, 3600);
    assert.ok(paths.every((path) => path.startsWith('group/map/')));
    return { data: paths.map((path) => ({ path, signedUrl: `https://storage.example/${path}?token=${calls}` })) };
  });
  const tileA = layer.createTile({ z: 16, x: 2, y: 2 }, () => {});
  const tileB = layer.createTile({ z: 16, x: 3, y: 2 }, () => {});
  await flush();
  assert.equal(calls, 1);
  assert.match(tileA.src, /16-2-2\.png\?token=1$/);
  assert.match(tileB.src, /16-3-2\.png\?token=1$/);
  advance(51 * 60 * 1000);
  const tileC = layer.createTile({ z: 16, x: 2, y: 3 }, () => {});
  await flush();
  assert.equal(calls, 2);
  assert.match(tileC.src, /token=2$/);
  assert.equal(layer.options.maxNativeZoom, 16);
  assert.equal(layer.options.minNativeZoom, 15);
  assert.equal(layer.options.updateWhenZooming, false);
});

test('unloaded tiles cannot start downloads after signing completes', async () => {
  let finish;
  const { layer } = fixture((paths) => new Promise((resolve) => { finish = () => resolve({ data: paths.map((path) => ({ path, signedUrl: 'https://storage.example/tile' })) }); }));
  const tile = layer.createTile({ z: 16, x: 2, y: 2 }, () => assert.fail('unloaded tile callback'));
  layer.events.tileunload({ tile });
  finish();
  await flush();
  assert.equal(tile.src, undefined);
});

test('signing errors reach Leaflet and an out-of-bounds tile makes no request', async () => {
  let calls = 0, error;
  const { layer } = fixture(async () => { calls++; return { error: new Error('forbidden') }; });
  layer.createTile({ z: 16, x: 2, y: 2 }, (value) => { error = value; });
  await flush();
  assert.match(error.message, /forbidden/);
  let done = false;
  layer.createTile({ z: 16, x: 100, y: 100 }, (value) => { assert.equal(value, null); done = true; });
  await flush();
  assert.equal(done, true);
  assert.equal(calls, 1);
});
