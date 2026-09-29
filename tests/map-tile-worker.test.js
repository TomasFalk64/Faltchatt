import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeArrayBuffer } from 'geotiff';
import { buildTiles } from '../src/map-tile-worker.js';
import { WORLD_METERS, validateTileManifest } from '../src/map-tiles.js';

// Exercise real TIFF decoding, reprojection, canvas downsampling and PNG encoding.
// The browser's OffscreenCanvas is adapted to the native canvas only in tests.
globalThis.OffscreenCanvas = function (width, height) {
  const canvas = createCanvas(width, height);
  canvas.convertToBlob = async () => new Blob([await canvas.encode('png')], { type: 'image/png' });
  return canvas;
};

const pixelSize = WORLD_METERS / (256 * 2 ** 17);
const globalX = 65536 * 256 + 200;
const globalY = 40000 * 256 + 20;

function fixture(width, height, bands, values, extra = {}) {
  return writeArrayBuffer(values, {
    width, height, SamplesPerPixel: bands, BitsPerSample: Array(bands).fill(8),
    PhotometricInterpretation: bands >= 3 ? 2 : 1,
    ProjectedCSTypeGeoKey: 3857, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1,
    ModelPixelScale: [pixelSize, pixelSize, 0],
    ModelTiepoint: [0, 0, 0, globalX * pixelSize - WORLD_METERS / 2, WORLD_METERS / 2 - globalY * pixelSize, 0],
    ...extra,
  });
}

async function pixelAt(result, x, y, z = 17) {
  const factor = 2 ** (17 - z);
  const px = Math.floor((globalX + x) / factor), py = Math.floor((globalY + y) / factor);
  const tile = result.tiles.find((item) => item.key === `${z}/${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
  assert.ok(tile, 'expected tile exists');
  const image = await loadImage(Buffer.from(await tile.blob.arrayBuffer()));
  assert.equal(image.width, 256); assert.equal(image.height, 256);
  const canvas = createCanvas(256, 256), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return [...context.getImageData(px % 256, py % 256, 1, 1).data];
}

test('RGB detail survives TIFF-to-PNG conversion across tile seams and lower levels', async () => {
  const width = 320, height = 64;
  const values = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    values.set([x % 256, y * 3, x % 2 ? 255 : 0], (y * width + x) * 3);
  }
  const progress = [];
  const result = await buildTiles(fixture(width, height, 3, values), (p) => progress.push(p.value));
  validateTileManifest(result.manifest);
  assert.equal(result.manifest.maxZoom, 17);
  assert.equal(result.tiles.length, result.manifest.count);
  for (const x of [0, 55, 56, 57, 255, 319]) {
    assert.deepEqual(await pixelAt(result, x, 20), [x % 256, 60, x % 2 ? 255 : 0, 255]);
  }
  assert.equal((await pixelAt(result, 100, 20, 16))[3], 255);
  assert.equal((await pixelAt(result, -1, 20))[3], 0);
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, i) => !i || value >= progress[i - 1]));
});

test('alpha and nodata remain transparent without darkening opaque colors', async () => {
  const values = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) values.set(i % 32 < 16 ? [220, 30, 40, 255] : [0, 0, 0, 0], i * 4);
  const result = await buildTiles(fixture(32, 32, 4, values, { ExtraSamples: [2] }));
  assert.deepEqual(await pixelAt(result, 5, 5), [220, 30, 40, 255]);
  assert.equal((await pixelAt(result, 25, 5))[3], 0);
  const gray = new Uint8Array(32 * 32).fill(120);
  gray[5 * 32 + 5] = 0;
  const nodata = await buildTiles(fixture(32, 32, 1, gray, { GDAL_NODATA: '0\0' }));
  assert.equal((await pixelAt(nodata, 5, 5))[3], 0);
  assert.deepEqual(await pixelAt(nodata, 15, 15), [120, 120, 120, 255]);
});

test('oversized and unknown-projection TIFFs fail before raster decoding', async () => {
  const progress = [];
  await assert.rejects(buildTiles(fixture(2001, 1, 1, new Uint8Array(2001)), (p) => progress.push(p.text)), /2000/);
  assert.deepEqual(progress, ['Kontrollerar kartan…']);
  await assert.rejects(buildTiles(fixture(10, 10, 1, new Uint8Array(100), { ProjectedCSTypeGeoKey: 32767 })), /EPSG/);
});
