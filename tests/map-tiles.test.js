import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from '../src/vendor/proj4FullyLoaded.js';
import { MAX_MAP_BYTES, WORLD_METERS, validateMapFile, validateMapDimensions, rasterTransform, planMapTiles, validateTileManifest, tileKeys, sampleBilinear } from '../src/map-tiles.js';

test('upload size and dimensions are bounded before decoding', () => {
  validateMapFile(MAX_MAP_BYTES);
  validateMapDimensions(2000, 2000);
  for (const size of [0, MAX_MAP_BYTES + 1, NaN]) assert.throws(() => validateMapFile(size));
  for (const [w, h] of [[2001, 10], [10, 2001], [0, 100], [2.5, 100]]) assert.throws(() => validateMapDimensions(w, h));
});

test('affine transform handles offset tiepoints, rotation and pixel centers', () => {
  const tied = rasterTransform({ ModelPixelScale: [2, 3, 0], ModelTiepoint: [10, 20, 0, 500, 700, 0] });
  assert.deepEqual(tied.forward(10, 20), [500, 700]);
  assert.deepEqual(tied.inverse(500, 700), [10, 20]);
  const point = rasterTransform({ ModelPixelScale: [2, 2, 0], ModelTiepoint: [0, 0, 0, 100, 200, 0] }, { GTRasterTypeGeoKey: 2 });
  assert.deepEqual(point.forward(0.5, 0.5), [100, 200]);
  const rotated = rasterTransform({ ModelTransformation: [2, -1, 0, 100, 1, 2, 0, 200, 0, 0, 1, 0, 0, 0, 0, 1] });
  assert.deepEqual(rotated.inverse(...rotated.forward(7, 11)), [7, 11]);
  assert.throws(() => rasterTransform({}), /georeferering/);
});

test('one kilometre at 60 degrees chooses consecutive levels 14–17; bounds enclose all corners', () => {
  const projection = proj4('EPSG:3006', 'EPSG:3857');
  const [east, north] = proj4('EPSG:4326', 'EPSG:3006', [15, 60]);
  const transform = rasterTransform({ ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, east, north, 0] });
  const plan = planMapTiles(1000, 1000, transform, projection);
  assert.equal(plan.maxZoom, 17);
  assert.equal(plan.minZoom, 14);
  assert.ok(plan.count >= 70 && plan.count <= 110);
  assert.equal(tileKeys(plan).length, plan.count);
  assert.equal(validateTileManifest(plan), plan);
  for (const [x, y] of [[0, 0], [1000, 0], [0, 1000], [1000, 1000]]) {
    const [lon, lat] = proj4('EPSG:3006', 'EPSG:4326', transform.forward(x, y));
    assert.ok(lat >= plan.bounds[0][0] - 1e-8 && lat <= plan.bounds[1][0] + 1e-8);
    assert.ok(lon >= plan.bounds[0][1] - 1e-8 && lon <= plan.bounds[1][1] + 1e-8);
  }
});

test('planning rejects excessive tile counts and out-of-world coordinates before allocation', () => {
  const identity = { forward: (p) => p };
  const transform = rasterTransform({ ModelPixelScale: [1, 1000, 0], ModelTiepoint: [0, 0, 0, 0, 0, 0] });
  assert.throws(() => planMapTiles(2000, 2000, transform, identity), /bildrutor/);
  const invalid = { forward: () => [WORLD_METERS, WORLD_METERS] };
  assert.throws(() => planMapTiles(100, 100, invalid, identity), /utbredning/);
});

test('bilinear sampling retains exact centers, interpolates and avoids dark alpha fringes', () => {
  const source = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
  const output = new Uint8ClampedArray(12);
  sampleBilinear(source, 2, 1, 0.5, 0.5, output, 0);
  sampleBilinear(source, 2, 1, 1, 0.5, output, 4);
  sampleBilinear(source, 2, 1, -1, 0.5, output, 8);
  assert.deepEqual([...output], [255, 0, 0, 255, 255, 0, 0, 128, 0, 0, 0, 0]);
});

test('manifest validation rejects unbounded loops, missing levels and invalid bounds', () => {
  const transform = rasterTransform({ ModelPixelScale: [2, 2, 0], ModelTiepoint: [0, 0, 0, 0, 1000, 0] });
  const plan = planMapTiles(100, 100, transform, { forward: (p) => p });
  for (const mutate of [
    (p) => { p.levels[0].maxX = Infinity; },
    (p) => { p.levels.pop(); },
    (p) => { p.bounds[0][0] = -90; },
    (p) => { p.maxZoom = 40; },
  ]) {
    const bad = structuredClone(plan); mutate(bad);
    assert.throws(() => validateTileManifest(bad));
  }
});
