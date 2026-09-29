// Shared, DOM-free geometry and validation for the import worker and viewer.
export const TILE_SIZE = 256;
export const MAX_MAP_BYTES = 5 * 1024 * 1024;
export const MAX_MAP_SIDE = 2000;
export const MAX_MAP_TILES = 512;
export const WORLD_METERS = 40075016.68557849;
const HALF_WORLD = WORLD_METERS / 2;

export function validateMapFile(size) {
  if (!Number.isFinite(size) || size <= 0 || size > MAX_MAP_BYTES) {
    throw new Error('Kartfilen måste vara högst 5 MiB och får inte vara tom.');
  }
}

export function validateMapDimensions(width, height) {
  if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= MAX_MAP_SIDE)) {
    throw new Error(`Kartan är ${width} × ${height} pixlar. Maximal bredd och höjd är ${MAX_MAP_SIDE} pixlar.`);
  }
}

// Handles rotated rasters, non-zero tiepoint raster coordinates, and PixelIsPoint.
export function rasterTransform(directory, geoKeys = {}) {
  let a, b, c, d, e, f;
  const matrix = directory.ModelTransformation;
  if (matrix?.length === 16) {
    [a, b, c, d, e, f] = [matrix[0], matrix[1], matrix[3], matrix[4], matrix[5], matrix[7]];
  } else {
    const scale = directory.ModelPixelScale;
    const tie = directory.ModelTiepoint;
    if (!scale || !tie || tie.length !== 6) throw new Error('Kartan saknar georeferering som stöds.');
    [a, b, d, e] = [scale[0], 0, 0, -scale[1]];
    c = tie[3] - tie[0] * a;
    f = tie[4] - tie[1] * e;
  }
  const determinant = a * e - b * d;
  if (![a, b, c, d, e, f].every(Number.isFinite) || !determinant) throw new Error('Kartans georeferering är ogiltig.');
  if (geoKeys.GTRasterTypeGeoKey === 2) {
    c -= (a + b) / 2;
    f -= (d + e) / 2;
  }
  return {
    forward: (x, y) => [a * x + b * y + c, d * x + e * y + f],
    inverse: (x, y) => [(e * (x - c) - b * (y - f)) / determinant, (-d * (x - c) + a * (y - f)) / determinant],
  };
}

export function tileRange(extent, zoom) {
  const span = WORLD_METERS / 2 ** zoom;
  const last = 2 ** zoom - 1;
  const clamp = (value) => Math.max(0, Math.min(last, value));
  return {
    minX: clamp(Math.floor((extent[0] + HALF_WORLD) / span)),
    maxX: clamp(Math.ceil((extent[2] + HALF_WORLD) / span) - 1),
    minY: clamp(Math.floor((HALF_WORLD - extent[3]) / span)),
    maxY: clamp(Math.ceil((HALF_WORLD - extent[1]) / span) - 1),
  };
}

export function planMapTiles(width, height, transform, project) {
  validateMapDimensions(width, height);
  const points = [];
  // Sample edges as well as corners: reprojection can curve the footprint.
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    for (const [x, y] of [[t * width, 0], [t * width, height], [0, t * height], [width, t * height]]) {
      points.push(project.forward(transform.forward(x, y)));
    }
  }
  if (points.some((p) => !p.every(Number.isFinite) || p.some((v) => Math.abs(v) > HALF_WORLD))) {
    throw new Error('Kartans utbredning ligger utanför det område som kartvisningen stöder.');
  }
  const extent = [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
  const center = project.forward(transform.forward(width / 2, height / 2));
  const stepX = Math.min(16, width / 2), stepY = Math.min(16, height / 2);
  const dx = project.forward(transform.forward(width / 2 + stepX, height / 2));
  const dy = project.forward(transform.forward(width / 2, height / 2 + stepY));
  const resolution = Math.min(Math.hypot(dx[0] - center[0], dx[1] - center[1]) / stepX, Math.hypot(dy[0] - center[0], dy[1] - center[1]) / stepY);
  // Coordinate roundtrips at metre resolution can lose precision at large northings.
  const maxZoom = Math.max(0, Math.ceil(Math.log2(WORLD_METERS / (TILE_SIZE * resolution)) - 1e-7));
  if (!Number.isFinite(maxZoom) || maxZoom > 22 || extent[2] <= extent[0] || extent[3] <= extent[1]) {
    throw new Error('Kartans utbredning eller upplösning är ogiltig eller för detaljerad.');
  }
  const minZoom = Math.max(0, maxZoom - 3);
  const levels = [];
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const range = tileRange(extent, z);
    count += (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    levels.push({ z, ...range });
  }
  if (count > MAX_MAP_TILES) throw new Error(`Kartan kräver ${count} bildrutor. Gränsen är ${MAX_MAP_TILES}. Beskär kartan och försök igen.`);
  const highest = levels.at(-1);
  const canvasWidth = (highest.maxX - highest.minX + 1) * TILE_SIZE;
  const canvasHeight = (highest.maxY - highest.minY + 1) * TILE_SIZE;
  if (canvasWidth > 8192 || canvasHeight > 8192 || canvasWidth * canvasHeight > 24 * 1024 * 1024) {
    throw new Error('Kartans form kräver för mycket arbetsminne. Beskär kartan och försök igen.');
  }
  const toLatLng = (x, y) => [Math.atan(Math.sinh(y / HALF_WORLD * Math.PI)) * 180 / Math.PI, x / HALF_WORLD * 180];
  return { version: 1, tileSize: TILE_SIZE, minZoom, maxZoom, levels, count, extent,
    bounds: [toLatLng(extent[0], extent[1]), toLatLng(extent[2], extent[3])], width, height };
}

export function tileKeys(manifest) {
  const keys = [];
  for (const level of manifest.levels) {
    for (let y = level.minY; y <= level.maxY; y++) {
      for (let x = level.minX; x <= level.maxX; x++) keys.push(`${level.z}/${x}/${y}`);
    }
  }
  return keys;
}

export function validateTileManifest(manifest) {
  if (manifest?.version !== 1 || manifest.tileSize !== TILE_SIZE || !Number.isInteger(manifest.minZoom)
      || !Number.isInteger(manifest.maxZoom) || manifest.minZoom < 0 || manifest.maxZoom > 22
      || manifest.maxZoom - manifest.minZoom < 0 || manifest.maxZoom - manifest.minZoom > 3
      || !Array.isArray(manifest.levels) || manifest.levels.length !== manifest.maxZoom - manifest.minZoom + 1) {
    throw new Error('Kartans metadata är ogiltiga.');
  }
  let count = 0;
  manifest.levels.forEach((level, index) => {
    if (level.z !== manifest.minZoom + index || ![level.minX, level.maxX, level.minY, level.maxY].every(Number.isInteger)
        || Math.min(level.minX, level.minY) < 0 || Math.max(level.maxX, level.maxY) >= 2 ** level.z
        || level.maxX < level.minX || level.maxY < level.minY) throw new Error('Kartans rutnät är ogiltigt.');
    count += (level.maxX - level.minX + 1) * (level.maxY - level.minY + 1);
  });
  if (count > MAX_MAP_TILES || !Array.isArray(manifest.bounds) || manifest.bounds.length !== 2
      || !manifest.bounds.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
        && Math.abs(p[0]) <= 85.051129 && Math.abs(p[1]) <= 180)
      || manifest.bounds[0][0] >= manifest.bounds[1][0] || manifest.bounds[0][1] >= manifest.bounds[1][1]) {
    throw new Error('Kartans utbredning eller antal bildrutor är ogiltigt.');
  }
  return manifest;
}

// Premultiplied-alpha bilinear sampling prevents dark fringes around nodata.
export function sampleBilinear(rgba, width, height, x, y, output, offset) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const u = Math.max(0, Math.min(width - 1, x - 0.5));
  const v = Math.max(0, Math.min(height - 1, y - 0.5));
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  let alpha = 0, red = 0, green = 0, blue = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const index = (Math.min(height - 1, y0 + j) * width + Math.min(width - 1, x0 + i)) * 4;
    const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) * rgba[index + 3];
    alpha += weight;
    red += rgba[index] * weight; green += rgba[index + 1] * weight; blue += rgba[index + 2] * weight;
  }
  if (alpha) {
    output[offset] = red / alpha; output[offset + 1] = green / alpha; output[offset + 2] = blue / alpha;
    output[offset + 3] = alpha;
  }
}
