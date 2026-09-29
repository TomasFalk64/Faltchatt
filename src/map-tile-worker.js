import { fromArrayBuffer } from 'geotiff';
import proj4 from './vendor/proj4FullyLoaded.js';
import { TILE_SIZE, WORLD_METERS, validateMapFile, validateMapDimensions, rasterTransform, planMapTiles, sampleBilinear } from './map-tiles.js';

if (typeof self !== 'undefined') self.onmessage = async ({ data }) => {
  try {
    const result = await buildTiles(data.buffer, (progress) => self.postMessage({ type: 'progress', ...progress }));
    self.postMessage({ type: 'complete', ...result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Kartan kunde inte bearbetas.' });
  }
};

export async function buildTiles(buffer, progress = () => {}) {
  validateMapFile(buffer.byteLength);
  if (typeof OffscreenCanvas === 'undefined') throw new Error('Webbläsaren saknar stöd för kartimport. Uppdatera webbläsaren eller ladda upp från en dator.');
  progress({ value: 0, text: 'Kontrollerar kartan…' });
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth(), height = image.getHeight();
  validateMapDimensions(width, height);
  const directory = image.getFileDirectory();
  const geoKeys = image.getGeoKeys() || {};
  if ((directory.Orientation || 1) !== 1) throw new Error('Kartans TIFF-orientering stöds inte. Exportera den med normal orientering.');
  const epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey;
  if (!epsg || epsg === 32767) throw new Error('Kartan behöver ett angivet EPSG-koordinatsystem.');
  let project;
  try { project = proj4(`EPSG:${epsg}`, 'EPSG:3857'); }
  catch { throw new Error(`Kartans koordinatsystem EPSG:${epsg} stöds inte.`); }
  const transform = rasterTransform(directory, geoKeys);
  const manifest = planMapTiles(width, height, transform, project);
  const bits = Array.from(directory.BitsPerSample || [1]);
  if (image.getSamplesPerPixel() > 4 || bits.some((bit) => bit > 16)
      || Array.from(directory.SampleFormat || [1]).some((format) => format !== 1)) {
    throw new Error('Kartimporten stöder färg-, palett- och gråskalebilder med högst fyra kanaler och 16 bitar per kanal.');
  }
  progress({ value: 5, text: 'Läser kartbilden…' });
  const rgba = await readRgba(image, directory, width, height);
  let level = manifest.levels.at(-1);
  let canvas = new OffscreenCanvas((level.maxX - level.minX + 1) * TILE_SIZE, (level.maxY - level.minY + 1) * TILE_SIZE);
  let context = canvas.getContext('2d');
  const metersPerPixel = WORLD_METERS / (TILE_SIZE * 2 ** level.z);
  const left = level.minX * TILE_SIZE * metersPerPixel - WORLD_METERS / 2;
  const top = WORLD_METERS / 2 - level.minY * TILE_SIZE * metersPerPixel;
  // Work in strips to avoid a second full-sized RGBA allocation.
  for (let row = 0; row < canvas.height; row += 32) {
    const rows = Math.min(32, canvas.height - row);
    const strip = context.createImageData(canvas.width, rows);
    for (let y = 0; y < rows; y++) {
      const worldY = top - (row + y + 0.5) * metersPerPixel;
      for (let x = 0; x < canvas.width; x++) {
        const worldX = left + (x + 0.5) * metersPerPixel;
        if (worldX < manifest.extent[0] || worldX > manifest.extent[2] || worldY < manifest.extent[1] || worldY > manifest.extent[3]) continue;
        const source = project.inverse([worldX, worldY]);
        const pixel = transform.inverse(source[0], source[1]);
        if (pixel.every(Number.isFinite)) sampleBilinear(rgba, width, height, pixel[0], pixel[1], strip.data, (y * canvas.width + x) * 4);
      }
    }
    context.putImageData(strip, 0, row);
    progress({ value: 10 + Math.round(65 * (row + rows) / canvas.height), text: 'Anpassar kartan för visning…' });
  }
  const tiles = [];
  const tileCanvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const tileContext = tileCanvas.getContext('2d');
  for (let index = manifest.levels.length - 1; index >= 0; index--) {
    const next = manifest.levels[index];
    if (next.z !== level.z) {
      const smaller = new OffscreenCanvas((next.maxX - next.minX + 1) * TILE_SIZE, (next.maxY - next.minY + 1) * TILE_SIZE);
      const smallerContext = smaller.getContext('2d');
      smallerContext.imageSmoothingEnabled = true;
      smallerContext.imageSmoothingQuality = 'high';
      smallerContext.drawImage(canvas, (level.minX / 2 - next.minX) * TILE_SIZE, (level.minY / 2 - next.minY) * TILE_SIZE, canvas.width / 2, canvas.height / 2);
      canvas.width = 1; canvas.height = 1;
      canvas = smaller; context = smallerContext; level = next;
    }
    for (let y = level.minY; y <= level.maxY; y++) for (let x = level.minX; x <= level.maxX; x++) {
      tileContext.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      tileContext.drawImage(canvas, (x - level.minX) * TILE_SIZE, (y - level.minY) * TILE_SIZE, TILE_SIZE, TILE_SIZE, 0, 0, TILE_SIZE, TILE_SIZE);
      const blob = await tileCanvas.convertToBlob({ type: 'image/png' });
      tiles.push({ key: `${level.z}/${x}/${y}`, blob });
      progress({ value: 75 + Math.round(25 * tiles.length / manifest.count), text: `Skapar bildrutor: ${tiles.length} av ${manifest.count}…` });
    }
  }
  canvas.width = 1; canvas.height = 1;
  return { manifest, tiles };
}

async function readRgba(image, directory, width, height) {
  const colors = await image.readRGB({ interleave: true });
  const rgba = new Uint8ClampedArray(width * height * 4);
  const isRgb = directory.PhotometricInterpretation === 2;
  const baseSamples = [2, 6, 8].includes(directory.PhotometricInterpretation) ? 3 : directory.PhotometricInterpretation === 5 ? 4 : 1;
  const extras = Array.from(directory.ExtraSamples || []);
  const alphaExtra = extras.findIndex((value) => value === 1 || value === 2);
  const alphaSample = alphaExtra < 0 ? -1 : baseSamples + alphaExtra;
  const noData = image.getGDALNoData();
  const raw = noData !== null || alphaSample >= 0 ? await image.readRasters() : null;
  const bits = directory.BitsPerSample || [8];
  for (let pixel = 0; pixel < width * height; pixel++) {
    const missing = noData !== null && raw.every((band, index) => index >= baseSamples || band[pixel] === noData || (Number.isNaN(noData) && Number.isNaN(band[pixel])));
    const alpha = missing ? 0 : alphaSample >= 0 ? raw[alphaSample][pixel] * 255 / (2 ** bits[alphaSample] - 1) : 255;
    for (let channel = 0; channel < 3; channel++) {
      let value = colors[pixel * 3 + channel];
      if (isRgb) value *= 255 / (2 ** bits[channel] - 1);
      if (alphaExtra >= 0 && extras[alphaExtra] === 1 && alpha) value *= 255 / alpha;
      rgba[pixel * 4 + channel] = value;
    }
    rgba[pixel * 4 + 3] = alpha;
  }
  return rgba;
}
